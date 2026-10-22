import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type ColorScheme,
  type Doc,
  findArtboard,
  locate,
  type Op,
  type Thread,
} from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import { Design, type OpEvent } from "@ponzu/store";
import { FsAdapter } from "@ponzu/store/fs";
import {
  EventHub,
  fileList,
  PresenceHub,
  type Telemetry,
  ToolError,
  type Workspace,
} from "@ponzu/tools";
import { JournalWriter } from "./journal.ts";
import { previewStale, writePreview } from "./preview.ts";

export interface WorkspaceOptions {
  /** Where relative paths resolve. Defaults to process.cwd(). */
  cwd?: string;
  renderer?: Renderer;
  telemetry?: Telemetry;
  /** Allow agents to open any .design path, not just the ones opened by the host. */
  openAnything?: boolean;
  /**
   * Keep each design's .ponzu/preview.png current while a renderer is available,
   * for Finder's icons. Default: on macOS.
   */
  previews?: boolean;
  /** Keep each design's .ponzu/journal.ndjson, the history timelapses are made from. Default true. */
  journal?: boolean;
}

/** How long the canvas has to sit still before the preview is redrawn. */
const PREVIEW_DELAY = 2000;

interface Entry {
  key: string;
  design: Design;
  stop: () => void;
  journal?: JournalWriter;
}

/**
 * The local host for a set of open .design folders. Turns store ops into
 * events, tracks presence, and implements the tool Workspace.
 */
export class LocalWorkspace implements Workspace {
  readonly events = new EventHub();
  readonly presence = new PresenceHub();
  renderer?: Renderer;
  telemetry?: Telemetry;
  /** The appearance of the canvas the person last had open. */
  theme?: ColorScheme;
  /** The server that serves designs' assets, once there is one, so renders can load them. */
  assetOrigin?: string;
  private entries = new Map<string, Entry>();
  private opening = new Map<string, Promise<Entry>>();
  private focusListeners = new Set<(key: string, artboard: string) => void>();
  private openListeners = new Set<(key: string) => void>();
  private createListeners = new Set<(key: string) => void>();
  private previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private previewing: Promise<unknown> = Promise.resolve();
  private cwd: string;

  constructor(private opts: WorkspaceOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.renderer = opts.renderer;
    this.telemetry = opts.telemetry;
  }

  designs() {
    return [...this.entries.values()].map(({ key, design }) => ({ key, design }));
  }

  get(key: string): Design | undefined {
    return this.entries.get(key)?.design;
  }

  focus(key: string, artboard: string): void {
    for (const l of this.focusListeners) l(key, artboard);
  }

  onFocus(fn: (key: string, artboard: string) => void): () => void {
    this.focusListeners.add(fn);
    return () => this.focusListeners.delete(fn);
  }

  onOpen(fn: (key: string) => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  /** A .design an agent (or anyone) just created through this workspace. */
  onCreate(fn: (key: string) => void): () => void {
    this.createListeners.add(fn);
    return () => this.createListeners.delete(fn);
  }

  /** Open a .design folder (idempotent). */
  async open(path: string): Promise<{ key: string; design: Design }> {
    const key = this.keyOf(path);
    const existing = this.entries.get(key);
    if (existing) return existing;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = (async () => {
        await mkdir(key, { recursive: true });
        const design = await Design.open(new FsAdapter(key));
        const entry: Entry = { key, design, stop: () => {} };
        const offBridge = this.bridge(key, design);
        let offJournal = () => {};
        if (this.opts.journal !== false) {
          entry.journal = new JournalWriter(key);
          offJournal = entry.journal.start(design, (o) => this.clientOf(o));
        }
        entry.stop = () => {
          offBridge();
          offJournal();
        };
        this.entries.set(key, entry);
        for (const l of this.openListeners) l(key);
        // In the background: the walk shouldn't hold up opening the file.
        if (this.previewsOn)
          void previewStale(key).then((stale) => {
            if (stale && this.entries.get(key) === entry) this.schedulePreview(key);
          });
        return entry;
      })();
      this.opening.set(key, pending);
      pending.finally(() => this.opening.delete(key));
    }
    const entry = await pending;
    return { key: entry.key, design: entry.design };
  }

  async create(path: string, doc: Doc): Promise<{ key: string; design: Design }> {
    const key = this.keyOf(path);
    if (this.entries.has(key) || existsSync(join(key, "design.json")))
      throw new ToolError(`${key} already exists. Open it instead.`);
    await mkdir(key, { recursive: true });
    const design = await Design.create(new FsAdapter(key), doc);
    await design.close();
    const opened = await this.open(key);
    for (const l of this.createListeners) l(opened.key);
    return opened;
  }

