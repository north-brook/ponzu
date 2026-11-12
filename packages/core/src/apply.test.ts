import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { applyOp, type Op, OpError } from "./doc.ts";
import { el, SAMPLE_OPS, sampleDoc, text, VARIANTS } from "./fixtures/ops.ts";

afterEach(() => setSystemTime());

describe("applyOp reads nothing but the doc and the op", () => {
  for (const variant of VARIANTS) {
    test(variant, () => {
      const run = (at: string, random: number) => {
        setSystemTime(new Date(at));
        const clock = spyOn(Date, "now");
        const dice = spyOn(Math, "random").mockReturnValue(random);
        const entropy = spyOn(crypto, "getRandomValues");
        try {
          const doc = sampleDoc();
          const inverse = applyOp(doc, structuredClone(SAMPLE_OPS[variant]));
          expect(clock).not.toHaveBeenCalled();
          expect(dice).not.toHaveBeenCalled();
          expect(entropy).not.toHaveBeenCalled();
          // As text, so the order of keys counts too: it is the order of a style's declarations.
          return JSON.stringify({ doc, inverse });
        } finally {
          clock.mockRestore();
          dice.mockRestore();
          entropy.mockRestore();
        }
      };
      const first = run("2026-01-01T00:00:00Z", 0.1);
      expect(run("2031-06-15T12:34:56Z", 0.9)).toBe(first);
      expect(first).not.toBe(JSON.stringify({ doc: sampleDoc(), inverse: null }));
    });
  }
});

describe("an op that fails changes nothing", () => {
  const impossible: Op = { op: "remove", id: "n_missing" };

  for (const variant of VARIANTS) {
    test(`a batch that fails after ${variant} leaves the doc exactly as it was`, () => {
      const doc = sampleDoc();
      doc.icon = "star";
      doc.scratch = true;
      const before = JSON.stringify(doc);
      const batch: Op = { op: "batch", ops: [structuredClone(SAMPLE_OPS[variant]), impossible] };
      expect(() => applyOp(doc, batch)).toThrow(OpError);
      // Down to the order of keys and of threads, which the inverse ops don't all restore.
      expect(JSON.stringify(doc)).toBe(before);
      const nested: Op = { op: "batch", ops: [SAMPLE_OPS.note, batch] };
      expect(() => applyOp(doc, nested)).toThrow(OpError);
      expect(JSON.stringify(doc)).toBe(before);
    });
  }

  test("a failed batch puts back the node it moved, not another with the same id", () => {
    const doc = sampleDoc();
    // Two nodes with one id: canvases have them (a copy keeps its ids).
    const root = doc.pages[0]!.artboards[0]!.root;
    root.children.push({ ...el("n_1", "footer", [text("The twin")]) });
    const before = JSON.stringify(doc);
    const batch: Op = {
      op: "batch",
      ops: [
        { op: "move", id: "n_1", parent: "ab_1", index: 99 },
        { op: "style", id: "n_1", style: { color: "red" } },
        { op: "name", id: "ab_1", name: "Renamed" },
        impossible,
      ],
    };
    expect(() => applyOp(doc, batch)).toThrow(OpError);
    expect(JSON.stringify(doc)).toBe(before);
  });

  test("a batch that succeeds still returns the batch that undoes it", () => {
    const doc = sampleDoc();
    const inverse = applyOp(doc, {
      op: "batch",
      ops: [
        { op: "file.rename", name: "X" },
        { op: "batch", ops: [{ op: "style", id: "n_1", style: { color: "red" } }] },
      ],
    });
    expect(inverse).toEqual({
      op: "batch",
      ops: [
        { op: "batch", ops: [{ op: "style", id: "n_1", style: {} }] },
        { op: "file.rename", name: "Sample" },
      ],
    });
    applyOp(doc, inverse);
    expect(doc).toEqual(sampleDoc());
  });

  test("a note named after something every object has is still just a note", () => {
    const doc = sampleDoc();
    const inverse = applyOp(doc, { op: "note", name: "constructor", content: "x" });
    expect(inverse).toEqual({ op: "note", name: "constructor", content: null });
    applyOp(doc, inverse);
    expect(doc).toEqual(sampleDoc());
  });
});

describe("a thread's time travels in the op", () => {
  test("thread.update sets updatedAt from the op, and its inverse puts the old one back", () => {
    const doc = sampleDoc();
    const inverse = applyOp(doc, {
      op: "thread.update",
      id: "th_1",
      status: "resolved",
      updatedAt: 7777,
    });
    expect(doc.threads[0]).toMatchObject({ status: "resolved", updatedAt: 7777 });
    expect(inverse).toEqual({ op: "thread.update", id: "th_1", status: "open", updatedAt: 1000 });
    applyOp(doc, inverse);
    expect(doc).toEqual(sampleDoc());
  });

  test("without a time in the op, the thread's time stays", () => {
    const doc = sampleDoc();
    const inverse = applyOp(doc, { op: "thread.update", id: "th_1", x: 99 });
    expect(doc.threads[0]!.updatedAt).toBe(1000);
    expect(inverse).toEqual({ op: "thread.update", id: "th_1", x: 10 });
  });
});
