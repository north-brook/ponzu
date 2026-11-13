import { findNode, isAncestor } from "./tree.ts";
import type { Artboard, DesignMeta, Message, PageMeta, PElement, PNode, Thread } from "./types.ts";

/**
 * A whole .design in memory. Plain data, so it can be cloned, sent over a
 * socket and mirrored in the browser with the same `applyOp`.
 */
export interface Doc {
  name: string;
  icon?: string;
  /** From design.json: a sample design the home screen hides until it's opened. */
  example?: true;
  /** An agent made it for its own use: the home screen keeps it archived, not in Recent. */
  scratch?: true;
  pages: PageState[];
  tokens: string;
  threads: Thread[];
  notes: Record<string, string>;
}

export interface PageState extends PageMeta {
  artboards: Artboard[];
}

export type Op =
  | { op: "insert"; parent: string; index: number; nodes: PNode[] }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; parent: string; index: number }
  | { op: "style"; id: string; style: Record<string, string> }
  | { op: "attrs"; id: string; attrs: Record<string, string> }
  | { op: "name"; id: string; name: string | null }
  | { op: "children"; id: string; children: PNode[] }
  | { op: "artboard.create"; page: string; index: number; artboard: Artboard }
  | { op: "artboard.delete"; id: string }
  | { op: "artboard.update"; id: string; x?: number; y?: number; name?: string }
  | { op: "artboard.move"; id: string; page: string; index: number }
  | { op: "page.create"; index: number; page: PageMeta }
  | { op: "page.delete"; id: string }
  | { op: "page.update"; id: string; name?: string; icon?: string | null }
  | { op: "page.order"; ids: string[] }
  /** Move one page to `index` in the list, read against the list as it is when it lands. */
  | { op: "page.move"; id: string; index: number }
  | { op: "file.rename"; name: string }
  | { op: "file.icon"; icon: string | null }
  | { op: "file.scratch"; scratch: boolean }
  | { op: "tokens"; css: string }
  | { op: "thread.create"; thread: Thread }
  | { op: "thread.delete"; id: string }
  | {
      op: "thread.update";
      id: string;
      status?: Thread["status"];
      nodeId?: string | null;
      /** The pin's place in its node; null for a pin that isn't on one. */
      offset?: { x: number; y: number } | null;
      x?: number;
      y?: number;
      /** null moves the pin off its artboard, onto the ground of `pageId`. */
      artboardId?: string | null;
      pageId?: string | null;
      /**
       * When the change was made, which becomes the thread's `updatedAt`. Whoever builds the op
       * sets it, since `applyOp` never reads the clock; without one the thread's time stays.
       */
      updatedAt?: number;
    }
  | { op: "thread.message"; id: string; message: Message }
  | { op: "thread.unmessage"; id: string; messageId: string }
  /** Replace a message's text. `editedAt: null` clears the mark, for undo. */
  | { op: "thread.edit"; id: string; messageId: string; text: string; editedAt: number | null }
  | { op: "note"; name: string; content: string | null }
  | { op: "batch"; ops: Op[] };

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

export function emptyDoc(name: string): Doc {
  return { name, pages: [], tokens: ":root {\n}\n", threads: [], notes: {} };
}

