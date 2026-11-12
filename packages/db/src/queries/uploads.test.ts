import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedCanvas } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { createTestDb } from "../testing.ts";
import { getCanvasHead } from "./canvases.ts";
import {
  advancePreviewSeq,
  completeUpload,
  createUploads,
  getUploads,
  listAssets,
  type NewUpload,
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
