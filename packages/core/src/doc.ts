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
  /** An agent made it for its own use: the home screen lists it under Scratch, not Recent. */
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
      x?: number;
      y?: number;
      /** null moves the pin off its artboard, onto the open canvas of `pageId`. */
      artboardId?: string | null;
      pageId?: string | null;
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

export function findPage(doc: Doc, idOrName: string): PageState | null {
  return (
    doc.pages.find((p) => p.id === idOrName) ??
    doc.pages.find((p) => p.name.toLowerCase() === idOrName.toLowerCase()) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply an op to the doc in place and return the op that undoes it.
 * Throws OpError (leaving the doc unchanged) when the op doesn't fit.
 */
export function applyOp(doc: Doc, op: Op): Op {
  switch (op.op) {
    case "insert": {
      const { node: parent } = mustLocate(doc, op.parent);
      for (const n of op.nodes)
        if (n.kind === "el" && locate(doc, n.id))
          throw new OpError(`Id ${n.id} is already in use.`);
      const index = clamp(op.index, 0, parent.children.length);
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
      hit.parent.children.splice(hit.index, 1);
      target.children.splice(clamp(op.index, 0, target.children.length), 0, hit.node);
      return { op: "move", id: op.id, ...before };
    }
    case "style": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.style;
      node.style = { ...op.style };
      return { op: "style", id: op.id, style: prev };
    }
    case "attrs": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.attrs;
      node.attrs = { ...op.attrs };
      return { op: "attrs", id: op.id, attrs: prev };
    }
    case "name": {
      const hit = mustLocate(doc, op.id);
      const prev = hit.node.name ?? null;
      if (op.name === null) delete hit.node.name;
      else hit.node.name = op.name;
      if (!hit.parent && op.name !== null) hit.artboard.name = op.name;
      return { op: "name", id: op.id, name: prev };
    }
    case "children": {
      const { node } = mustLocate(doc, op.id);
      const prev = node.children;
      node.children = structuredClone(op.children);
      return { op: "children", id: op.id, children: prev };
    }
    case "artboard.create": {
      const page = mustPage(doc, op.page);
      if (findArtboard(doc, op.artboard.id))
        throw new OpError(`Artboard ${op.artboard.id} already exists.`);
      page.artboards.splice(
        clamp(op.index, 0, page.artboards.length),
        0,
        structuredClone(op.artboard),
      );
      return { op: "artboard.delete", id: op.artboard.id };
    }
    case "artboard.delete": {
      const hit = mustArtboard(doc, op.id);
      hit.page.artboards.splice(hit.index, 1);
      return { op: "artboard.create", page: hit.page.id, index: hit.index, artboard: hit.artboard };
    }
    case "artboard.update": {
      const { artboard } = mustArtboard(doc, op.id);
      const inverse: Op = { op: "artboard.update", id: op.id };
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
      hit.page.artboards.splice(hit.index, 1);
      target.artboards.splice(clamp(op.index, 0, target.artboards.length), 0, hit.artboard);
      return { op: "artboard.move", id: op.id, page: hit.page.id, index: hit.index };
    }
    case "page.create": {
      if (doc.pages.some((p) => p.id === op.page.id))
        throw new OpError(`Page ${op.page.id} already exists.`);
      doc.pages.splice(clamp(op.index, 0, doc.pages.length), 0, { ...op.page, artboards: [] });
      return { op: "page.delete", id: op.page.id };
    }
    case "page.delete": {
      const index = doc.pages.findIndex((p) => p.id === op.id);
      if (index < 0) throw new OpError(`No page ${op.id}.`);
      const page = doc.pages[index]!;
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
      doc.pages = op.ids.map((id) => byId.get(id)!);
      return { op: "page.order", ids: prev };
    }
    case "file.rename": {
      const prev = doc.name;
      doc.name = op.name;
      return { op: "file.rename", name: prev };
    }
    case "file.icon": {
      const prev = doc.icon ?? null;
      if (op.icon === null) delete doc.icon;
      else doc.icon = op.icon;
      return { op: "file.icon", icon: prev };
    }
    case "file.scratch": {
      const prev = Boolean(doc.scratch);
      if (op.scratch) doc.scratch = true;
      else delete doc.scratch;
      return { op: "file.scratch", scratch: prev };
    }
    case "tokens": {
      const prev = doc.tokens;
      doc.tokens = op.css;
      return { op: "tokens", css: prev };
    }
    case "thread.create": {
      if (doc.threads.some((t) => t.id === op.thread.id))
        throw new OpError(`Thread ${op.thread.id} exists.`);
      doc.threads.push(structuredClone(op.thread));
      return { op: "thread.delete", id: op.thread.id };
    }
    case "thread.delete": {
      const index = doc.threads.findIndex((t) => t.id === op.id);
      if (index < 0) throw new OpError(`No thread ${op.id}.`);
      const [thread] = doc.threads.splice(index, 1);
      return { op: "thread.create", thread: thread! };
    }
    case "thread.update": {
      const thread = mustThread(doc, op.id);
      const inverse: Extract<Op, { op: "thread.update" }> = { op: "thread.update", id: op.id };
      if (op.status !== undefined) {
        inverse.status = thread.status;
        thread.status = op.status;
      }
      if (op.nodeId !== undefined) {
        inverse.nodeId = thread.nodeId ?? null;
        if (op.nodeId === null) delete thread.nodeId;
        else thread.nodeId = op.nodeId;
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
      thread.updatedAt = Date.now();
      return inverse;
    }
    case "thread.message": {
      const thread = mustThread(doc, op.id);
      thread.messages.push(structuredClone(op.message));
      thread.updatedAt = op.message.createdAt;
      return { op: "thread.unmessage", id: op.id, messageId: op.message.id };
    }
    case "thread.unmessage": {
      const thread = mustThread(doc, op.id);
      const index = thread.messages.findIndex((m) => m.id === op.messageId);
      if (index < 0) throw new OpError(`No message ${op.messageId}.`);
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
      message.text = op.text;
      if (op.editedAt === null) delete message.editedAt;
      else message.editedAt = op.editedAt;
      return inverse;
    }
    case "note": {
      const prev = doc.notes[op.name] ?? null;
      if (op.content === null) delete doc.notes[op.name];
      else doc.notes[op.name] = op.content;
      return { op: "note", name: op.name, content: prev };
    }
    case "batch": {
      const inverses: Op[] = [];
      try {
        for (const child of op.ops) inverses.push(applyOp(doc, child));
      } catch (err) {
        for (const inv of inverses.reverse()) applyOp(doc, inv);
        throw err;
      }
      return { op: "batch", ops: inverses.reverse() };
    }
  }
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