  async resolve(file?: string): Promise<{ key: string; design: Design }> {
    const all = this.designs();
    if (!file) {
      if (all.length === 1) return all[0]!;
      if (!all.length)
        throw new ToolError(
          "No .design is open. Use create_file, or pass file with a path to a .design folder.",
        );
      throw new ToolError(
        all.length > 5
          ? `${all.length} files are open; pass file (a path, or a name from list_files).`
          : `Several files are open; pass file. Open: ${fileList(all)}`,
        "file_ambiguous",
      );
    }
    const byKey = this.entries.get(this.keyOf(file));
    if (byKey) return byKey;
    const lower = file.toLowerCase().replace(/\.design$/, "");
    const byName = all.filter(
      (d) =>
        d.design.doc.name.toLowerCase() === lower ||
        basename(d.key)
          .toLowerCase()
          .replace(/\.design$/, "") === lower,
    );
    // Copies of one design (in worktrees, say) share a name: only a path tells them apart.
    if (byName.length > 1)
      throw new ToolError(
        `"${file}" matches ${byName.length} open files; pass the path: ${fileList(byName)}`,
        "file_name_ambiguous",
      );
    if (byName[0]) return byName[0];
    if (
      this.opts.openAnything !== false &&
      file.endsWith(".design") &&
      existsSync(join(this.keyOf(file), "design.json"))
    ) {
      return this.open(file);
    }
    throw new ToolError(
      all.length > 5
        ? `No open file matches "${file}". ${all.length} are open; list_files lists them.`
        : `No open file matches "${file}". Open: ${all.map((d) => d.design.doc.name).join(", ") || "none"}`,
      "file_not_found",
    );
  }

  async close(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    e.stop();
    clearTimeout(this.previewTimers.get(key));
    this.previewTimers.delete(key);
    await e.design.close();
    await e.journal?.close();
    this.entries.delete(key);
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.entries.keys()]) await this.close(key);
    await this.previewing;
    await this.renderer?.close();
  }

  /** Everything this design's journal has been told is on disk. */
  async journalFlushed(key: string): Promise<void> {
    await this.entries.get(this.keyOf(key))?.journal?.flush();
  }

  /** The product of the agent behind an origin, for its mark in a timelapse. */
  private clientOf(o: { kind: string; name: string }): string | undefined {
    if (o.kind !== "agent") return undefined;
    return this.presence.list().find((p) => p.kind === "agent" && p.name === o.name)?.client;
  }

  assetBase(key: string): string | undefined {
    return this.assetOrigin && `${this.assetOrigin}/files/${encodeURIComponent(key)}`;
  }

  private keyOf(path: string): string {
    const abs = isAbsolute(path) ? path : resolve(this.cwd, path);
    return abs.replace(/[\\/]+$/, "");
  }

  /**
   * Redraw the design's preview once edits settle. Renders run one at a time,
   * so a burst of edits across files doesn't open a window per file.
   */
  private get previewsOn(): boolean {
    return Boolean(this.renderer) && (this.opts.previews ?? process.platform === "darwin");
  }

  private schedulePreview(key: string): void {
    if (!this.previewsOn) return;
    clearTimeout(this.previewTimers.get(key));
    this.previewTimers.set(
      key,
      setTimeout(() => {
        this.previewTimers.delete(key);
        this.previewing = this.previewing.then(async () => {
          const design = this.get(key);
          if (!design || !this.renderer) return;
          try {
            await writePreview(key, design.doc, this.renderer, this.assetBase(key));
          } catch {
            // A preview is a nicety; the next edit tries again.
          }
        });
      }, PREVIEW_DELAY),
    );
  }

  /** Translate store ops into agent-facing events. */
  private bridge(key: string, design: Design): () => void {
    const offOp = design.onOp((e) => {
      this.emitFor(key, design.doc, e);
      if (e.artboards.length || touchesStructure(e.op)) this.schedulePreview(key);
    });
    const offReset = design.onReset(() => {
      this.events.emit(key, { type: "file.changed", path: key, artboards: [] });
      this.schedulePreview(key);
    });
    return () => {
      offOp();
      offReset();
    };
  }

  private emitFor(key: string, doc: Doc, e: OpEvent): void {
    const author = e.origin.name;
    if (e.origin.kind === "disk") {
      this.events.emit(key, { type: "file.changed", path: e.origin.name, artboards: e.artboards });
      return;
    }
    for (const t of threadEvents(e.op)) {
      if (t.kind === "created") {
        this.events.emit(key, {
          type: "comment.created",
          thread: t.thread.id,
          artboard: t.thread.artboardId,
          text: t.thread.messages[0]?.text ?? "",
          author,
        });
      } else if (t.kind === "message" || t.kind === "edited") {
        const th = doc.threads.find((x) => x.id === t.id);
        this.events.emit(key, {
          type: t.kind === "message" ? "comment.replied" : "comment.edited",
          thread: t.id,
          artboard: th?.artboardId,
          text: t.text,
          author,
        });
      } else {
        const th = doc.threads.find((x) => x.id === t.id);
        this.events.emit(key, {
          type: t.status === "resolved" ? "comment.resolved" : "comment.reopened",
          thread: t.id,
          artboard: th?.artboardId,
          author,
        });
      }
    }
    if (e.artboards.length || touchesStructure(e.op)) {
      this.events.emit(key, {
        type: "change",
        origin: e.origin,
        artboards: e.artboards,
        summary: summarize(doc, e.op),
      });
    }
  }
}

