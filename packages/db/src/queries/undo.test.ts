import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actorFor, agent, rename, seedCanvas, seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { getCanvas } from "./canvases.ts";
import { UNDO_DEPTH } from "./checkpoints.ts";
import { type Actor, commitOps, type NewOp, readOps, type StoredOp } from "./ops.ts";
import { commitReversal, nextRedo, nextUndo } from "./undo.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** A canvas and the moves a test makes on it, each at the canvas's current seq. */
async function session() {
  const { canvas, user } = await seedCanvas(db);
  const canvasId = canvas.id;
  const me = actorFor(user);
  const seq = async () => (await getCanvas(db, canvasId))!.seq;
  let made = 0;

  const act = async (actor: Actor, name: string) => {
    const result = await commitOps(db, {
      canvasId,
      expectedSeq: await seq(),
      actor,
      ops: [rename(`op-${++made}`, name)],
    });
    if (result.kind !== "committed") throw new Error("expected a commit");
    return result.ops[0]!;
  };
  // What the API does: apply the target's inverse, which makes the target's op the new inverse.
  const reversalOf = (target: StoredOp): NewOp => ({
    id: `op-${++made}`,
    op: target.inverse,
    inverse: target.op,
  });
  const undo = async (actor: Actor) => {
    const target = await nextUndo(db, { canvasId, actorId: actor.id });
    if (!target) return null;
    return commitReversal(db, {
      canvasId,
      expectedSeq: await seq(),
      actor,
      kind: "undo",
      reverses: target.seq,
      op: reversalOf(target),
    });
  };
  const redo = async (actor: Actor) => {
    const target = await nextRedo(db, { canvasId, actorId: actor.id });
    if (!target) return null;
    return commitReversal(db, {
      canvasId,
      expectedSeq: await seq(),
      actor,
      kind: "redo",
      reverses: target.seq,
      op: reversalOf(target),
    });
  };
  const log = async () => {
    const read = await readOps(db, { canvasId, after: 0 });
    if (read?.kind !== "ok") throw new Error("expected ops");
    return read.ops;
  };
  return { canvasId, me, seq, act, undo, redo, log, reversalOf };
}

describe("undo", () => {
  test("takes back the caller's newest op and marks it", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.act(s.me, "Two");

    const result = await s.undo(s.me);

    if (result?.kind !== "committed") throw new Error("expected a commit");
    expect(result.ops[0]).toMatchObject({
      seq: 3,
      kind: "undo",
      reverses: 2,
      op: { op: "file.rename", name: "Lisbon" },
      inverse: { op: "file.rename", name: "Two" },
    });
    const log = await s.log();
    expect(log.map((op) => op.reversedBy)).toEqual([null, 3, null]);
  });

  test("walks back one op at a time and stops at the start", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.act(s.me, "Two");

    expect(await s.undo(s.me)).toMatchObject({ ops: [{ reverses: 2 }] });
    expect(await s.undo(s.me)).toMatchObject({ ops: [{ reverses: 1 }] });
    expect(await s.undo(s.me)).toBeNull();
  });

  test("reaches the agent's ops but not another person's", async () => {
    const s = await session();
    const teammate = actorFor(await seedUser(db, "maya"));
    await s.act(s.me, "Mine");
    await s.act(agent, "The agent's");
    await s.act(teammate, "Maya's");

    expect(await nextUndo(db, { canvasId: s.canvasId, actorId: s.me.id })).toMatchObject({
      seq: 2,
    });
    expect(await nextUndo(db, { canvasId: s.canvasId, actorId: teammate.id })).toMatchObject({
      seq: 3,
    });
    // The agent undoes only its own.
    expect(await nextUndo(db, { canvasId: s.canvasId, actorId: agent.id })).toMatchObject({
      seq: 2,
    });
  });

  test("olderThan skips an op that can no longer be taken back", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.act(s.me, "Two");

    const skipped = await nextUndo(db, { canvasId: s.canvasId, actorId: s.me.id, olderThan: 2 });

    expect(skipped).toMatchObject({ seq: 1 });
  });

  test("does not reach past the undo depth", async () => {
    const s = await session();
    const teammate = actorFor(await seedUser(db, "maya"));
    await s.act(s.me, "Mine, long ago");
    await commitOps(db, {
      canvasId: s.canvasId,
      expectedSeq: 1,
      actor: teammate,
      ops: Array.from({ length: UNDO_DEPTH - 1 }, (_, i) => rename(`maya-${i}`, `m${i}`)),
    });
    expect(await nextUndo(db, { canvasId: s.canvasId, actorId: s.me.id })).toMatchObject({
      seq: 1,
    });

    await s.act(teammate, "One more");

    expect(await nextUndo(db, { canvasId: s.canvasId, actorId: s.me.id })).toBeNull();
  });

  test("the same op cannot be taken back twice", async () => {
    const s = await session();
    const target = await s.act(s.me, "One");
    const reversal = (id: string, expectedSeq: number) =>
      commitReversal(db, {
        canvasId: s.canvasId,
        expectedSeq,
        actor: s.me,
        kind: "undo",
        reverses: target.seq,
        op: { ...s.reversalOf(target), id },
      });

    expect(await reversal("first", 1)).toMatchObject({ kind: "committed", seq: 2 });
    // The second caller read the target before the first undo landed, and the seq after it.
    expect(await reversal("second", 2)).toEqual({ kind: "conflict" });
    expect(await s.seq()).toBe(2);
  });

  test("two undos of one op racing: one lands", async () => {
    const s = await session();
    const target = await s.act(s.me, "One");
    const reversal = (id: string) =>
      commitReversal(db, {
        canvasId: s.canvasId,
        expectedSeq: 1,
        actor: s.me,
        kind: "undo",
        reverses: target.seq,
        op: { ...s.reversalOf(target), id },
      });

    const results = await Promise.all([reversal("first"), reversal("second")]);

    expect(results.map((result) => result.kind).sort()).toEqual(["committed", "conflict"]);
    expect((await s.log()).map((op) => op.kind)).toEqual(["do", "undo"]);
  });

  test("an undo names an op that is there to take back", async () => {
    const s = await session();
    const done = await s.act(s.me, "One");
    const attempt = (kind: "undo" | "redo", reverses: number) =>
      commitReversal(db, {
        canvasId: s.canvasId,
        expectedSeq: 1,
        actor: s.me,
        kind,
        reverses,
        op: { ...s.reversalOf(done), id: `${kind}-${reverses}` },
      });

    // A redo takes back an undo, never a do; and seq 7 does not exist.
    expect(await attempt("redo", done.seq)).toEqual({ kind: "conflict" });
    expect(await attempt("undo", 7)).toEqual({ kind: "conflict" });
    expect(await s.seq()).toBe(1);
  });
});

