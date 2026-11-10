import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { and, eq, lte, sql } from "drizzle-orm";
import { actorFor, agent, rename, seedDesign } from "../fixtures.ts";
import { designCheckpoints, designOps } from "../schema/index.ts";
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

/** A design with `count` renames committed: op n names it `v<n>`. */
async function designWithOps(count: number) {
  const seeded = await seedDesign(db);
  await commitOps(db, {
    designId: seeded.design.id,
    expectedSeq: 0,
    actor: actorFor(seeded.user),
    ops: Array.from({ length: count }, (_, i) => rename(`op-${i + 1}`, `v${i + 1}`)),
  });
  return seeded.design.id;
}

/** Pretend the ops up to `throughSeq` were committed `days` ago. */
const committedDaysAgo = (designId: string, throughSeq: number, days: number) =>
  db
    .update(designOps)
    .set({ createdAt: sql`now() - make_interval(days => ${days})` })
    .where(and(eq(designOps.designId, designId), lte(designOps.seq, throughSeq)));

/** A design with `count` ops, all of them older than the retention. */
async function designWithOldOps(count: number) {
  const designId = await designWithOps(count);
  await committedDaysAgo(designId, count, OP_RETENTION_DAYS + 1);
  return designId;
}

const opSeqs = async (designId: string) =>
  (await db.select().from(designOps).where(eq(designOps.designId, designId)))
    .map((row) => row.seq)
    .sort((a, b) => a - b);

const checkpointSeqs = async (designId: string) =>
  (await db.select().from(designCheckpoints).where(eq(designCheckpoints.designId, designId)))
    .map((row) => row.seq)
    .sort((a, b) => a - b);

describe("readDocSource", () => {
  test("a new design is its first document and no ops", async () => {
    const { design } = await seedDesign(db);
    expect(await readDocSource(db, design.id)).toEqual({
      seq: 0,
      checkpoint: { seq: 0, doc: emptyDoc("Lisbon") },
      ops: [],
    });
  });

  test("returns the latest checkpoint and only the ops after it", async () => {
    const designId = await designWithOps(5);
    await writeCheckpoint(db, { designId, seq: 3, doc: emptyDoc("v3") });

    const source = await readDocSource(db, designId);

    expect(source!.seq).toBe(5);
    expect(source!.checkpoint).toEqual({ seq: 3, doc: emptyDoc("v3") });
    expect(source!.ops.map((op) => op.seq)).toEqual([4, 5]);
    expect(source!.ops[0]!.op).toEqual({ op: "file.rename", name: "v4" });
  });

  test("is null for a design that does not exist", async () => {
    expect(await readDocSource(db, "des_missing")).toBeNull();
  });
});

