import { expect, test } from "bun:test";
import type { Doc, Op, PElement, PNode } from "@ponzu/core";
import { ARRIVE_MAX_STAGGER, ARRIVE_STAGGER_MS, Arrivals, arrivals, outermost } from "./arrive.ts";

const el = (id: string, children: PNode[] = []): PElement =>
  ({ kind: "el", id, tag: "div", attrs: {}, style: {}, children }) as PElement;
const text = (value: string): PNode => ({ kind: "text", value }) as PNode;

const doc = (root: PElement): Doc => ({
  name: "D",
  pages: [{ id: "pg", name: "P", artboards: [{ id: root.id, name: "A", x: 0, y: 0, root }] }],
  tokens: "",
  threads: [],
  notes: {},
});

test("what an op brings onto the canvas", () => {
  const insert: Op = { op: "insert", parent: "ab", index: 0, nodes: [el("n_a"), text("x")] };
  expect(arrivals(insert)).toEqual(["n_a"]);
  // A new artboard fills in section by section, not as one sheet.
  const board: Op = {
    op: "artboard.create",
    page: "pg",
    index: 0,
    artboard: { id: "ab", name: "A", x: 0, y: 0, root: el("ab", [el("n_h"), el("n_b")]) },
  };
  expect(arrivals(board)).toEqual(["n_h", "n_b"]);
  // write_html's replace: an insert and a remove in one batch.
  const replace: Op = { op: "batch", ops: [insert, { op: "remove", id: "n_old" }] };
  expect(arrivals(replace)).toEqual(["n_a"]);
});

test("restyles, moves and text edits change what's there, so nothing rises", () => {
  expect(arrivals({ op: "style", id: "n_a", style: { color: "red" } })).toEqual([]);
  expect(arrivals({ op: "move", id: "n_a", parent: "ab", index: 1 })).toEqual([]);
  // set_text replaces children with text alone.
  expect(arrivals({ op: "children", id: "n_a", children: [text("hi")] })).toEqual([]);
});

test("a piece inside another that's rising rises with it", () => {
  const d = doc(el("ab", [el("n_a", [el("n_b")]), el("n_c")]));
  expect(outermost(d, ["n_b", "n_a", "n_c", "n_gone"])).toEqual(["n_a", "n_c"]);
});

test("a long write lands in about a second, and the next joins the end of its stagger", () => {
  const ids = Array.from({ length: 30 }, (_, i) => el(`n_${i}`));
  const d = doc(el("ab", ids));
  const a = new Arrivals();
  a.add({ op: "insert", parent: "ab", index: 0, nodes: ids.slice(0, 20) }, d, 0);
  const starts = (a as unknown as { pieces: Map<string, number> }).pieces;
  expect(starts.get("n_0")).toBe(0);
  expect(starts.get("n_19")).toBe(ARRIVE_MAX_STAGGER * ARRIVE_STAGGER_MS);
  a.add({ op: "insert", parent: "ab", index: 20, nodes: [ids[20]!] }, d, 100);
  expect(starts.get("n_20")).toBe((ARRIVE_MAX_STAGGER + 1) * ARRIVE_STAGGER_MS);
});