export function metaOf(doc: Doc): DesignMeta {
  return {
    ponzu: 1,
    name: doc.name,
    ...(doc.icon ? { icon: doc.icon } : {}),
    ...(doc.example ? { example: true as const } : {}),
    ...(doc.scratch ? { scratch: true as const } : {}),
    pages: doc.pages.map(({ id, name, icon }) => (icon ? { id, name, icon } : { id, name })),
  };
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export interface NodeLocation {
  page: PageState;
  artboard: Artboard;
  node: PElement;
  parent: PElement | null;
  index: number;
  depth: number;
}

export function locate(doc: Doc, id: string): NodeLocation | null {
  for (const page of doc.pages) {
    for (const artboard of page.artboards) {
      const hit = findNode(artboard.root, id);
      if (hit) return { page, artboard, ...hit };
    }
  }
  return null;
}

export function mustLocate(doc: Doc, id: string): NodeLocation {
  const hit = locate(doc, id);
  if (!hit) throw new OpError(`No node with id ${id}. Ids come from get_tree or tool results.`);
  return hit;
}

export function findArtboard(
  doc: Doc,
  id: string,
): { page: PageState; artboard: Artboard; index: number } | null {
  for (const page of doc.pages) {
    const index = page.artboards.findIndex((a) => a.id === id);
    if (index >= 0) return { page, artboard: page.artboards[index]!, index };
  }
  return null;
}

/** The page a comment thread's pin is on. */
export function threadPage(doc: Doc, thread: Thread): PageState | null {
  if (thread.artboardId) return findArtboard(doc, thread.artboardId)?.page ?? null;
  return doc.pages.find((p) => p.id === thread.pageId) ?? null;
}

/** A node's box in its artboard's pixels. */
export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a pin on a node sits in its artboard's pixels, with the node's box as it is now. One with
 * an `offset` keeps its place in the node, so it follows the node wherever it goes; an older one
 * stays at its x, y, kept within the box. Either way it stays on the node.
 */
export function pinOnNode(
  pin: { x: number; y: number; offset?: { x: number; y: number } },
  box: NodeRect,
): { x: number; y: number } {
  const within = (v: number, from: number, length: number) =>
    Math.min(Math.max(v, from), from + length);
  const x = pin.offset ? box.x + pin.offset.x : pin.x;
  const y = pin.offset ? box.y + pin.offset.y : pin.y;
  return { x: within(x, box.x, box.w), y: within(y, box.y, box.h) };
}

/** A pin's place in a node's box, for a pin at x, y on the node's artboard. */
export function nodeOffset(x: number, y: number, box: NodeRect): { x: number; y: number } {
  return { x: Math.round(x - box.x), y: Math.round(y - box.y) };
}

export function findPage(doc: Doc, idOrName: string): PageState | null {
  return (
    doc.pages.find((p) => p.id === idOrName) ??
    doc.pages.find((p) => p.name.toLowerCase() === idOrName.toLowerCase()) ??
    null
  );
}

/**
 * The op as every client can replay it: a `page.move` becomes the
 * `page.order` it amounts to against `doc` now. Phones run their own release
 * of `applyOp`, and one from before `page.move` would skip it.
 */
export function resolveOp(doc: Doc, op: Op): Op {
  return resolveIn(
    doc.pages.map((p) => p.id),
    op,
  );
}

/** `resolveOp` against the page list `ids`, which it keeps up with the op. */
function resolveIn(ids: string[], op: Op): Op {
  switch (op.op) {
    case "batch":
      return { op: "batch", ops: op.ops.map((o) => resolveIn(ids, o)) };
    case "page.move": {
      const from = ids.indexOf(op.id);
      if (from < 0) throw new OpError(`No page ${op.id}.`);
      ids.splice(from, 1);
      ids.splice(clamp(op.index, 0, ids.length), 0, op.id);
      return { op: "page.order", ids: ids.slice() };
    }
    case "page.create":
      ids.splice(clamp(op.index, 0, ids.length), 0, op.page.id);
      return op;
    case "page.delete": {
      const at = ids.indexOf(op.id);
      if (at >= 0) ids.splice(at, 1);
      return op;
    }
    case "page.order":
      ids.splice(0, ids.length, ...op.ids);
      return op;
    default:
      return op;
  }
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply an op to the doc in place and return the op that undoes it.
 * Throws OpError (leaving the doc unchanged) when the op doesn't fit.
 *
 * The result depends on the doc and the op alone: no clock, no randomness. Every replica
 * applies the same ops in the same order, so anything else would make them disagree.
 */
export function applyOp(doc: Doc, op: Op): Op {
  return apply(doc, op, null);
}

/**
 * `applyOp` without changing `doc`: the document with the op in, and the op that undoes it.
 * Only what the op changes is new, along with the path down to it (the pages list and the page,
 * the board and the nodes above a changed node, the threads list and the thread): every page,
 * board, node, thread and message the op leaves alone is the very same object in both. So a
 * comment leaves every board as it was, and a style change on one node leaves the other boards
 * and the rest of its own board as they were, which is what lets whoever draws them skip them.
 *
 * Throws OpError, as `applyOp` does, when the op doesn't fit; `doc` is untouched either way.
 * Neither document may be changed in place afterwards: they share their parts.
 */
export function withOp(doc: Doc, op: Op): { doc: Doc; inverse: Op } {
  const draft = new Draft(doc);
  const inverse = draft.apply(op);
  return { doc: draft.doc, inverse };
}

/**
 * A copy of a document that copies its parts only on the way to changing them. Before each op
 * it copies everything `apply` will change for that op, so `apply` changes only copies.
 */
class Draft {
  readonly doc: Doc;
  /** The copies made here, which `apply` may change. */
  private readonly own = new WeakSet<object>();

  constructor(base: Doc) {
    this.doc = this.copy(base);
  }

  apply(op: Op): Op {
    // A batch that fails partway leaves the draft half changed, and the draft is dropped.
    if (op.op === "batch") {
      const inverses = op.ops.map((child) => this.apply(child));
      return { op: "batch", ops: inverses.reverse() };
    }
    this.prepare(op);
    return apply(this.doc, op, null);
  }

  /** Copy whatever `apply` changes for `op`, found the way `apply` finds it. */
  private prepare(op: Exclude<Op, { op: "batch" }>): void {
    const pageAt = (id: string) => this.doc.pages.findIndex((p) => p.id === id);
    switch (op.op) {
      case "insert":
        this.node(op.parent);
        break;
      case "remove":
      case "style":
      case "attrs":
      case "name":
      case "children":
        this.node(op.id);
        break;
      case "move":
        this.node(op.id);
        this.node(op.parent);
        break;
      case "artboard.create":
        this.artboards(pageAt(op.page));
        break;
      case "artboard.delete":
        this.artboards(this.pageOf(op.id));
        break;
      case "artboard.update": {
        const artboard = this.artboard(op.id);
        if (artboard) this.field(artboard, "root");
        break;
      }
      case "artboard.move":
        this.artboards(this.pageOf(op.id));
        this.artboards(pageAt(op.page));
        break;
      case "page.create":
      case "page.delete":
      case "page.move":
        this.field(this.doc, "pages");
        break;
      case "page.update":
        this.page(pageAt(op.id));
        break;
      case "page.order":
      case "file.rename":
      case "file.icon":
      case "file.scratch":
      case "tokens":
        // Only the document's own fields, and the document is a copy.
        break;
      case "thread.create":
      case "thread.delete":
        this.field(this.doc, "threads");
        break;
      case "thread.update":
        this.thread(op.id);
        break;
      case "thread.message":
      case "thread.unmessage": {
        const thread = this.thread(op.id);
        if (thread) this.field(thread, "messages");
        break;
      }
      case "thread.edit": {
        const thread = this.thread(op.id);
        if (!thread) break;
        const messages = this.field(thread, "messages");
        const at = messages.findIndex((m) => m.id === op.messageId);
        if (at >= 0) this.item(messages, at);
        break;
      }
      case "note":
        this.field(this.doc, "notes");
        break;
      default: {
        // A new kind of op has to say here what it changes, or it would change a shared part.
        const unknown: never = op;
        throw new OpError(`Unknown op ${(unknown as { op: string }).op}.`);
      }
    }
  }

  /** The index of the page `findArtboard` finds board `id` on, or -1. */
  private pageOf(id: string): number {
    return this.doc.pages.findIndex((p) => p.artboards.some((a) => a.id === id));
  }

  /** The page at `index` copied, with its list of boards. Nothing for -1. */
  private artboards(index: number): void {
    const page = this.page(index);
    if (page) this.field(page, "artboards");
  }

  private page(index: number): PageState | undefined {
    if (index < 0) return undefined;
    return this.item(this.field(this.doc, "pages"), index);
  }

  /** The board `findArtboard` finds for `id`, copied along with its page's list of boards. */
  private artboard(id: string): Artboard | undefined {
    const p = this.pageOf(id);
    if (p < 0) return undefined;
    this.artboards(p);
    const boards = this.doc.pages[p]!.artboards;
    return this.item(
      boards,
      boards.findIndex((a) => a.id === id),
    );
  }

  /**
   * The node `locate` finds for `id` copied, with its children's list and every node above it
   * up to its board. Nothing when there is none: `apply` will say so.
   */
  private node(id: string): void {
    const pages = this.doc.pages;
    for (let p = 0; p < pages.length; p++) {
      const boards = pages[p]!.artboards;
      for (let b = 0; b < boards.length; b++) {
        const path = nodePath(boards[b]!.root, id);
        if (!path) continue;
        this.artboards(p);
        const board = this.item(this.doc.pages[p]!.artboards, b);
        let node = this.field(board, "root");
        this.field(node, "children");
        for (const index of path) {
          node = this.item(node.children, index) as PElement;
          this.field(node, "children");
        }
        return;
      }
    }
  }

  /** The thread with `id` copied, with the list of threads. */
  private thread(id: string): Thread | undefined {
    const at = this.doc.threads.findIndex((t) => t.id === id);
    if (at < 0) return undefined;
    return this.item(this.field(this.doc, "threads"), at);
  }

  /** `parent[key]`, a copy made here: `parent` has to be one too. */
  private field<T extends object, K extends keyof T>(parent: T, key: K): T[K] & object {
    const value = parent[key] as T[K] & object;
    if (this.own.has(value)) return value;
    const copy = this.copy(value);
    parent[key] = copy;
    return copy;
  }

  /** `list[index]`, a copy made here: `list` has to be one too. */
  private item<T extends object>(list: T[], index: number): T {
    const value = list[index]!;
    if (this.own.has(value)) return value;
    const copy = this.copy(value);
    list[index] = copy;
    return copy;
  }

  /** One level: the same keys in the same order, or the same items. */
  private copy<T extends object>(value: T): T {
    const copy = (Array.isArray(value) ? value.slice() : { ...value }) as T;
    this.own.add(copy);
    return copy;
  }
}

/**
 * The child indexes from `root` down to the node `findNode` finds for `id`: none for the root
 * itself, null when it isn't there. It searches in `findNode`'s order, so a canvas that holds
 * an id twice gets the path to the same one `apply` will change.
 */
function nodePath(root: PElement, id: string): number[] | null {
  if (root.id === id) return [];
  const stack: { el: PElement; path: number[] }[] = [{ el: root, path: [] }];
  while (stack.length) {
    const { el, path } = stack.pop()!;
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i]!;
      if (c.kind !== "el") continue;
      if (c.id === id) return [...path, i];
      stack.push({ el: c, path: [...path, i] });
    }
  }
  return null;
}

