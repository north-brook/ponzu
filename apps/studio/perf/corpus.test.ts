import { describe, expect, test } from "bun:test";
import { createFakeBackend } from "@ponzu/client/testing";
import { type Artboard, MAX_OP_BYTES, type PNode } from "@ponzu/core";
import { BOARDS, type BoardKind, CORPUS_TOKENS, countNodes, MAX_SPEC_ID } from "./corpus.ts";

const KINDS = Object.keys(BOARDS) as BoardKind[];

/** Every element id in a board, its root's included. */
function ids(ab: Artboard): string[] {
  const out: string[] = [];
  const walk = (node: PNode) => {
    if (node.kind !== "el") return;
    out.push(node.id);
    for (const child of node.children) walk(child);
  };
  walk(ab.root);
  return out;
}

// Two copies of every kind, as a benchmark canvas would hold them.
const first = KINDS.map((kind, i) =>
  BOARDS[kind].make({ id: `ab_a${i}`, name: kind, x: i * 100, y: 0 }),
);
const second = KINDS.map((kind, i) =>
  BOARDS[kind].make({ id: `ab_b${i}`, name: kind, x: i * 100, y: 5000 }),
);

describe("the benchmark corpus", () => {
  test("every board stays well inside one op's node limit", () => {
    const rows = first.map((ab, i) => ({
      kind: KINDS[i],
      nodes: countNodes(ab),
      kb: Math.round(Buffer.byteLength(JSON.stringify(ab)) / 1024),
    }));
    console.log("\nNodes per board kind:");
    console.table(rows);
    console.log(
      `Total: ${rows.reduce((n, r) => n + r.nodes, 0)} nodes, ${rows.reduce((n, r) => n + r.kb, 0)} KB`,
    );
    for (const row of rows) expect(row.nodes, row.kind).toBeLessThan(9_500);
  });

  test("a board's ids are unique, and so are two boards' made from one kind", () => {
    for (let i = 0; i < KINDS.length; i++) {
      const a = ids(first[i]!);
      const b = ids(second[i]!);
      expect(new Set(a).size, KINDS[i]).toBe(a.length);
      expect(
        a.filter((id) => b.includes(id)),
        KINDS[i],
      ).toEqual([]);
    }
  });

  test("boards come out the same every time", () => {
    for (const kind of ["site", "dense-grid", "images", "svg-chart"] as const) {
      const spec = { id: "ab_same", name: kind, x: 0, y: 0 };
      expect(JSON.stringify(BOARDS[kind].make(spec))).toBe(JSON.stringify(BOARDS[kind].make(spec)));
    }
  });

  test("even with the longest spec id, every board fits in one op", () => {
    const id = "a".repeat(MAX_SPEC_ID);
    for (const kind of KINDS) {
      const artboard = BOARDS[kind].make({ id, name: kind, x: 0, y: 0 });
      const op = { op: "artboard.create", page: "pg_page01", index: 0, artboard };
      expect(Buffer.byteLength(JSON.stringify(op)), kind).toBeLessThan(MAX_OP_BYTES);
    }
    expect(() => BOARDS["tiny-card"].make({ id: `${id}a`, name: "x", x: 0, y: 0 })).toThrow();
  });

  test("the tokens and every board commit to one canvas without a rejection", async () => {
    const backend = createFakeBackend();
    const me = backend.addPerson({ login: "bench", name: "Bench" });
    const workspace = backend.addWorkspace({ login: "bench", members: { [me.id]: "admin" } });
    const { api } = backend.connect(me);
    const { id } = await api.canvases.create({ workspaceId: workspace.id, name: "Corpus" });
    const agent = backend.agent(id);
    const page = backend.canvas(id).sequencer.doc.pages[0]!.id;
    agent.commit([{ op: "tokens", css: CORPUS_TOKENS }]);
    // One op per board, as the benchmark commits them: each must pass validateOp on its own.
    [...first, ...second].forEach((artboard, index) => {
      agent.commit([{ op: "artboard.create", page, index, artboard }]);
    });
    const doc = backend.canvas(id).sequencer.doc;
    expect(doc.pages[0]!.artboards).toHaveLength(KINDS.length * 2);
    expect(doc.tokens).toBe(CORPUS_TOKENS);
    // What the canvas kept is what was sent: sanitizing took nothing out of any board.
    const kept = new Map(doc.pages[0]!.artboards.map((ab) => [ab.id, ab]));
    for (const ab of first) expect(countNodes(kept.get(ab.id)!), ab.name).toBe(countNodes(ab));
  });
});
