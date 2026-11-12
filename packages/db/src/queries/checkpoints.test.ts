import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { and, eq, lte, sql } from "drizzle-orm";
import { actorFor, agent, rename, seedCanvas } from "../fixtures.ts";
import { canvasCheckpoints, canvasOps } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  OP_RETENTION_DAYS,
  pruneOps,
  readDocSource,
  UNDO_DEPTH,
  writeCheckpoint,
} from "./checkpoints.ts";
import { commitOps, readOps } from "./ops.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** A canvas with `count` renames committed: op n names it `v<n>`. */
async function canvasWithOps(count: number) {
  const seeded = await seedCanvas(db);
  await commitOps(db, {
    canvasId: seeded.canvas.id,
    expectedSeq: 0,
    actor: actorFor(seeded.user),
    ops: Array.from({ length: count }, (_, i) => rename(`op-${i + 1}`, `v${i + 1}`)),
  });
  return seeded.canvas.id;
}

/** Pretend the ops up to `throughSeq` were committed `days` ago. */
const committedDaysAgo = (canvasId: string, throughSeq: number, days: number) =>
  db
    .update(canvasOps)
    .set({ createdAt: sql`now() - make_interval(days => ${days})` })
    .where(and(eq(canvasOps.canvasId, canvasId), lte(canvasOps.seq, throughSeq)));

/** A canvas with `count` ops, all of them older than the retention. */
async function canvasWithOldOps(count: number) {
  const canvasId = await canvasWithOps(count);
  await committedDaysAgo(canvasId, count, OP_RETENTION_DAYS + 1);
  return canvasId;
}

const opSeqs = async (canvasId: string) =>
  (await db.select().from(canvasOps).where(eq(canvasOps.canvasId, canvasId)))
    .map((row) => row.seq)
    .sort((a, b) => a - b);

const checkpointSeqs = async (canvasId: string) =>
  (await db.select().from(canvasCheckpoints).where(eq(canvasCheckpoints.canvasId, canvasId)))
    .map((row) => row.seq)
    .sort((a, b) => a - b);

describe("readDocSource", () => {
  test("a new canvas is its first document and no ops", async () => {
    const { canvas } = await seedCanvas(db);
    expect(await readDocSource(db, canvas.id)).toEqual({
      seq: 0,
      checkpoint: { seq: 0, doc: emptyDoc("Lisbon") },
      ops: [],
    });
  });

  test("returns the latest checkpoint and only the ops after it", async () => {
    const canvasId = await canvasWithOps(5);
    await writeCheckpoint(db, { canvasId, seq: 3, doc: emptyDoc("v3") });

    const source = await readDocSource(db, canvasId);

    expect(source!.seq).toBe(5);
    expect(source!.checkpoint).toEqual({ seq: 3, doc: emptyDoc("v3") });
    expect(source!.ops.map((op) => op.seq)).toEqual([4, 5]);
    expect(source!.ops[0]!.op).toEqual({ op: "file.rename", name: "v4" });
  });

  test("is null for a canvas that does not exist", async () => {
    expect(await readDocSource(db, "cnv_missing")).toBeNull();
  });
});

