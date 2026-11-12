import { afterAll, beforeAll, expect, test } from "bun:test";
import { applyOp, type Doc } from "@ponzu/core";
import { sampleDoc } from "@ponzu/core/fixtures";
import { readDocSource } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import {
  call,
  canvasIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", leo: "write", ines: "read" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;

/** A canvas three hands have touched, in turn: Maya moves the board, the agent restyles, Leo renames a page. */
async function touched() {
  const canvas = await canvasIn(t, ws, "maya", sampleDoc());
  const runner = await runnerHeaders(t, canvas.id);
  const post = (headers: Record<string, string>, id: string, op: unknown) =>
    call(t, headers, "POST", `/v1/canvases/${canvas.id}/ops`, { ops: [{ id, op }] });
  await post(as("maya"), "op_maya", { op: "artboard.update", id: "ab_1", x: 100 });
  await post(runner, "op_agent", { op: "style", id: "n_1", style: { color: "red" } });
  await post(as("leo"), "op_leo", { op: "page.update", id: "pg_2", name: "Leo's" });
  const act = (headers: Record<string, string>, kind: "undo" | "redo") =>
    call(t, headers, "POST", `/v1/canvases/${canvas.id}/${kind}`);
  return { canvas, runner, act };
}

async function current(canvasId: string): Promise<Doc> {
  const source = (await readDocSource(t.db, canvasId))!;
  for (const stored of source.ops) applyOp(source.checkpoint.doc, stored.op);
  return source.checkpoint.doc;
}

const board = (doc: Doc) => doc.pages[0]!.artboards[0]!;

test("undo takes back the newest of the caller's and the agent's ops, never another person's", async () => {
  const { canvas, act } = await touched();

  const first = await act(as("maya"), "undo");

  expect(first.status).toBe(200);
  expect(first.body).toEqual({
    committed: {
      seq: 4,
      id: expect.stringMatching(/^op_/),
      op: { op: "style", id: "n_1", style: {} },
      actor: expect.objectContaining({ kind: "user", id: ws.people.maya!.userId }),
      at: expect.any(String),
    },
    seq: 4,
  });
  const second = await act(as("maya"), "undo");
  expect(second.body.committed.op).toEqual({ op: "artboard.update", id: "ab_1", x: 0 });

  const doc = await current(canvas.id);
  expect(board(doc).x).toBe(0);
  expect(board(doc).root.children[0]).toMatchObject({ id: "n_1", style: {} });
  // Leo's rename stands.
  expect(doc.pages[1]!.name).toBe("Leo's");
  const third = await act(as("maya"), "undo");
  expect([third.status, third.body.error.code]).toEqual([409, "nothing_to_undo"]);
});

test("redo takes back the caller's newest undo, and comes back through the log like any op", async () => {
  const { canvas, act } = await touched();
  await act(as("leo"), "undo");

  const redone = await act(as("leo"), "redo");

  expect(redone.body.committed).toMatchObject({ seq: 5, op: { op: "page.update", name: "Leo's" } });
  const ops = await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/ops?after=3`);
  expect(ops.body.ops.map((op: any) => op.op.op)).toEqual(["page.update", "page.update"]);
  const again = await act(as("leo"), "redo");
  expect([again.status, again.body.error.code]).toEqual([409, "nothing_to_redo"]);
  // Maya never undid anything, so she has nothing to redo either.
  expect((await act(as("maya"), "redo")).status).toBe(409);
});

test("the agent undoes its own ops and redoes its undo", async () => {
  const { canvas, act, runner } = await touched();

  const undone = await act(runner, "undo");
  const redone = await act(runner, "redo");

  expect(undone.body.committed).toMatchObject({
    op: { op: "style", id: "n_1" },
    actor: { kind: "agent" },
  });
  expect(redone.body.committed.op).toEqual({ op: "style", id: "n_1", style: { color: "red" } });
  expect(board(await current(canvas.id)).root.children[0]).toMatchObject({
    style: { color: "red" },
  });
});

test("an op whose inverse no longer applies is passed over", async () => {
  const canvas = await canvasIn(t, ws, "maya", sampleDoc());
  const post = (headers: Record<string, string>, id: string, op: unknown) =>
    call(t, headers, "POST", `/v1/canvases/${canvas.id}/ops`, { ops: [{ id, op }] });
  await post(as("maya"), "op_page", { op: "page.update", id: "pg_2", name: "Mine" });
  await post(as("maya"), "op_move", { op: "artboard.update", id: "ab_1", x: 100 });
  // Leo deletes the board Maya moved: putting it back where it was cannot apply.
  await post(as("leo"), "op_delete", { op: "artboard.delete", id: "ab_1" });

  const undone = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/undo`);

  expect(undone.body.committed.op).toEqual({ op: "page.update", id: "pg_2", name: "Second" });
});

test("a person's undo is news to the agent; someone who may only look cannot undo", async () => {
  const { canvas, act } = await touched();
  const before = (await feedOf(t.db, canvas.id)).length;

  await act(as("maya"), "undo");
  const reader = await act(as("ines"), "undo");

  expect((await feedOf(t.db, canvas.id)).slice(before).map((e) => [e.kind, e.priority])).toEqual([
    ["edit", "later"],
  ]);
  expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
});
