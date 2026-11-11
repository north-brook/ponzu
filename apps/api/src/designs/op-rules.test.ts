import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Actor, Op } from "@ponzu/core";
import { SAMPLE_OPS, sampleDoc, VARIANTS } from "@ponzu/core/fixtures";
import {
  call,
  designIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { AGENT } from "./actor.ts";
import { refusal } from "./op-rules.ts";

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
  "file.rename": "committed",
  "file.icon": "committed",
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

const PERSON_ACTOR: Actor = { kind: "user", id: "usr_maya", name: "Maya" };

test.each([
  ["a person with write access", PERSON_ACTOR, PERSON],
  ["the design's runner", AGENT, RUNNER],
] as const)("what %s may commit, op by op", (_, actor, expected) => {
  const outcomes = Object.fromEntries(
    VARIANTS.map((variant) => [
      variant,
      refusal(actor, SAMPLE_OPS[variant], sampleDoc()) === null ? "committed" : "rejected",
    ]),
  );
  expect(outcomes).toEqual(expected);
});

// The table above is `refusal`'s; these show a post through the route is judged by it, for a
// person and for the runner, and that a refused op changes nothing.
test.each([
  ["a person", "style", "rejected"],
  ["the runner", "style", "committed"],
  ["the runner", "file.scratch", "rejected"],
] as const)("%s posting %s through the route: %s", async (who, variant, expected) => {
  const design = await designIn(t, ws, "maya", sampleDoc());
  const headers = who === "a person" ? ws.people.maya!.headers : await runnerHeaders(t, design.id);

  const { status, body } = await call(t, headers, "POST", `/v1/designs/${design.id}/ops`, {
    ops: [{ id: `op_${variant.replace(".", "_")}`, op: SAMPLE_OPS[variant] }],
  });

  expect(status).toBe(200);
  expect(body.committed.length === 1 ? "committed" : "rejected").toBe(expected);
  expect(body.seq).toBe(expected === "committed" ? 1 : 0);
  if (expected === "rejected") {
    const doc = await call(t, headers, "GET", `/v1/designs/${design.id}/doc`);
    expect(doc.body).toEqual({ doc: sampleDoc(), seq: 0 });
  }
});

describe("a person's batch is judged op by op, however deep", () => {
  const post = async (op: Op) => {
    const design = await designIn(t, ws, "maya", sampleDoc());
    const headers = ws.people.maya!.headers;
    const { body } = await call(t, headers, "POST", `/v1/designs/${design.id}/ops`, {
      ops: [{ id: "op_batch", op }],
    });
    const doc = await call(t, headers, "GET", `/v1/designs/${design.id}/doc`);
    return { body, doc: doc.body };
  };
  const move = SAMPLE_OPS["artboard.update"];
  const rename = SAMPLE_OPS["page.update"];
  const restyle = SAMPLE_OPS.style;

  test("one made only of what a person may send commits whole", async () => {
    const { body, doc } = await post({ op: "batch", ops: [move, { op: "batch", ops: [rename] }] });

    expect(body).toMatchObject({ rejected: [], seq: 1 });
    expect(doc.doc.pages[0].artboards[0]).toMatchObject({ name: "Landing", x: 40 });
    expect(doc.doc.pages[1]).toMatchObject({ name: "Later" });
  });

  test.each([
    ["last", { op: "batch", ops: [move, rename, restyle] }],
    [
      "nested",
      { op: "batch", ops: [move, { op: "batch", ops: [rename, { op: "batch", ops: [restyle] }] }] },
    ],
  ] as [string, Op][])(
    "one with the agent's op %s is refused, and changes nothing",
    async (_, op) => {
      const { body, doc } = await post(op);

      expect(body).toMatchObject({ committed: [], rejected: [{ id: "op_batch" }], seq: 0 });
      expect(doc).toEqual({ doc: sampleDoc(), seq: 0 });
    },
  );
});