describe("redo", () => {
  test("takes back the caller's newest undo, newest first", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.act(s.me, "Two");
    await s.undo(s.me); // seq 3 takes back 2
    await s.undo(s.me); // seq 4 takes back 1

    const first = await s.redo(s.me);
    const second = await s.redo(s.me);

    expect(first).toMatchObject({
      ops: [{ seq: 5, kind: "redo", reverses: 4, op: { op: "file.rename", name: "One" } }],
    });
    expect(second).toMatchObject({
      ops: [{ seq: 6, kind: "redo", reverses: 3, op: { op: "file.rename", name: "Two" } }],
    });
    expect(await s.redo(s.me)).toBeNull();
    expect((await s.log()).map((op) => op.reversedBy)).toEqual([4, 3, 6, 5, null, null]);
  });

  test("a redo can be undone again", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.undo(s.me); // seq 2
    await s.redo(s.me); // seq 3

    const again = await s.undo(s.me);

    expect(again).toMatchObject({ ops: [{ seq: 4, kind: "undo", reverses: 3 }] });
    expect(await s.undo(s.me)).toBeNull();
  });

  test("a new op ends the chance to redo", async () => {
    const s = await session();
    await s.act(s.me, "One");
    await s.undo(s.me);
    expect(await nextRedo(db, { canvasId: s.canvasId, actorId: s.me.id })).not.toBeNull();

    await s.act(s.me, "Something else");

    expect(await s.redo(s.me)).toBeNull();
  });

  test("so does a new op by the agent, but not one by a teammate", async () => {
    const s = await session();
    const teammate = actorFor(await seedUser(db, "maya"));
    await s.act(s.me, "One");
    await s.undo(s.me);

    await s.act(teammate, "Maya's");
    expect(await nextRedo(db, { canvasId: s.canvasId, actorId: s.me.id })).toMatchObject({
      seq: 2,
    });

    await s.act(agent, "The agent's");
    expect(await nextRedo(db, { canvasId: s.canvasId, actorId: s.me.id })).toBeNull();
  });

  test("is the caller's own: nobody redoes someone else's undo", async () => {
    const s = await session();
    const teammate = actorFor(await seedUser(db, "maya"));
    await s.act(s.me, "One");
    await s.undo(s.me);

    expect(await s.redo(teammate)).toBeNull();
  });
});
