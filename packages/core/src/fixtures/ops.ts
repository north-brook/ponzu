import type { Doc, Op } from "../doc.ts";
import type { PElement, PNode } from "../types.ts";

/** Test fixtures: a small canvas, and one op of every variant that applies to it. */

export function el(id: string, tag: string, children: PNode[] = []): PElement {
  return { kind: "el", id, tag, attrs: {}, style: {}, children };
}

export function text(value: string): PNode {
  return { kind: "text", value };
}

/**
 * Two pages. The first has artboard `ab_1` (`n_1` holding `n_2`, then `n_3`) and a comment
 * thread `th_1` with message `m_1`; the second is empty. One note, `brief`.
 */
export function sampleDoc(): Doc {
  const root = el("ab_1", "section", [
    el("n_1", "div", [el("n_2", "p", [text("Hello")])]),
    el("n_3", "p", [text("World")]),
  ]);
  root.name = "Home";
  root.style = { width: "1440px", height: "900px" };
  return {
    name: "Sample",
    pages: [
      { id: "pg_1", name: "First", artboards: [{ id: "ab_1", name: "Home", x: 0, y: 0, root }] },
      { id: "pg_2", name: "Second", icon: "star", artboards: [] },
    ],
    tokens: ":root {\n  --ink: #111;\n}\n",
    threads: [
      {
        id: "th_1",
        artboardId: "ab_1",
        x: 10,
        y: 20,
        status: "open",
        createdAt: 1000,
        updatedAt: 1000,
        messages: [
          { id: "m_1", author: { kind: "user", name: "Ada" }, text: "Tighter?", createdAt: 1000 },
        ],
      },
    ],
    notes: { brief: "A sample." },
  };
}

/** One op of each variant, each of which applies to a fresh `sampleDoc()`. */
export const SAMPLE_OPS: { [K in Op["op"]]: Extract<Op, { op: K }> } = {
  insert: { op: "insert", parent: "n_1", index: 0, nodes: [el("n_9", "span", [text("New")])] },
  remove: { op: "remove", id: "n_2" },
  move: { op: "move", id: "n_2", parent: "ab_1", index: 0 },
  style: { op: "style", id: "n_1", style: { color: "red", "--gap": "4px" } },
  attrs: { op: "attrs", id: "n_1", attrs: { class: "card", "aria-label": "Card" } },
  name: { op: "name", id: "n_1", name: "Card" },
  children: { op: "children", id: "n_1", children: [text("Just text"), el("n_8", "b")] },
  "artboard.create": {
    op: "artboard.create",
    page: "pg_2",
    index: 0,
    artboard: { id: "ab_2", name: "About", x: 100, y: 0, root: el("ab_2", "section") },
  },
  "artboard.delete": { op: "artboard.delete", id: "ab_1" },
  "artboard.update": { op: "artboard.update", id: "ab_1", x: 40, y: -50.5, name: "Landing" },
  "artboard.move": { op: "artboard.move", id: "ab_1", page: "pg_2", index: 0 },
  "page.create": { op: "page.create", index: 1, page: { id: "pg_3", name: "Third", icon: "cart" } },
  "page.delete": { op: "page.delete", id: "pg_1" },
  "page.update": { op: "page.update", id: "pg_2", name: "Later", icon: null },
  "page.order": { op: "page.order", ids: ["pg_2", "pg_1"] },
  "page.move": { op: "page.move", id: "pg_1", index: 1 },
  "file.rename": { op: "file.rename", name: "Renamed" },
  "file.icon": { op: "file.icon", icon: "palette" },
  "file.scratch": { op: "file.scratch", scratch: true },
  tokens: { op: "tokens", css: ":root {\n  --ink: #222;\n}\n" },
  "thread.create": {
    op: "thread.create",
    thread: {
      id: "th_2",
      pageId: "pg_2",
      x: 5,
      y: 6,
      status: "open",
      createdAt: 2000,
      updatedAt: 2000,
      messages: [
        { id: "m_2", author: { kind: "agent", name: "Claude" }, text: "Which?", createdAt: 2000 },
      ],
    },
  },
  "thread.delete": { op: "thread.delete", id: "th_1" },
  "thread.update": {
    op: "thread.update",
    id: "th_1",
    status: "resolved",
    nodeId: "n_2",
    offset: { x: 3, y: 4 },
    x: 30,
    y: 40,
    artboardId: null,
    pageId: "pg_1",
    updatedAt: 3000,
  },
  "thread.message": {
    op: "thread.message",
    id: "th_1",
    message: { id: "m_3", author: { kind: "user", name: "Ada" }, text: "Yes.", createdAt: 4000 },
  },
  "thread.unmessage": { op: "thread.unmessage", id: "th_1", messageId: "m_1" },
  "thread.edit": {
    op: "thread.edit",
    id: "th_1",
    messageId: "m_1",
    text: "Looser?",
    editedAt: 5000,
  },
  note: { op: "note", name: "decisions", content: "Blue." },
  batch: {
    op: "batch",
    ops: [
      { op: "style", id: "n_3", style: { color: "blue" } },
      { op: "batch", ops: [{ op: "file.rename", name: "Nested" }] },
    ],
  },
};

export const VARIANTS = Object.keys(SAMPLE_OPS) as Op["op"][];
