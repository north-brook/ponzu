import { describe, expect, test } from "bun:test";
import { applyOp, locate, type Op } from "./doc.ts";
import { SAMPLE_OPS, sampleDoc, VARIANTS } from "./fixtures/ops.ts";
import { summarize, threadEvents, touchesStructure } from "./summary.ts";

describe("summarize", () => {
  test("says what each op did, naming artboards and layers where it can", () => {
    const said = Object.fromEntries(
      VARIANTS.map((variant) => {
        const doc = sampleDoc();
        locate(doc, "n_3")!.node.name = "Footer";
        const op = structuredClone(SAMPLE_OPS[variant]) as Op;
        applyOp(doc, op);
        return [variant, summarize(doc, op)];
      }),
    );
    expect(said).toEqual({
      insert: "added to n_1",
      remove: "removed n_2",
      move: "moved n_2",
      style: "restyled n_1",
      attrs: "changed attributes on n_1",
      name: "renamed n_1",
      children: "rewrote n_1",
      "artboard.create": 'created artboard "About"',
      "artboard.delete": "deleted artboard ab_1",
      "artboard.update": 'updated artboard "Landing"',
      "artboard.move": 'moved artboard "Home" to another page',
      "page.create": 'created page "Third"',
      "page.delete": "deleted a page",
      "page.update": "updated a page",
      "page.order": "reordered pages",
      "page.move": "moved a page",
      "file.rename": 'renamed the file to "Renamed"',
      "file.icon": "changed the file's icon",
      "file.scratch": "marked the file as scratch",
      tokens: "changed tokens",
      "thread.create": "thread.create",
      "thread.delete": "thread.delete",
      "thread.update": "thread.update",
      "thread.message": "thread.message",
      "thread.unmessage": "thread.unmessage",
      "thread.edit": "thread.edit",
      note: "wrote note decisions",
      batch: 'restyled "Footer"; renamed the file to "Nested"',
    });
  });

  test("a batch says each thing once, and stops at three", () => {
    const doc = sampleDoc();
    const style = (id: string): Op => ({ op: "style", id, style: {} });
    expect(summarize(doc, { op: "batch", ops: [style("n_1"), style("n_1")] })).toBe("restyled n_1");
    const four: Op = { op: "batch", ops: ["n_1", "n_2", "n_3", "ab_1"].map(style) };
    expect(summarize(doc, four)).toBe("restyled n_1; restyled n_2; restyled n_3; …");
    expect(summarize(doc, { op: "note", name: "brief", content: null })).toBe("deleted note brief");
    expect(summarize(doc, { op: "file.scratch", scratch: false })).toBe(
      "took the file out of scratch",
    );
  });
});

describe("threadEvents", () => {
  test("finds the comment events in an op, batches included, in order", () => {
    const create = SAMPLE_OPS["thread.create"];
    const op: Op = {
      op: "batch",
      ops: [
        create,
        SAMPLE_OPS["thread.message"],
        { op: "batch", ops: [SAMPLE_OPS["thread.edit"], SAMPLE_OPS["thread.update"]] },
        SAMPLE_OPS.style,
      ],
    };
    expect(threadEvents(op)).toEqual([
      { kind: "created", thread: create.thread },
      { kind: "message", id: "th_1", text: "Yes." },
      { kind: "edited", id: "th_1", text: "Looser?" },
      { kind: "status", id: "th_1", status: "resolved" },
    ]);
  });

  test("a pin that only moved, a deleted thread and a deleted message are no event", () => {
    expect(threadEvents({ op: "thread.update", id: "th_1", x: 1, y: 2 })).toEqual([]);
    expect(threadEvents(SAMPLE_OPS["thread.delete"])).toEqual([]);
    expect(threadEvents(SAMPLE_OPS["thread.unmessage"])).toEqual([]);
  });
});

describe("touchesStructure", () => {
  test("is true for pages, tokens and the file's name, alone or in a batch", () => {
    const yes = VARIANTS.filter((variant) => touchesStructure(SAMPLE_OPS[variant]));
    expect(yes).toEqual([
      "page.create",
      "page.delete",
      "page.update",
      "page.order",
      "page.move",
      "file.rename",
      "tokens",
      // The sample batch renames the file.
      "batch",
    ]);
    expect(touchesStructure({ op: "batch", ops: [SAMPLE_OPS.style, SAMPLE_OPS.note] })).toBe(false);
  });
});