describe("writeCheckpoint", () => {
  test("replaces the checkpoints before it", async () => {
    const canvasId = await canvasWithOps(10);

    expect(await writeCheckpoint(db, { canvasId, seq: 4, doc: emptyDoc("v4") })).toEqual({
      written: true,
      prunedOps: 0,
    });
    expect(await checkpointSeqs(canvasId)).toEqual([4]);
    await writeCheckpoint(db, { canvasId, seq: 10, doc: emptyDoc("v10") });
    expect(await checkpointSeqs(canvasId)).toEqual([10]);
  });

  test("keeps every op while the canvas is within the undo depth", async () => {
    const canvasId = await canvasWithOps(UNDO_DEPTH);
    const result = await writeCheckpoint(db, { canvasId, seq: UNDO_DEPTH, doc: emptyDoc("x") });
    expect(result).toEqual({ written: true, prunedOps: 0 });
    expect(await opSeqs(canvasId)).toHaveLength(UNDO_DEPTH);
  });

  test("prunes ops the checkpoint covers, but never the newest UNDO_DEPTH", async () => {
    const canvasId = await canvasWithOldOps(UNDO_DEPTH + 60);
    const head = UNDO_DEPTH + 60;

    const result = await writeCheckpoint(db, { canvasId, seq: head, doc: emptyDoc("head") });

    expect(result).toEqual({ written: true, prunedOps: 60 });
    const kept = await opSeqs(canvasId);
    expect(kept[0]).toBe(61);
    expect(kept).toHaveLength(UNDO_DEPTH);
  });

  test("never prunes an op after the checkpoint, however old", async () => {
    const canvasId = await canvasWithOldOps(UNDO_DEPTH + 60);

    // The checkpoint is at 20, so ops 21 to 60 are still needed to rebuild the document.
    const result = await writeCheckpoint(db, { canvasId, seq: 20, doc: emptyDoc("v20") });

    expect(result).toEqual({ written: true, prunedOps: 20 });
    expect((await opSeqs(canvasId))[0]).toBe(21);
    const source = await readDocSource(db, canvasId);
    expect(source!.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: UNDO_DEPTH + 40 }, (_, i) => i + 21),
    );
  });

  test("never prunes an op younger than the retention, so its id still replays", async () => {
    const { canvas, user } = await seedCanvas(db);
    const actor = actorFor(user);
    // A phone posts a rename and loses the response in a tunnel.
    const first = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor,
      ops: [rename("from-the-phone", "Mine")],
    });
    // Minutes later the agent has made 300 ops and a checkpoint covers them all.
    await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 1,
      actor: agent,
      ops: Array.from({ length: 300 }, (_, i) => rename(`agent-${i}`, `v${i}`)),
    });
    const written = await writeCheckpoint(db, {
      canvasId: canvas.id,
      seq: 301,
      doc: emptyDoc("head"),
    });
    expect(written).toEqual({ written: true, prunedOps: 0 });

    const retry = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor,
      ops: [rename("from-the-phone", "Mine")],
    });

    if (first.kind !== "committed") throw new Error("expected a commit");
    expect(retry).toEqual({
      kind: "committed",
      seq: 301,
      ops: first.ops,
      replayed: ["from-the-phone"],
    });
    expect(await opSeqs(canvas.id)).toHaveLength(301);
  });

  test("prunes up to the first op still inside the retention, and no further", async () => {
    const canvasId = await canvasWithOps(UNDO_DEPTH + 60);
    // Ops 1 to 40 are from last week; 41 onwards are from the last few days.
    await committedDaysAgo(canvasId, 40, OP_RETENTION_DAYS + 1);
    await committedDaysAgo(canvasId, 20, OP_RETENTION_DAYS + 3);
    await db
      .update(canvasOps)
      .set({ createdAt: sql`now() - make_interval(days => ${OP_RETENTION_DAYS - 1})` })
      .where(and(eq(canvasOps.canvasId, canvasId), eq(canvasOps.seq, 41)));

    const result = await writeCheckpoint(db, {
      canvasId,
      seq: UNDO_DEPTH + 60,
      doc: emptyDoc("head"),
    });

    expect(result).toEqual({ written: true, prunedOps: 40 });
    expect((await opSeqs(canvasId))[0]).toBe(41);
  });

  test("reading from before the pruned ops says too old; from the edge it works", async () => {
    const canvasId = await canvasWithOldOps(UNDO_DEPTH + 60);
    await writeCheckpoint(db, { canvasId, seq: UNDO_DEPTH + 60, doc: emptyDoc("head") });

    expect(await readOps(db, { canvasId, after: 10 })).toEqual({
      kind: "too_old",
      seq: UNDO_DEPTH + 60,
    });
    expect(await readOps(db, { canvasId, after: 59 })).toMatchObject({ kind: "too_old" });
    const fromEdge = await readOps(db, { canvasId, after: 60, limit: 1 });
    expect(fromEdge).toMatchObject({ kind: "ok", ops: [{ seq: 61 }] });
  });

  test("writes nothing for a seq the canvas has not reached", async () => {
    const canvasId = await canvasWithOps(3);
    const result = await writeCheckpoint(db, { canvasId, seq: 4, doc: emptyDoc("future") });
    expect(result).toEqual({ written: false, prunedOps: 0 });
    expect(await checkpointSeqs(canvasId)).toEqual([0]);
  });

  test("a slow writer cannot replace a newer checkpoint, or write one twice", async () => {
    const canvasId = await canvasWithOps(10);
    await writeCheckpoint(db, { canvasId, seq: 8, doc: emptyDoc("v8") });

    const older = await writeCheckpoint(db, { canvasId, seq: 5, doc: emptyDoc("v5") });
    const again = await writeCheckpoint(db, { canvasId, seq: 8, doc: emptyDoc("other") });

    expect(older).toEqual({ written: false, prunedOps: 0 });
    expect(again).toEqual({ written: false, prunedOps: 0 });
    expect((await readDocSource(db, canvasId))!.checkpoint).toEqual({
      seq: 8,
      doc: emptyDoc("v8"),
    });
  });

  test("writes nothing for a canvas that does not exist", async () => {
    const result = await writeCheckpoint(db, {
      canvasId: "cnv_missing",
      seq: 0,
      doc: emptyDoc("x"),
    });
    expect(result).toEqual({ written: false, prunedOps: 0 });
  });

  test("refuses a document Postgres cannot store, before it sends anything", async () => {
    const canvasId = await canvasWithOps(1);
    const doc = emptyDoc("x");
    doc.notes = { broken: "half a pair \ud83d" };

    await expect(writeCheckpoint(db, { canvasId, seq: 1, doc })).rejects.toThrow("cannot store");
    expect(await checkpointSeqs(canvasId)).toEqual([0]);
  });

  test("keeps the document's key order", async () => {
    const canvasId = await canvasWithOps(1);
    const doc = emptyDoc("ordered");
    doc.notes = { zebra: "1", apple: "2", mango: "3" };

    await writeCheckpoint(db, { canvasId, seq: 1, doc });

    const stored = (await readDocSource(db, canvasId))!.checkpoint.doc;
    expect(Object.keys(stored.notes)).toEqual(["zebra", "apple", "mango"]);
  });
});

