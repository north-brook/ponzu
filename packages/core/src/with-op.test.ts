import { describe, expect, test } from "bun:test";
import { applyOp, type Doc, type Op, OpError, withOp } from "./doc.ts";
import { el, SAMPLE_OPS, sampleDoc, text, VARIANTS } from "./fixtures/ops.ts";
import { random } from "./fixtures/random.ts";
import { randomOp } from "./fixtures/random-ops.ts";
import type { Artboard, PElement } from "./types.ts";

/** `value` and everything in it frozen, so a change in place throws instead of passing. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

/** What `applyOp` makes of a copy of `doc`, or the error it throws, as text. */
function inPlace(doc: Doc, op: Op): string {
  const copy = structuredClone(doc);
  try {
    const inverse = applyOp(copy, op);
    return JSON.stringify({ doc: copy, inverse });
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** The same from `withOp`, which must leave `doc` (frozen) as it was. */
function shared(doc: Doc, op: Op): string {
  try {
    const { doc: next, inverse } = withOp(doc, op);
    return JSON.stringify({ doc: next, inverse });
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** Every object in `value`, to tell which objects a new document made and which it shares. */
function objects(value: unknown, into = new Set<object>()): Set<object> {
  if (value && typeof value === "object" && !into.has(value)) {
    into.add(value);
    for (const child of Object.values(value)) objects(child, into);
  }
  return into;
}

/** How many objects of `before` were copied into `after`: those in `after` but not `before` that stand where one of `before` stood. */
function copied(before: Doc, after: Doc): number {
  const old = objects(before);
  let count = 0;
  const visit = (a: unknown, b: unknown) => {
    if (!a || typeof a !== "object" || !b || typeof b !== "object" || a === b) return;
    if (!old.has(b) && old.has(a)) count++;
    for (const key of Object.keys(b)) visit((a as never)[key], (b as never)[key]);
  };
  visit(before, after);
  return count;
}

describe("withOp gives what applyOp would, and changes nothing in place", () => {
  for (const variant of VARIANTS) {
    test(variant, () => {
      const base = frozen(sampleDoc());
      const op = SAMPLE_OPS[variant];
      expect(shared(base, op)).toBe(inPlace(sampleDoc(), op));
      expect(base).toEqual(sampleDoc());
    });
  }

  test("an op that fails throws OpError and leaves the document as it was", () => {
    const base = frozen(sampleDoc());
    const failing: Op = {
      op: "batch",
      ops: [SAMPLE_OPS.style, SAMPLE_OPS["thread.message"], { op: "remove", id: "n_missing" }],
    };
    expect(() => withOp(base, failing)).toThrow(OpError);
    expect(base).toEqual(sampleDoc());
  });

  test("1,000 random ops, one after another, agree with applyOp", () => {
    const r = random(20261113);
    let n = 0;
    const fresh = () => `x${(n++).toString(36).padStart(8, "0")}`;
    let doc = frozen(sampleDoc());
    let applied = 0;
    for (let i = 0; i < 1_000; i++) {
      const op = randomOp(r, doc, fresh);
      const expected = inPlace(doc, op);
      expect(shared(doc, op)).toBe(expected);
      if (!expected.startsWith("{")) continue;
      doc = frozen(withOp(doc, op).doc);
      applied++;
    }
    // Most of them applied, so the run reached deep into documents it had built itself.
    expect(applied).toBeGreaterThan(500);
  }, 60_000);
});

/** Two pages of boards, each a tree `depth` deep and `width` wide, and a thread. */
function canvas(boards = 6, depth = 4, width = 3): Doc {
  let ids = 0;
  const tree = (level: number): PElement =>
    el(
      `n_${(ids++).toString(36)}`,
      "div",
      level === depth ? [text("Leaf")] : Array.from({ length: width }, () => tree(level + 1)),
    );
  const board = (i: number): Artboard => {
    const root = tree(0);
    root.id = `ab_${i}`;
    return { id: root.id, name: `Board ${i}`, x: i * 2000, y: 0, root };
  };
  const doc = sampleDoc();
  doc.pages[0]!.artboards = Array.from({ length: boards / 2 }, (_, i) => board(i));
  doc.pages[1]!.artboards = Array.from({ length: boards / 2 }, (_, i) => board(i + boards / 2));
  doc.threads[0]!.artboardId = "ab_0";
  return doc;
}

const boardsOf = (doc: Doc) => doc.pages.flatMap((p) => p.artboards);

describe("withOp copies only what the op changes", () => {
  test("a comment leaves every page and board the same object, and copies two objects", () => {
    const before = frozen(canvas());
    const { doc: after } = withOp(before, {
      op: "thread.create",
      thread: {
        id: "th_2",
        artboardId: "ab_0",
        x: 1,
        y: 1,
        status: "open",
        createdAt: 2,
        updatedAt: 2,
        messages: [{ id: "m_2", author: { kind: "user", name: "Ada" }, text: "Hm", createdAt: 2 }],
      },
    });
    expect(after.pages).toBe(before.pages);
    expect(after.threads[0]).toBe(before.threads[0]!);
    // The document and its list of threads; the new thread is the op's own.
    expect(copied(before, after)).toBe(2);
  });

  test("a reply copies its thread and the thread's messages, not the other threads", () => {
    const before = frozen(canvas());
    const { doc: after } = withOp(before, SAMPLE_OPS["thread.message"]);
    expect(after.pages).toBe(before.pages);
    // The document, the threads list, the thread, its messages.
    expect(copied(before, after)).toBe(4);
  });

  test("a style on a deep node copies the path to it, and no other board or branch", () => {
    const before = frozen(canvas(6, 4, 3));
    const target = boardsOf(before)[1]!.root.children[2] as PElement;
    const deep = (target.children[0] as PElement).children[1] as PElement;
    const { doc: after } = withOp(before, { op: "style", id: deep.id, style: { color: "red" } });
    const [b0, b1, ...rest] = boardsOf(after);
    expect(b0).toBe(boardsOf(before)[0]!);
    rest.forEach((board, i) => expect(board).toBe(boardsOf(before)[i + 2]!));
    expect(after.pages[1]).toBe(before.pages[1]!);
    expect(after.threads).toBe(before.threads);
    // The siblings of every node on the path are the same objects.
    expect(b1!.root.children[0]).toBe(boardsOf(before)[1]!.root.children[0]!);
    expect(b1!.root.children[1]).toBe(boardsOf(before)[1]!.root.children[1]!);
    // doc, pages, page, its boards, the board; the root, the two nodes below it and the node
    // itself, each with its list of children; and the node's new style.
    expect(copied(before, after)).toBe(5 + 2 * 4 + 1);
  });

  test("a board moved on the canvas keeps its tree", () => {
    const before = frozen(canvas());
    const { doc: after } = withOp(before, { op: "artboard.update", id: "ab_4", x: 9, y: 9 });
    const moved = boardsOf(after)[4]!;
    expect(moved.x).toBe(9);
    expect(moved.root.children).toBe(boardsOf(before)[4]!.root.children);
    expect(after.pages[0]).toBe(before.pages[0]!);
  });
});