/**
 * What puts back, exactly, everything a batch has changed so far. A batch that fails partway
 * must leave the doc as it found it, and the inverse ops can't promise that: they find nodes
 * by id, which a canvas may hold twice, and a deleted thread comes back at the end of the list.
 */
type Undo = (() => void)[];

/** `applyOp`. Inside a batch, each op first adds to `undo` what restores what it will change. */
function apply(doc: Doc, op: Op, undo: Undo | null): Op {
  switch (op.op) {
    case "insert": {
      const { node: parent } = mustLocate(doc, op.parent);
      for (const n of op.nodes)
        if (n.kind === "el" && locate(doc, n.id))
          throw new OpError(`Id ${n.id} is already in use.`);
      const index = clamp(op.index, 0, parent.children.length);
      undo?.push(keep(parent.children));
      parent.children.splice(index, 0, ...structuredClone(op.nodes));
      if (op.nodes.length === 1 && op.nodes[0]!.kind === "el")
        return { op: "remove", id: op.nodes[0]!.id };
      return {
        op: "children",
        id: parent.id,
        children: removedSnapshot(parent, index, op.nodes.length),
      };
    }
    case "remove": {
      const hit = mustLocate(doc, op.id);
      if (!hit.parent) throw new OpError("Use delete_artboard to remove an artboard.");
      undo?.push(keep(hit.parent.children));
      hit.parent.children.splice(hit.index, 1);
      return { op: "insert", parent: hit.parent.id, index: hit.index, nodes: [hit.node] };
    }
    case "move": {
      const hit = mustLocate(doc, op.id);
      if (!hit.parent) throw new OpError("Artboards move with move_artboard.");
      if (op.parent === op.id || isAncestor(hit.artboard.root, op.id, op.parent)) {
        throw new OpError("Can't move a node into itself.");
      }
      const target = mustLocate(doc, op.parent).node;
      const before = { parent: hit.parent.id, index: hit.index };
      undo?.push(keep(hit.parent.children), keep(target.children));
      hit.parent.children.splice(hit.index, 1);
      target.children.splice(clamp(op.index, 0, target.children.length), 0, hit.node);
      return { op: "move", id: op.id, ...before };
    }
    case "style": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.style;
      undo?.push(keep(node));
      node.style = { ...op.style };
      return { op: "style", id: op.id, style: prev };
    }
    case "attrs": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.attrs;
      undo?.push(keep(node));
      node.attrs = { ...op.attrs };
      return { op: "attrs", id: op.id, attrs: prev };
    }
    case "name": {
      const hit = mustLocate(doc, op.id);
      const prev = hit.node.name ?? null;
      undo?.push(keep(hit.node), keep(hit.artboard));
      if (op.name === null) delete hit.node.name;
      else hit.node.name = op.name;
      if (!hit.parent && op.name !== null) hit.artboard.name = op.name;
      return { op: "name", id: op.id, name: prev };
    }
    case "children": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.children;
      undo?.push(keep(node));
      node.children = structuredClone(op.children);
      return { op: "children", id: op.id, children: prev };
    }
    case "artboard.create": {
      const page = mustPage(doc, op.page);
      if (findArtboard(doc, op.artboard.id))
        throw new OpError(`Artboard ${op.artboard.id} already exists.`);
      undo?.push(keep(page.artboards));
      page.artboards.splice(
        clamp(op.index, 0, page.artboards.length),
        0,
        structuredClone(op.artboard),
      );
      return { op: "artboard.delete", id: op.artboard.id };
    }
    case "artboard.delete": {
      const hit = mustArtboard(doc, op.id);
      undo?.push(keep(hit.page.artboards));
      hit.page.artboards.splice(hit.index, 1);
      return { op: "artboard.create", page: hit.page.id, index: hit.index, artboard: hit.artboard };
    }
    case "artboard.update": {
      const { artboard } = mustArtboard(doc, op.id);
      const inverse: Op = { op: "artboard.update", id: op.id };
      undo?.push(keep(artboard), keep(artboard.root));
      if (op.x !== undefined) {
        inverse.x = artboard.x;
        artboard.x = op.x;
      }
      if (op.y !== undefined) {
        inverse.y = artboard.y;
        artboard.y = op.y;
      }
      if (op.name !== undefined) {
        inverse.name = artboard.name;
        artboard.name = op.name;
        artboard.root.name = op.name;
      }
      return inverse;
    }
    case "artboard.move": {
      const hit = mustArtboard(doc, op.id);
      const target = mustPage(doc, op.page);
      undo?.push(keep(hit.page.artboards), keep(target.artboards));
      hit.page.artboards.splice(hit.index, 1);
      target.artboards.splice(clamp(op.index, 0, target.artboards.length), 0, hit.artboard);
      return { op: "artboard.move", id: op.id, page: hit.page.id, index: hit.index };
    }
    case "page.create": {
      if (doc.pages.some((p) => p.id === op.page.id))
        throw new OpError(`Page ${op.page.id} already exists.`);
      undo?.push(keep(doc.pages));
      doc.pages.splice(clamp(op.index, 0, doc.pages.length), 0, { ...op.page, artboards: [] });
      return { op: "page.delete", id: op.page.id };
    }
    case "page.delete": {
      const index = doc.pages.findIndex((p) => p.id === op.id);
      if (index < 0) throw new OpError(`No page ${op.id}.`);
      const page = doc.pages[index]!;
      undo?.push(keep(doc.pages));
      doc.pages.splice(index, 1);
      const { artboards, ...meta } = page;
      const restore: Op[] = [{ op: "page.create", index, page: meta }];
      artboards.forEach((artboard, i) =>
        restore.push({ op: "artboard.create", page: page.id, index: i, artboard }),
      );
      return restore.length === 1 ? restore[0]! : { op: "batch", ops: restore };
    }
    case "page.update": {
      const page = mustPage(doc, op.id);
      const inverse: Op = { op: "page.update", id: op.id };
      undo?.push(keep(page));
      if (op.name !== undefined) {
        inverse.name = page.name;
        page.name = op.name;
      }
      if (op.icon !== undefined) {
        inverse.icon = page.icon ?? null;
        if (op.icon === null) delete page.icon;
        else page.icon = op.icon;
      }
      return inverse;
    }
    case "page.order": {
      const prev = doc.pages.map((p) => p.id);
      const byId = new Map(doc.pages.map((p) => [p.id, p]));
      if (op.ids.length !== prev.length || op.ids.some((id) => !byId.has(id))) {
        throw new OpError("page order must list every page exactly once.");
      }
      undo?.push(keep(doc));
      doc.pages = op.ids.map((id) => byId.get(id)!);
      return { op: "page.order", ids: prev };
    }
    case "page.move": {
      const from = doc.pages.findIndex((p) => p.id === op.id);
      if (from < 0) throw new OpError(`No page ${op.id}.`);
      undo?.push(keep(doc.pages));
      const [page] = doc.pages.splice(from, 1);
      doc.pages.splice(clamp(op.index, 0, doc.pages.length), 0, page!);
      return { op: "page.move", id: op.id, index: from };
    }
    case "file.rename": {
      const prev = doc.name;
      undo?.push(keep(doc));
      doc.name = op.name;
      return { op: "file.rename", name: prev };
    }
    case "file.icon": {
      const prev = doc.icon ?? null;
      undo?.push(keep(doc));
      if (op.icon === null) delete doc.icon;
      else doc.icon = op.icon;
      return { op: "file.icon", icon: prev };
    }
    case "file.scratch": {
      const prev = Boolean(doc.scratch);
      undo?.push(keep(doc));
      if (op.scratch) doc.scratch = true;
      else delete doc.scratch;
      return { op: "file.scratch", scratch: prev };
    }
    case "tokens": {
      const prev = doc.tokens;
      undo?.push(keep(doc));
      doc.tokens = op.css;
      return { op: "tokens", css: prev };
    }
    case "thread.create": {
      if (doc.threads.some((t) => t.id === op.thread.id))
        throw new OpError(`Thread ${op.thread.id} exists.`);
      undo?.push(keep(doc.threads));
      doc.threads.push(structuredClone(op.thread));
      return { op: "thread.delete", id: op.thread.id };
    }
    case "thread.delete": {
      const index = doc.threads.findIndex((t) => t.id === op.id);
      if (index < 0) throw new OpError(`No thread ${op.id}.`);
      undo?.push(keep(doc.threads));
      const [thread] = doc.threads.splice(index, 1);
      return { op: "thread.create", thread: thread! };
    }
    case "thread.update": {
      const thread = mustThread(doc, op.id);
      const inverse: Extract<Op, { op: "thread.update" }> = { op: "thread.update", id: op.id };
      undo?.push(keep(thread));
      if (op.status !== undefined) {
        inverse.status = thread.status;
        thread.status = op.status;
      }
      if (op.nodeId !== undefined) {
        inverse.nodeId = thread.nodeId ?? null;
        if (op.nodeId === null) delete thread.nodeId;
        else thread.nodeId = op.nodeId;
      }
      if (op.offset !== undefined) {
        inverse.offset = thread.offset ?? null;
        if (op.offset === null) delete thread.offset;
        else thread.offset = { ...op.offset };
      }
      if (op.x !== undefined) {
        inverse.x = thread.x;
        thread.x = op.x;
      }
      if (op.y !== undefined) {
        inverse.y = thread.y;
        thread.y = op.y;
      }
      if (op.artboardId !== undefined) {
        inverse.artboardId = thread.artboardId ?? null;
        if (op.artboardId === null) delete thread.artboardId;
        else thread.artboardId = op.artboardId;
      }
      if (op.pageId !== undefined) {
        inverse.pageId = thread.pageId ?? null;
        if (op.pageId === null) delete thread.pageId;
        else thread.pageId = op.pageId;
      }
      if (op.updatedAt !== undefined) {
        inverse.updatedAt = thread.updatedAt;
        thread.updatedAt = op.updatedAt;
      }
      return inverse;
    }
    case "thread.message": {
      const thread = mustThread(doc, op.id);
      undo?.push(keep(thread), keep(thread.messages));
      thread.messages.push(structuredClone(op.message));
      thread.updatedAt = op.message.createdAt;
      return { op: "thread.unmessage", id: op.id, messageId: op.message.id };
    }
    case "thread.unmessage": {
      const thread = mustThread(doc, op.id);
      const index = thread.messages.findIndex((m) => m.id === op.messageId);
      if (index < 0) throw new OpError(`No message ${op.messageId}.`);
      undo?.push(keep(thread.messages));
      const [message] = thread.messages.splice(index, 1);
      return { op: "thread.message", id: op.id, message: message! };
    }
    case "thread.edit": {
      const thread = mustThread(doc, op.id);
      const message = thread.messages.find((m) => m.id === op.messageId);
      if (!message) throw new OpError(`No message ${op.messageId}.`);
      const inverse: Op = {
        op: "thread.edit",
        id: op.id,
        messageId: op.messageId,
        text: message.text,
        editedAt: message.editedAt ?? null,
      };
      undo?.push(keep(message));
      message.text = op.text;
      if (op.editedAt === null) delete message.editedAt;
      else message.editedAt = op.editedAt;
      return inverse;
    }
    case "note": {
      // Read as an own key: a note may be named after something every object has.
      const prev = Object.hasOwn(doc.notes, op.name) ? doc.notes[op.name]! : null;
      undo?.push(keep(doc.notes));
      if (op.content === null) delete doc.notes[op.name];
      else doc.notes[op.name] = op.content;
      return { op: "note", name: op.name, content: prev };
    }
    case "batch": {
      const steps: Undo = [];
      const inverses: Op[] = [];
      try {
        for (const child of op.ops) inverses.push(apply(doc, child, steps));
      } catch (err) {
        for (const restore of steps.reverse()) restore();
        throw err;
      }
      // One at a time: a long batch has more steps than a call takes arguments.
      if (undo) for (const step of steps) undo.push(step);
      return { op: "batch", ops: inverses.reverse() };
    }
  }
}

