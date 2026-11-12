import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type Capture,
  type ColorScheme,
  type Doc,
  designLink,
  findArtboard,
  touchesStructure,
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
   * for Finder's icons and the home screen's cards. Default: on macOS, and in the
   * desktop app anywhere, which renders in its own windows rather than a Chrome.
   */
  previews?: boolean;
  /** Keep each design's .ponzu/journal.ndjson, its history of every change. Default true. */
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
  /**
   * Where links to designs open: the Mac app, by ponzu.design/local, or this server's canvas in a
   * browser, at the origin the agent reached it at when there is one. Unset, as when `ponzu mcp`
   * runs the tools itself, there's nothing to open and no links.
   */
  opensIn?: "app" | { origin: string };
  /** This Mac's tailnet name, while Tailscale runs: links to the Mac app name it. */
  mac?: string;
  /** Each canvas's threads with an unsent reply, by the socket that said so. */
  private writers = new Map<object, { key: string; threads: Set<string> }>();
  private entries = new Map<string, Entry>();
  private opening = new Map<string, Promise<Entry>>();
  private focusListeners = new Set<(key: string, artboard: string) => void>();
  private captureListeners = new Set<(key: string, capture: Capture) => void>();
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

  canvases() {
    return this.designs().map(({ key, design }) => ({ key, canvas: design }));
  }

  get(key: string): Design | undefined {
    return this.entries.get(key)?.design;
  }

  /** What a canvas is writing in now: none, as when it closes, forgets it. */
  setWriting(canvas: object, key: string, threads: string[]): void {
    if (threads.length) this.writers.set(canvas, { key, threads: new Set(threads) });
    else this.writers.delete(canvas);
  }

  writing(key: string, thread: string): boolean {
    for (const w of this.writers.values()) if (w.key === key && w.threads.has(thread)) return true;
    return false;
  }

  focus(key: string, artboard: string): void {
    for (const l of this.focusListeners) l(key, artboard);
  }

  capture(key: string, capture: Capture): void {
    for (const l of this.captureListeners) l(key, capture);
  }

  link(key: string, opts: { artboard?: string; origin?: string } = {}): string | undefined {
    if (!this.opensIn) return undefined;
    if (this.opensIn === "app") return designLink(key, { artboard: opts.artboard, mac: this.mac });
    return designLink(key, { artboard: opts.artboard, origin: opts.origin ?? this.opensIn.origin });
  }

  onFocus(fn: (key: string, artboard: string) => void): () => void {
    this.focusListeners.add(fn);
    return () => this.focusListeners.delete(fn);
  }

  onCapture(fn: (key: string, capture: Capture) => void): () => void {
    this.captureListeners.add(fn);
    return () => this.captureListeners.delete(fn);
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

  async create(path: string, doc: Doc): Promise<{ key: string; canvas: Design }> {
    const key = this.keyOf(path);
    if (this.entries.has(key) || existsSync(join(key, "design.json")))
      throw new ToolError(`${key} already exists. Open it instead.`);
    await mkdir(key, { recursive: true });
    const design = await Design.create(new FsAdapter(key), doc);
    await design.close();
    const opened = await this.open(key);
    for (const l of this.createListeners) l(opened.key);
    return { key: opened.key, canvas: opened.design };
  }

  async resolve(file?: string): Promise<{ key: string; canvas: Design }> {
    const all = this.canvases();
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
    if (byKey) return { key: byKey.key, canvas: byKey.design };
    const lower = file.toLowerCase().replace(/\.design$/, "");
    const byName = all.filter(
      (d) =>
        d.canvas.doc.name.toLowerCase() === lower ||
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
      const opened = await this.open(file);
      return { key: opened.key, canvas: opened.design };
    }
    throw new ToolError(
      all.length > 5
        ? `No open file matches "${file}". ${all.length} are open; list_files lists them.`
        : `No open file matches "${file}". Open: ${all.map((d) => d.canvas.doc.name).join(", ") || "none"}`,
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

  intent(key: string, text: string, origin: { kind: "user" | "agent"; name: string }) {
    const journal = this.entries.get(this.keyOf(key))?.journal;
    if (!journal) return;
    const o = { ...origin, client: this.clientOf(origin) };
    journal.intent(text, o.client ? o : origin);
  }

  /** Everything this design's journal has been told is on disk. */
  async journalFlushed(key: string): Promise<void> {
    await this.entries.get(this.keyOf(key))?.journal?.flush();
  }

  /** The product of the agent behind an origin, kept with its changes in the journal. */
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
    return (
      Boolean(this.renderer) &&
      (this.opts.previews ?? (process.platform === "darwin" || process.env.PONZU_DESKTOP === "1"))
    );
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
      if (e.origin.kind === "disk" && e.artboards.length) {
        const gone = e.artboards.filter((id) => !findArtboard(design.doc, id));
        const artboards = e.artboards.filter((id) => !gone.includes(id));
        this.presence.wroteOnDisk(key, { artboards, gone });
      }
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
    const { origin } = e;
    if (origin.kind === "disk") {
      this.events.emit(key, { type: "file.changed", path: origin.name, artboards: e.artboards });
      return;
    }
    this.events.emitOp(key, doc, { op: e.op, origin, artboards: e.artboards });
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