describe("writeCheckpoint", () => {
  test("replaces the checkpoints before it", async () => {
    const designId = await designWithOps(10);

    expect(await writeCheckpoint(db, { designId, seq: 4, doc: emptyDoc("v4") })).toEqual({
      written: true,
      prunedOps: 0,
    });
    expect(await checkpointSeqs(designId)).toEqual([4]);
    await writeCheckpoint(db, { designId, seq: 10, doc: emptyDoc("v10") });
    expect(await checkpointSeqs(designId)).toEqual([10]);
  });

  test("keeps every op while the design is within the undo depth", async () => {
    const designId = await designWithOps(UNDO_DEPTH);
    const result = await writeCheckpoint(db, { designId, seq: UNDO_DEPTH, doc: emptyDoc("x") });
    expect(result).toEqual({ written: true, prunedOps: 0 });
    expect(await opSeqs(designId)).toHaveLength(UNDO_DEPTH);
  });

  test("prunes ops the checkpoint covers, but never the newest UNDO_DEPTH", async () => {
    const designId = await designWithOldOps(UNDO_DEPTH + 60);
    const head = UNDO_DEPTH + 60;

    const result = await writeCheckpoint(db, { designId, seq: head, doc: emptyDoc("head") });

    expect(result).toEqual({ written: true, prunedOps: 60 });
    const kept = await opSeqs(designId);
    expect(kept[0]).toBe(61);
    expect(kept).toHaveLength(UNDO_DEPTH);
  });

  test("never prunes an op after the checkpoint, however old", async () => {
    const designId = await designWithOldOps(UNDO_DEPTH + 60);

    // The checkpoint is at 20, so ops 21 to 60 are still needed to rebuild the document.
    const result = await writeCheckpoint(db, { designId, seq: 20, doc: emptyDoc("v20") });

    expect(result).toEqual({ written: true, prunedOps: 20 });
    expect((await opSeqs(designId))[0]).toBe(21);
    const source = await readDocSource(db, designId);
    expect(source!.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: UNDO_DEPTH + 40 }, (_, i) => i + 21),
    );
  });

  test("never prunes an op younger than the retention, so its id still replays", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    // A phone posts a rename and loses the response in a tunnel.
    const first = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("from-the-phone", "Mine")],
    });
    // Minutes later the agent has made 300 ops and a checkpoint covers them all.
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 1,
      actor: agent,
      ops: Array.from({ length: 300 }, (_, i) => rename(`agent-${i}`, `v${i}`)),
    });
    const written = await writeCheckpoint(db, {
      designId: design.id,
      seq: 301,
      doc: emptyDoc("head"),
    });
    expect(written).toEqual({ written: true, prunedOps: 0 });

    const retry = await commitOps(db, {
      designId: design.id,
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
    expect(await opSeqs(design.id)).toHaveLength(301);
  });

  test("prunes up to the first op still inside the retention, and no further", async () => {
    const designId = await designWithOps(UNDO_DEPTH + 60);
    // Ops 1 to 40 are from last week; 41 onwards are from the last few days.
    await committedDaysAgo(designId, 40, OP_RETENTION_DAYS + 1);
    await committedDaysAgo(designId, 20, OP_RETENTION_DAYS + 3);
    await db
      .update(designOps)
      .set({ createdAt: sql`now() - make_interval(days => ${OP_RETENTION_DAYS - 1})` })
      .where(and(eq(designOps.designId, designId), eq(designOps.seq, 41)));

    const result = await writeCheckpoint(db, {
      designId,
      seq: UNDO_DEPTH + 60,
      doc: emptyDoc("head"),
    });

    expect(result).toEqual({ written: true, prunedOps: 40 });
    expect((await opSeqs(designId))[0]).toBe(41);
  });

  test("reading from before the pruned ops says too old; from the edge it works", async () => {
    const designId = await designWithOldOps(UNDO_DEPTH + 60);
    await writeCheckpoint(db, { designId, seq: UNDO_DEPTH + 60, doc: emptyDoc("head") });

    expect(await readOps(db, { designId, after: 10 })).toEqual({
      kind: "too_old",
      seq: UNDO_DEPTH + 60,
    });
    expect(await readOps(db, { designId, after: 59 })).toMatchObject({ kind: "too_old" });
    const fromEdge = await readOps(db, { designId, after: 60, limit: 1 });
    expect(fromEdge).toMatchObject({ kind: "ok", ops: [{ seq: 61 }] });
  });

  test("writes nothing for a seq the design has not reached", async () => {
    const designId = await designWithOps(3);
    const result = await writeCheckpoint(db, { designId, seq: 4, doc: emptyDoc("future") });
    expect(result).toEqual({ written: false, prunedOps: 0 });
    expect(await checkpointSeqs(designId)).toEqual([0]);
  });

  test("a slow writer cannot replace a newer checkpoint, or write one twice", async () => {
    const designId = await designWithOps(10);
    await writeCheckpoint(db, { designId, seq: 8, doc: emptyDoc("v8") });

    const older = await writeCheckpoint(db, { designId, seq: 5, doc: emptyDoc("v5") });
    const again = await writeCheckpoint(db, { designId, seq: 8, doc: emptyDoc("other") });

    expect(older).toEqual({ written: false, prunedOps: 0 });
    expect(again).toEqual({ written: false, prunedOps: 0 });
    expect((await readDocSource(db, designId))!.checkpoint).toEqual({
      seq: 8,
      doc: emptyDoc("v8"),
    });
  });

  test("writes nothing for a design that does not exist", async () => {
    const result = await writeCheckpoint(db, {
      designId: "des_missing",
      seq: 0,
      doc: emptyDoc("x"),
    });
    expect(result).toEqual({ written: false, prunedOps: 0 });
  });

  test("refuses a document Postgres cannot store, before it sends anything", async () => {
    const designId = await designWithOps(1);
    const doc = emptyDoc("x");
    doc.notes = { broken: "half a pair \ud83d" };

    await expect(writeCheckpoint(db, { designId, seq: 1, doc })).rejects.toThrow("cannot store");
    expect(await checkpointSeqs(designId)).toEqual([0]);
  });

  test("keeps the document's key order", async () => {
    const designId = await designWithOps(1);
    const doc = emptyDoc("ordered");
    doc.notes = { zebra: "1", apple: "2", mango: "3" };

    await writeCheckpoint(db, { designId, seq: 1, doc });

    const stored = (await readDocSource(db, designId))!.checkpoint.doc;
    expect(Object.keys(stored.notes)).toEqual(["zebra", "apple", "mango"]);
  });
});

describe("pruneOps", () => {
  test("drops what a design that stopped changing no longer needs, once it is old enough", async () => {
    const designId = await designWithOps(UNDO_DEPTH + 60);
    // The last checkpoint was written while every op was still inside the retention.
    const written = await writeCheckpoint(db, {
      designId,
      seq: UNDO_DEPTH + 50,
      doc: emptyDoc("v"),
    });
    expect(written).toEqual({ written: true, prunedOps: 0 });
    expect(await pruneOps(db, designId)).toBe(0);

    // Eight days later nobody has touched the design.
    await committedDaysAgo(designId, UNDO_DEPTH + 60, OP_RETENTION_DAYS + 1);

    expect(await pruneOps(db, designId)).toBe(60);
    expect(await opSeqs(designId)).toHaveLength(UNDO_DEPTH);
    expect(await pruneOps(db, designId)).toBe(0);
    // The document can still be rebuilt: everything after the checkpoint is there.
    expect((await readDocSource(db, designId))!.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => UNDO_DEPTH + 51 + i),
    );
  });

  test("never drops an op after the latest checkpoint, and is one design's", async () => {
    const designId = await designWithOldOps(UNDO_DEPTH + 60);
    const other = await designWithOldOps(UNDO_DEPTH + 60);
    // Put straight into the table, so that nothing has been pruned yet.
    await db
      .insert(designCheckpoints)
      .values({ designId: other, seq: UNDO_DEPTH + 60, doc: emptyDoc("head") });

    // This design's only checkpoint is the one it was created with, at seq 0.
    expect(await pruneOps(db, designId)).toBe(0);
    expect(await pruneOps(db, "des_missing")).toBe(0);
    expect(await pruneOps(db, other)).toBe(60);

    expect(await opSeqs(designId)).toHaveLength(UNDO_DEPTH + 60);
    expect(await opSeqs(other)).toHaveLength(UNDO_DEPTH);
  });
});