/**
 * A way to put an object's own fields, or a list's items, back exactly as they are now,
 * order included. It copies one level, which is all an op changes of anything it touches.
 */
function keep(target: object): () => void {
  if (Array.isArray(target)) {
    const items = target.slice();
    return () => {
      target.length = 0;
      for (const item of items) target.push(item);
    };
  }
  const fields = { ...target };
  return () => {
    for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
    Object.assign(target, fields);
  };
}

function removedSnapshot(parent: PElement, index: number, count: number): PNode[] {
  const copy = parent.children.slice();
  copy.splice(index, count);
  return structuredClone(copy);
}

function mustPage(doc: Doc, id: string): PageState {
  const page = doc.pages.find((p) => p.id === id);
  if (!page) throw new OpError(`No page ${id}.`);
  return page;
}

function mustArtboard(doc: Doc, id: string) {
  const hit = findArtboard(doc, id);
  if (!hit) throw new OpError(`No artboard ${id}.`);
  return hit;
}

function mustThread(doc: Doc, id: string): Thread {
  const thread = doc.threads.find((t) => t.id === id);
  if (!thread) throw new OpError(`No comment thread ${id}.`);
  return thread;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : hi));
}

/** Which artboards an op touches. Used for dirty tracking and change events. */
export function touchedArtboards(doc: Doc, op: Op): string[] {
  switch (op.op) {
    case "insert":
      return idsToArtboards(doc, [op.parent]);
    case "remove":
    case "style":
    case "attrs":
    case "name":
    case "children":
    case "move":
      return idsToArtboards(doc, op.op === "move" ? [op.id, op.parent] : [op.id]);
    case "artboard.create":
      return [op.artboard.id];
    case "artboard.delete":
    case "artboard.update":
    case "artboard.move":
      return [op.id];
    case "batch":
      return [...new Set(op.ops.flatMap((o) => touchedArtboards(doc, o)))];
    default:
      return [];
  }
}

function idsToArtboards(doc: Doc, ids: string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const hit = locate(doc, id);
    if (hit) out.add(hit.artboard.id);
  }
  return [...out];
}

/** What kind of state an op changes, for routing persistence. */
export function opScopes(op: Op): Set<"artboards" | "meta" | "tokens" | "threads" | "notes"> {
  const out = new Set<"artboards" | "meta" | "tokens" | "threads" | "notes">();
  const visit = (o: Op) => {
    if (o.op === "batch") return o.ops.forEach(visit);
    if (o.op.startsWith("thread.")) out.add("threads");
    else if (o.op === "tokens") out.add("tokens");
    else if (o.op === "note") out.add("notes");
    else if (o.op.startsWith("page.") || o.op.startsWith("file.")) out.add("meta");
    else out.add("artboards");
    if (o.op === "artboard.create" || o.op === "artboard.delete" || o.op === "artboard.move")
      out.add("meta");
    if (o.op === "page.delete" || o.op === "page.create") out.add("artboards");
  };
  visit(op);
  return out;
}
