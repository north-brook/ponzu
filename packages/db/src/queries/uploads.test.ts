import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDesign } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { createTestDb } from "../testing.ts";
import { getDesignHead } from "./designs.ts";
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

const upload = (designId: string, over: Partial<NewUpload> = {}): NewUpload => ({
  id: newId("up"),
  designId,
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

test("an upload is found by its design and id only", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const [made] = await createUploads(db, [upload(one.design.id)]);

  expect(await getUploads(db, { designId: one.design.id, ids: [made!.id] })).toEqual([made!]);
  expect(await getUploads(db, { designId: other.design.id, ids: [made!.id] })).toEqual([]);
  expect(made).toMatchObject({ completedAt: null, servedKey: null });
});

test("completing an asset records the file, once, and replaces one at the same path", async () => {
  const { design, user } = await seedDesign(db);
  const [first, second] = await createUploads(db, [
    upload(design.id),
    upload(design.id, { size: 99, userId: user.id, sha256: "cd".repeat(32) }),
  ]);
  const complete = (id: string) =>
    completeUpload(db, {
      designId: design.id,
      id,
      servedKey: "key/assets/logo.png",
      asset: { path: "assets/logo.png" },
    });

  expect(await complete(first!.id)).toMatchObject({ servedKey: "key/assets/logo.png" });
  expect(await complete(first!.id)).toBeNull();
  await complete(second!.id);

  expect(
    await listAssets(db, { designId: design.id, paths: ["assets/logo.png", "assets/x"] }),
  ).toMatchObject([
    { path: "assets/logo.png", size: 99, sha256: "cd".repeat(32), createdByUserId: user.id },
  ]);
});

test("completing another design's upload does nothing", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const [made] = await createUploads(db, [upload(one.design.id, { purpose: "export" })]);

  expect(
    await completeUpload(db, { designId: other.design.id, id: made!.id, servedKey: "x" }),
  ).toBeNull();
  expect(
    (await getUploads(db, { designId: one.design.id, ids: [made!.id] }))[0]!.completedAt,
  ).toBeNull();
});

test("previews only move forward, and say which ones they replaced", async () => {
  const { design } = await seedDesign(db);

  expect(await advancePreviewSeq(db, { designId: design.id, seq: 4 })).toEqual({ previous: null });
  expect(await advancePreviewSeq(db, { designId: design.id, seq: 9 })).toEqual({ previous: 4 });
  expect(await advancePreviewSeq(db, { designId: design.id, seq: 9 })).toBeUndefined();
  expect(await advancePreviewSeq(db, { designId: design.id, seq: 7 })).toBeUndefined();
  expect((await getDesignHead(db, design.id))!.previewSeq).toBe(9);
});
