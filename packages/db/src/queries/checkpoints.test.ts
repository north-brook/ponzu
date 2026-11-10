import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { actorFor, rename, seedDesign } from "../fixtures.ts";
import { designCheckpoints, designOps } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { readDocSource, UNDO_DEPTH, writeCheckpoint } from "./checkpoints.ts";
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
    const designId = await designWithOps(UNDO_DEPTH + 60);
    const head = UNDO_DEPTH + 60;

    const result = await writeCheckpoint(db, { designId, seq: head, doc: emptyDoc("head") });

    expect(result).toEqual({ written: true, prunedOps: 60 });
    const kept = await opSeqs(designId);
    expect(kept[0]).toBe(61);
    expect(kept).toHaveLength(UNDO_DEPTH);
  });

  test("never prunes an op after the checkpoint, however old", async () => {
    const designId = await designWithOps(UNDO_DEPTH + 60);

    // The checkpoint is at 20, so ops 21 to 60 are still needed to rebuild the document.
    const result = await writeCheckpoint(db, { designId, seq: 20, doc: emptyDoc("v20") });

    expect(result).toEqual({ written: true, prunedOps: 20 });
    expect((await opSeqs(designId))[0]).toBe(21);
    const source = await readDocSource(db, designId);
    expect(source!.ops.map((op) => op.seq)).toEqual(
      Array.from({ length: UNDO_DEPTH + 40 }, (_, i) => i + 21),
    );
  });

  test("reading from before the pruned ops says too old; from the edge it works", async () => {
    const designId = await designWithOps(UNDO_DEPTH + 60);
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

  test("keeps the document's key order", async () => {
    const designId = await designWithOps(1);
    const doc = emptyDoc("ordered");
    doc.notes = { zebra: "1", apple: "2", mango: "3" };

    await writeCheckpoint(db, { designId, seq: 1, doc });

    const stored = (await readDocSource(db, designId))!.checkpoint.doc;
    expect(Object.keys(stored.notes)).toEqual(["zebra", "apple", "mango"]);
  });
});
