import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedCanvas } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { createTestDb } from "../testing.ts";
import { deleteCanvas, getCanvasHead } from "./canvases.ts";
import { recordCheckpoint, takeRunnerLease } from "./runners.ts";
import {
  advancePreviewSeq,
  completeUpload,
  createUploads,
  getUploads,
  listAssets,
  type NewUpload,
  recordedArchiveKeys,
} from "./uploads.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const upload = (canvasId: string, over: Partial<NewUpload> = {}): NewUpload => ({
  id: newId("up"),
  canvasId,
  purpose: "asset",
  name: "logo.png",
  objectKey: "key/uploads/logo.png",
  contentType: "image/png",
  size: 1234,
  sha256: "ab".repeat(32),
  userId: null,
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});

test("an upload is found by its canvas and id only", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  const [made] = await createUploads(db, [upload(one.canvas.id)]);

  expect(await getUploads(db, { canvasId: one.canvas.id, ids: [made!.id] })).toEqual([made!]);
  expect(await getUploads(db, { canvasId: other.canvas.id, ids: [made!.id] })).toEqual([]);
  expect(made).toMatchObject({ completedAt: null, servedKey: null });
});

test("completing an asset records the file, once, and replaces one at the same path", async () => {
  const { canvas, user } = await seedCanvas(db);
  const [first, second] = await createUploads(db, [
    upload(canvas.id),
    upload(canvas.id, { size: 99, userId: user.id, sha256: "cd".repeat(32) }),
  ]);
  const complete = (id: string) =>
    completeUpload(db, {
      canvasId: canvas.id,
      id,
      servedKey: "key/assets/logo.png",
      asset: { path: "assets/logo.png" },
    });

  expect(await complete(first!.id)).toMatchObject({ servedKey: "key/assets/logo.png" });
  expect(await complete(first!.id)).toBeNull();
  await complete(second!.id);

  expect(
    await listAssets(db, { canvasId: canvas.id, paths: ["assets/logo.png", "assets/x"] }),
  ).toMatchObject([
    { path: "assets/logo.png", size: 99, sha256: "cd".repeat(32), createdByUserId: user.id },
  ]);
});

test("completing another canvas's upload does nothing", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  const [made] = await createUploads(db, [upload(one.canvas.id, { purpose: "export" })]);

  expect(
    await completeUpload(db, { canvasId: other.canvas.id, id: made!.id, servedKey: "x" }),
  ).toBeNull();
  expect(
    (await getUploads(db, { canvasId: one.canvas.id, ids: [made!.id] }))[0]!.completedAt,
  ).toBeNull();
});

test("previews only move forward, and say which ones they replaced", async () => {
  const { canvas } = await seedCanvas(db);

  expect(await advancePreviewSeq(db, { canvasId: canvas.id, seq: 4 })).toEqual({ previous: null });
  expect(await advancePreviewSeq(db, { canvasId: canvas.id, seq: 9 })).toEqual({ previous: 4 });
  expect(await advancePreviewSeq(db, { canvasId: canvas.id, seq: 9 })).toBeUndefined();
  expect(await advancePreviewSeq(db, { canvasId: canvas.id, seq: 7 })).toBeUndefined();
  expect((await getCanvasHead(db, canvas.id))!.previewSeq).toBe(9);
});

test("an archive is recorded only while its canvas's checkpoint names it", async () => {
  const { canvas } = await seedCanvas(db);
  const other = await seedCanvas(db);
  const archive = (canvasId: string, purpose: "session" | "workspace", name: string) =>
    upload(canvasId, {
      purpose,
      name: `${purpose}.tar.gz`,
      objectKey: `private/${name}/${purpose}.tar.gz`,
      contentType: "application/gzip",
    });
  const [session1, workspace1, session2, never] = await createUploads(db, [
    archive(canvas.id, "session", "s1"),
    archive(canvas.id, "workspace", "w1"),
    archive(canvas.id, "session", "s2"),
    archive(canvas.id, "session", "never"),
  ]);
  // Another canvas's upload with the same id is not this canvas's archive.
  await createUploads(db, [{ ...archive(other.canvas.id, "session", "theirs"), id: session1!.id }]);
  const keys = [session1, workspace1, session2, never].map((row) => row!.objectKey);
  const theirs = "private/theirs/session.tar.gz";
  const all = [...keys, theirs, "private/nothing/at.tar.gz"];

  // No checkpoint yet: nothing is recorded.
  expect(await recordedArchiveKeys(db, all)).toEqual(new Set());
  expect(await recordedArchiveKeys(db, [])).toEqual(new Set());

  const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
  const save = (turn: number, sessionUploadId: string | null, workspaceUploadId: string | null) =>
    recordCheckpoint(db, {
      canvasId: canvas.id,
      runnerId,
      now: new Date(1_000 + turn),
      turn,
      claudeSessionId: "sess-1",
      wipCommit: null,
      sessionUploadId,
      workspaceUploadId,
    });
  await save(1, session1!.id, workspace1!.id);
  expect(await recordedArchiveKeys(db, all)).toEqual(new Set([keys[0]!, keys[1]!]));

  // A later checkpoint replaces the transcript and keeps the work in progress.
  await save(2, session2!.id, workspace1!.id);
  expect(await recordedArchiveKeys(db, all)).toEqual(new Set([keys[1]!, keys[2]!]));
  // Only the keys asked about are answered.
  expect(await recordedArchiveKeys(db, [keys[2]!, theirs])).toEqual(new Set([keys[2]!]));

  // With the canvas gone, nothing of it is recorded.
  await deleteCanvas(db, canvas.id);
  expect(await recordedArchiveKeys(db, all)).toEqual(new Set());
});