type ThreadEvent =
  | { kind: "created"; thread: Thread }
  | { kind: "message"; id: string; text: string }
  | { kind: "edited"; id: string; text: string }
  | { kind: "status"; id: string; status: Thread["status"] };

function threadEvents(op: Op): ThreadEvent[] {
  if (op.op === "batch") return op.ops.flatMap(threadEvents);
  if (op.op === "thread.create") return [{ kind: "created", thread: op.thread }];
  if (op.op === "thread.message") return [{ kind: "message", id: op.id, text: op.message.text }];
  if (op.op === "thread.edit") return [{ kind: "edited", id: op.id, text: op.text }];
  if (op.op === "thread.update" && op.status)
    return [{ kind: "status", id: op.id, status: op.status }];
  return [];
}

function touchesStructure(op: Op): boolean {
  if (op.op === "batch") return op.ops.some(touchesStructure);
  return op.op.startsWith("page.") || op.op === "tokens" || op.op === "file.rename";
}

export function summarize(doc: Doc, op: Op): string {
  if (op.op === "batch") {
    const parts = [...new Set(op.ops.map((o) => summarize(doc, o)))];
    return parts.length > 3 ? `${parts.slice(0, 3).join("; ")}; …` : parts.join("; ");
  }
  const name = (id: string) => {
    const ab = findArtboard(doc, id);
    if (ab) return `"${ab.artboard.name}"`;
    const hit = locate(doc, id);
    return hit?.node.name ? `"${hit.node.name}"` : id;
  };
  switch (op.op) {
    case "insert":
      return `added to ${name(op.parent)}`;
    case "remove":
      return `removed ${op.id}`;
    case "move":
      return `moved ${name(op.id)}`;
    case "style":
      return `restyled ${name(op.id)}`;
    case "attrs":
      return `changed attributes on ${name(op.id)}`;
    case "name":
      return `renamed ${op.id}`;
    case "children":
      return `rewrote ${name(op.id)}`;
    case "artboard.create":
      return `created artboard "${op.artboard.name}"`;
    case "artboard.delete":
      return `deleted artboard ${op.id}`;
    case "artboard.update":
      return `updated artboard ${name(op.id)}`;
    case "artboard.move":
      return `moved artboard ${name(op.id)} to another page`;
    case "page.create":
      return `created page "${op.page.name}"`;
    case "page.delete":
      return "deleted a page";
    case "page.update":
      return "updated a page";
    case "page.order":
      return "reordered pages";
    case "tokens":
      return "changed tokens";
    case "file.rename":
      return `renamed the file to "${op.name}"`;
    case "file.icon":
      return "changed the file's icon";
    case "file.scratch":
      return op.scratch ? "marked the file as scratch" : "took the file out of scratch";
    case "note":
      return `${op.content === null ? "deleted" : "wrote"} note ${op.name}`;
    default:
      return op.op;
  }
}

/** Find .design folders under a directory (one level, plus one nested). */
export async function findDesigns(dir: string): Promise<string[]> {
  const out: string[] = [];
  const scan = async (d: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.name.endsWith(".design")) out.push(p);
      else if (depth > 0) await scan(p, depth - 1);
    }
  };
  await scan(dir, 2);
  return out.sort();
}