describe("pruneOps", () => {
  test("drops what a canvas that stopped changing no longer needs, once it is old enough", async () => {
    const canvasId = await canvasWithOps(UNDO_DEPTH + 60);
    // The last checkpoint was written while every op was still inside the retention.
    const written = await writeCheckpoint(db, {
      canvasId,
      seq: UNDO_DEPTH + 50,
      doc: emptyDoc("v"),
    });
    expect(written).toEqual({ written: true, prunedOps: 0 });
    expect(await pruneOps(db, canvasId)).toBe(0);

    // Eight days later nobody has touched the canvas.
    await committedDaysAgo(canvasId, UNDO_DEPTH + 60, OP_RETENTION_DAYS + 1);

    expect(await pruneOps(db, canvasId)).toBe(60);
    expect(await opSeqs(canvasId)).toHaveLength(UNDO_DEPTH);
    expect(await pruneOps(db, canvasId)).toBe(0);
    // The document can still be rebuilt: everything after the checkpoint is there.
    expect((await readDocSource(db, canvasId))!.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => UNDO_DEPTH + 51 + i),
    );
  });

  test("never drops an op after the latest checkpoint, and is one canvas's", async () => {
    const canvasId = await canvasWithOldOps(UNDO_DEPTH + 60);
    const other = await canvasWithOldOps(UNDO_DEPTH + 60);
    // Put straight into the table, so that nothing has been pruned yet.
    await db
      .insert(canvasCheckpoints)
      .values({ canvasId: other, seq: UNDO_DEPTH + 60, doc: emptyDoc("head") });

    // This canvas's only checkpoint is the one it was created with, at seq 0.
    expect(await pruneOps(db, canvasId)).toBe(0);
    expect(await pruneOps(db, "cnv_missing")).toBe(0);
    expect(await pruneOps(db, other)).toBe(60);

    expect(await opSeqs(canvasId)).toHaveLength(UNDO_DEPTH + 60);
    expect(await opSeqs(other)).toHaveLength(UNDO_DEPTH);
  });
});
