import {
  type Artboard,
  applyOp,
  type Doc,
  findArtboard,
  type Op,
  OpError,
  type Origin,
  opScopes,
  touchedArtboards,
} from "@ponzu/core";
import type { StorageAdapter } from "./adapter.ts";
import {
  type Layout,
  planLayout,
  readBag,
  serializeArtboard,
  serializeMeta,
  serializeThreads,
  writeBag,
} from "./format.ts";

export interface OpEvent {
  seq: number;
  op: Op;
  inverse: Op;
  origin: Origin;
  artboards: string[];
}

type Listener<T> = (value: T) => void;

export interface DesignOptions {
  /** Name to use when design.json is missing. Defaults to the folder name. */
  name?: string;
  /** Milliseconds to wait before writing. */
  saveDelay?: number;
  /** Follow outside edits. Defaults to true when the adapter can watch. */
  watch?: boolean;
}

interface HistoryEntry {
  forward: Op;
  inverse: Op;
}

const HISTORY_LIMIT = 200;

/**
 * An open .design: the in-memory doc, its undo history, and the bridge to
 * storage in both directions. Every change, from a tool, the studio or a
 * text editor, goes through `apply` and comes out as an op event.
 */
export class Design {
  doc: Doc;
  seq = 0;
  private layout: Layout;
  private written = new Map<string, string>();
  private dirtyArtboards = new Set<string>();
  private dirtyScopes = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private opListeners = new Set<Listener<OpEvent>>();
  private resetListeners = new Set<Listener<Doc>>();
  private stopWatching: (() => void) | null = null;
  private closed = false;

  private constructor(
    readonly storage: StorageAdapter,
    doc: Doc,
    layout: Layout,
    private opts: Required<Pick<DesignOptions, "saveDelay">>,
  ) {
    this.doc = doc;
    this.layout = layout;
  }

  static async open(storage: StorageAdapter, opts: DesignOptions = {}): Promise<Design> {
    const name = opts.name ?? nameFromRoot(storage.root) ?? "Untitled";
    const bag = await storage.readAll();
    const { doc, layout } = readBag(bag, name);
    const design = new Design(storage, doc, layout, { saveDelay: opts.saveDelay ?? 120 });
    for (const [path, content] of Object.entries(bag)) design.written.set(path, content);
    if (!bag["design.json"]) {
      design.dirtyScopes.add("meta");
      design.scheduleSave();
    }
    if (opts.watch !== false && storage.watch) {
      design.stopWatching = storage.watch((paths) => void design.onOutsideChange(paths));
    }
    return design;
  }

  /** Create a new .design with the given content and write it out. */
  static async create(
    storage: StorageAdapter,
    doc: Doc,
    opts: DesignOptions = {},
  ): Promise<Design> {
    const layout = planLayout(doc, { pages: new Map(), artboards: new Map() });
    const bag = writeBag(doc, layout);
    for (const [path, content] of Object.entries(bag)) await storage.write(path, content);
    return Design.open(storage, opts);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onOp(fn: Listener<OpEvent>): () => void {
    this.opListeners.add(fn);
    return () => this.opListeners.delete(fn);
  }

  onReset(fn: Listener<Doc>): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  /** Apply an op. Throws OpError and changes nothing if it doesn't fit. */
  apply(op: Op, origin: Origin, opts: { history?: boolean } = {}): OpEvent {
    const before = touchedArtboards(this.doc, op);
    const inverse = applyOp(this.doc, op);
    if (opts.history !== false) {
      this.undoStack.push({ forward: op, inverse });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    return this.afterApply(op, inverse, origin, before);
  }

  undo(origin: Origin): OpEvent | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    try {
      const before = touchedArtboards(this.doc, entry.inverse);
      const forward = applyOp(this.doc, entry.inverse);
      this.redoStack.push({ forward: entry.forward, inverse: entry.inverse });
      void forward;
      return this.afterApply(entry.inverse, entry.forward, origin, before);
    } catch (err) {
      // Something changed underneath (an outside edit). Drop this step.
      if (err instanceof OpError) return this.undo(origin);
      throw err;
    }
  }

  redo(origin: Origin): OpEvent | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    try {
      const before = touchedArtboards(this.doc, entry.forward);
      const inverse = applyOp(this.doc, entry.forward);
      this.undoStack.push({ forward: entry.forward, inverse });
      return this.afterApply(entry.forward, inverse, origin, before);
    } catch (err) {
      if (err instanceof OpError) return null;
      throw err;
    }
  }

