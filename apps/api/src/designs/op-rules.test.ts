import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Op } from "@ponzu/core";
import { SAMPLE_OPS, sampleDoc, VARIANTS } from "@ponzu/core/fixtures";
import {
  call,
  designIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { OP_RULES } from "./op-rules.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterAll(() => t.close());

// Written out here, not read from OP_RULES, so that changing who may send an op is a change
// to this file too. `sampleDoc`'s one message (`m_1`) is a person's from the local app.
const PERSON: Record<Op["op"], "committed" | "rejected"> = {
  insert: "rejected",
  remove: "rejected",
  move: "rejected",
  style: "rejected",
  attrs: "rejected",
  name: "rejected",
  children: "rejected",
  "artboard.create": "rejected",
  "artboard.delete": "committed",
  "artboard.update": "committed",
  "artboard.move": "committed",
  "page.create": "committed",
  "page.delete": "committed",
  "page.update": "committed",
  "page.order": "committed",
  "page.move": "committed",
  "file.rename": "rejected",
  "file.icon": "rejected",
  "file.scratch": "rejected",
  tokens: "rejected",
  note: "rejected",
  "thread.create": "committed",
  "thread.message": "committed",
  "thread.update": "committed",
  "thread.delete": "committed",
  "thread.edit": "rejected",
  "thread.unmessage": "rejected",
  // Its first op restyles a node.
  batch: "rejected",
};

const RUNNER: Record<Op["op"], "committed" | "rejected"> = {
  ...(Object.fromEntries(VARIANTS.map((variant) => [variant, "committed"])) as typeof PERSON),
  "file.scratch": "rejected",
  // The agent did not write `m_1` either.
  "thread.edit": "rejected",
  "thread.unmessage": "rejected",
};

test("every op variant is decided, and nothing else", () => {
  expect(Object.keys(OP_RULES).sort()).toEqual([...VARIANTS].sort());
  expect(Object.keys(PERSON).sort()).toEqual([...VARIANTS].sort());
});

describe.each([
  ["a person with write access", PERSON],
  ["the design's runner", RUNNER],
] as const)("what %s may commit", (who, expected) => {
  test.each(VARIANTS)("%s", async (variant) => {
    const design = await designIn(t, ws, "maya", sampleDoc());
    const headers = who.startsWith("a person")
      ? ws.people.maya!.headers
      : await runnerHeaders(t, design.id);

    const { status, body } = await call(t, headers, "POST", `/v1/designs/${design.id}/ops`, {
      ops: [{ id: `op_${variant.replace(".", "_")}`, op: SAMPLE_OPS[variant] }],
    });

    expect(status).toBe(200);
    const outcome = body.committed.length === 1 ? "committed" : "rejected";
    expect([variant, outcome]).toEqual([variant, expected[variant]]);
    expect(body.seq).toBe(outcome === "committed" ? 1 : 0);
    // A refused op changes nothing.
    if (outcome === "rejected") {
      const doc = await call(t, headers, "GET", `/v1/designs/${design.id}/doc`);
      expect(doc.body).toEqual({ doc: sampleDoc(), seq: 0 });
    }
  });
});