  private afterApply(op: Op, inverse: Op, origin: Origin, before: string[]): OpEvent {
    const artboards = [
      ...new Set([
        ...before,
        ...touchedArtboards(this.doc, op),
        ...touchedArtboards(this.doc, inverse),
      ]),
    ];
    if (origin.kind !== "disk") {
      for (const id of artboards) this.dirtyArtboards.add(id);
      for (const s of opScopes(op)) this.dirtyScopes.add(s);
      // A comment pinned to a node needs that node's id on disk right away.
      for (const id of pinnedArtboards(op)) this.dirtyArtboards.add(id);
      this.scheduleSave();
    }
    const event: OpEvent = { seq: ++this.seq, op, inverse, origin, artboards };
    for (const l of this.opListeners) l(event);
    return event;
  }

  private scheduleSave(): void {
    if (this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving
        .then(() => this.save())
        .catch((err) => console.error("[ponzu] save failed:", err));
    }, this.opts.saveDelay);
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.save());
    }
    await this.saving;
  }

  private async save(): Promise<void> {
    const next = planLayout(this.doc, this.layout);
    const writes = new Map<string, string>();
    const scopes = this.dirtyScopes;
    const dirty = this.dirtyArtboards;
    this.dirtyScopes = new Set();
    this.dirtyArtboards = new Set();

    const layoutChanged =
      !sameMap(this.layout.artboards, next.artboards) || !sameMap(this.layout.pages, next.pages);
    if (scopes.has("meta") || layoutChanged) writes.set("design.json", serializeMeta(this.doc));
    if (scopes.has("tokens")) writes.set("tokens.css", this.doc.tokens);
    if (scopes.has("threads")) writes.set("comments.json", serializeThreads(this.doc));
    if (scopes.has("notes"))
      for (const [name, content] of Object.entries(this.doc.notes))
        writes.set(`notes/${name}.md`, content);

    for (const page of this.doc.pages) {
      for (const ab of page.artboards) {
        const path = next.artboards.get(ab.id)!;
        if (dirty.has(ab.id) || this.layout.artboards.get(ab.id) !== path)
          writes.set(path, serializeArtboard(ab));
      }
    }

    const keep = new Set(next.artboards.values());
    const removals: string[] = [];
    for (const path of this.layout.artboards.values()) if (!keep.has(path)) removals.push(path);
    if (scopes.has("notes")) {
      for (const path of this.written.keys()) {
        const m = /^notes\/(.+)\.md$/.exec(path);
        if (m && !(m[1]! in this.doc.notes)) removals.push(path);
      }
    }

    this.layout = next;
    for (const [path, content] of writes) {
      if (this.written.get(path) === content) continue;
      this.written.set(path, content);
      await this.storage.write(path, content);
    }
    for (const path of removals) {
      if (writes.has(path)) continue;
      this.written.delete(path);
      await this.storage.remove(path);
    }
  }

  /** Where an artboard is stored, relative to the design root. */
  pathOf(artboardId: string): string | undefined {
    return (
      this.layout.artboards.get(artboardId) ??
      planLayout(this.doc, this.layout).artboards.get(artboardId)
    );
  }

  private async onOutsideChange(paths: string[]): Promise<void> {
    if (this.closed) return;
    const relevant = paths.filter((p) => !p.startsWith("assets/"));
    if (!relevant.length) return;
    await this.saving;
    const bag = await this.storage.readAll();
    // Ignore echoes of our own writes.
    let changed = false;
    const known = new Set([...Object.keys(bag), ...this.written.keys()]);
    for (const path of known) {
      if (bag[path] !== this.written.get(path)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const { doc: incoming, layout } = readBag(bag, this.doc.name);
    this.written = new Map(Object.entries(bag));
    const ops = diffDocs(this.doc, incoming);
    this.layout = layout;
    if (!ops.length) return;
    const origin: Origin = { kind: "disk", name: relevant[0]! };
    try {
      this.apply({ op: "batch", ops }, origin, { history: false });
    } catch {
      this.doc = incoming;
      this.undoStack = [];
      this.redoStack = [];
      for (const l of this.resetListeners) l(this.doc);
    }
  }

  async close(): Promise<void> {
    this.stopWatching?.();
    await this.flush();
    this.closed = true;
  }
}

function pinnedArtboards(op: Op): string[] {
  if (op.op === "batch") return op.ops.flatMap(pinnedArtboards);
  if (op.op === "thread.create" && op.thread.nodeId && op.thread.artboardId)
    return [op.thread.artboardId];
  return [];
}

function nameFromRoot(root?: string): string | undefined {
  if (!root) return undefined;
  const base =
    root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return base.replace(/\.design$/, "") || undefined;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Ops that turn `cur` into `next`, at artboard granularity. */
export function diffDocs(cur: Doc, next: Doc): Op[] {
  const ops: Op[] = [];
  if (cur.name !== next.name) ops.push({ op: "file.rename", name: next.name });
  if (cur.tokens !== next.tokens) ops.push({ op: "tokens", css: next.tokens });

  for (const name of new Set([...Object.keys(cur.notes), ...Object.keys(next.notes)])) {
    if (cur.notes[name] !== next.notes[name])
      ops.push({ op: "note", name, content: next.notes[name] ?? null });
  }

  const curThreads = new Map(cur.threads.map((t) => [t.id, JSON.stringify(t)]));
  const nextThreads = new Map(next.threads.map((t) => [t.id, t]));
  for (const id of curThreads.keys()) {
    const t = nextThreads.get(id);
    if (!t || JSON.stringify(t) !== curThreads.get(id)) ops.push({ op: "thread.delete", id });
  }
  for (const t of next.threads) {
    if (curThreads.get(t.id) !== JSON.stringify(t)) ops.push({ op: "thread.create", thread: t });
  }

  // Pages that are new.
  const curPages = new Map(cur.pages.map((p) => [p.id, p]));
  next.pages.forEach((p, index) => {
    if (!curPages.has(p.id)) {
      const { artboards: _a, ...meta } = p;
      ops.push({ op: "page.create", index, page: meta });
    }
  });

  // Artboards: removed, changed, added, moved between pages.
  const nextArtboards = new Map<string, { page: string; artboard: Artboard; index: number }>();
  for (const p of next.pages)
    p.artboards.forEach((a, index) => nextArtboards.set(a.id, { page: p.id, artboard: a, index }));
  for (const p of cur.pages) {
    for (const a of p.artboards)
      if (!nextArtboards.has(a.id)) ops.push({ op: "artboard.delete", id: a.id });
  }
  for (const [id, n] of nextArtboards) {
    const hit = findArtboard(cur, id);
    if (!hit) {
      ops.push({ op: "artboard.create", page: n.page, index: n.index, artboard: n.artboard });
      continue;
    }
    if (hit.page.id !== n.page) ops.push({ op: "artboard.move", id, page: n.page, index: n.index });
    const a = hit.artboard;
    const b = n.artboard;
    if (a.x !== b.x || a.y !== b.y || a.name !== b.name)
      ops.push({ op: "artboard.update", id, x: b.x, y: b.y, name: b.name });
    if (JSON.stringify(a.root.style) !== JSON.stringify(b.root.style))
      ops.push({ op: "style", id, style: b.root.style });
    if (JSON.stringify(a.root.attrs) !== JSON.stringify(b.root.attrs))
      ops.push({ op: "attrs", id, attrs: b.root.attrs });
    if (JSON.stringify(a.root.children) !== JSON.stringify(b.root.children))
      ops.push({ op: "children", id, children: b.root.children });
  }

  // Pages that went away, then names and order.
  const nextPages = new Map(next.pages.map((p) => [p.id, p]));
  for (const p of cur.pages) if (!nextPages.has(p.id)) ops.push({ op: "page.delete", id: p.id });
  for (const p of next.pages) {
    const c = curPages.get(p.id);
    if (c && (c.name !== p.name || (c.icon ?? null) !== (p.icon ?? null))) {
      ops.push({ op: "page.update", id: p.id, name: p.name, icon: p.icon ?? null });
    }
  }
  const order = next.pages.map((p) => p.id);
  const after = [
    ...cur.pages.map((p) => p.id).filter((id) => nextPages.has(id)),
    ...order.filter((id) => !curPages.has(id)),
  ];
  if (after.join() !== order.join()) ops.push({ op: "page.order", ids: order });
  return ops;
}
