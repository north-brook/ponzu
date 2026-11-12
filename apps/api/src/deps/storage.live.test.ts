// The real bucket, through the API's own routes: presign, PUT, complete, GET through the public
// URL, then delete; and a list and bulk delete under a fresh asset key. Skipped unless
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and PONZU_ASSETS_URL (the
// bucket's public URL) are set.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emptyDoc } from "@ponzu/core";
import { getCanvasAssetKey, newAssetKey } from "@ponzu/db";
import { systemClock } from "@ponzu/sandbox";
import { deleteUnder } from "../canvases/files.ts";
import { call, canvasWithRunner, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp } from "../testing/index.ts";
import { createR2Storage } from "./storage.ts";

const env = process.env;
const configured =
  env.R2_ACCOUNT_ID &&
  env.R2_ACCESS_KEY_ID &&
  env.R2_SECRET_ACCESS_KEY &&
  env.R2_BUCKET &&
  env.PONZU_ASSETS_URL;

describe.skipIf(!configured)("R2, for real", () => {
  const storage = createR2Storage({
    accountId: env.R2_ACCOUNT_ID ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: env.R2_BUCKET ?? "",
    fetch: (url, init) => fetch(url, init),
    clock: systemClock,
  });
  const assetsUrl = (env.PONZU_ASSETS_URL ?? "").replace(/\/+$/, "");
  const made: string[] = [];
  let close = async () => {};
  afterAll(async () => {
    await Promise.all(made.map((key) => storage.delete(key)));
    await close();
  });

  test("an upload goes up at its signed address, is completed, served publicly and deleted", async () => {
    const t = await createTestApp({ storage, assetsUrl });
    close = t.close;
    const ws = await workspaceWithRepo(t, { maya: "write" });
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", emptyDoc("Live"));
    const assetKey = (await getCanvasAssetKey(t.db, canvas.id))!;
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    );
    const preview = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const declared = (purpose: string, name: string, contentType: string, bytes: Uint8Array) => ({
      purpose,
      name,
      contentType,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    made.push(`${assetKey}/assets/icon.svg`, `${assetKey}/previews/0-light.png`);

    const signed = await call(t, runner.headers, "POST", "/v1/runner/uploads", {
      files: [
        declared("asset", "icon.svg", "image/svg+xml", svg),
        declared("preview", "light.png", "image/png", preview),
      ],
    });
    expect(signed.status).toBe(200);
    const [asset, picture] = signed.body.files;
    made.push(`staging/${picture.id}-light.png`);
    for (const [file, bytes] of [
      [asset, svg],
      [picture, preview],
    ] as const) {
      const put = await fetch(file.put.url, {
        method: "PUT",
        headers: file.put.headers,
        body: bytes,
      });
      expect(put.status).toBe(200);
    }
    // Other bytes at the same address are refused by R2 itself.
    const forged = await fetch(asset.put.url, {
      method: "PUT",
      headers: asset.put.headers,
      body: svg.map((byte, i) => (i === 10 ? byte ^ 1 : byte)),
    });
    expect(forged.status).toBe(400);

    const done = await call(t, runner.headers, "POST", "/v1/runner/uploads/complete", {
      ids: [asset.id, picture.id],
      seq: 0,
    });
    expect(done.body.files).toEqual([
      { id: asset.id, ref: "assets/icon.svg", url: `${assetsUrl}/${assetKey}/assets/icon.svg` },
      { id: picture.id, ref: null, url: `${assetsUrl}/${assetKey}/previews/0-light.png` },
    ]);
    await t.backgroundDone();

    const served = await fetch(`${assetsUrl}/${assetKey}/assets/icon.svg`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    // Opened by itself, an SVG is saved, not run on the assets origin.
    expect(served.headers.get("content-disposition")).toBe("attachment");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(svg);
    const copied = await fetch(`${assetsUrl}/${assetKey}/previews/0-light.png`);
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(preview);
    expect(await storage.head(`staging/${picture.id}-light.png`)).toBeNull();

    // Completion checked this: R2 answers a HEAD with the checksum it checked the bytes against.
    expect((await storage.head(`${assetKey}/assets/icon.svg`))?.sha256).toBe(
      createHash("sha256").update(svg).digest("hex"),
    );
    await storage.delete(`${assetKey}/assets/icon.svg`);
    expect(await storage.head(`${assetKey}/assets/icon.svg`)).toBeNull();
  }, 60_000);

  test("what is under an asset key is listed in pages and deleted together, and nothing else", async () => {
    const assetKey = newAssetKey();
    const neighbour = newAssetKey();
    const bytes = new TextEncoder().encode("ponzu live list");
    const object = {
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      cacheControl: "no-store",
    };
    const keys = ["a", "b & c", "d"].map((name) => `${assetKey}/assets/${name}.txt`);
    const kept = `${neighbour}/assets/kept.txt`;
    made.push(...keys, kept);
    for (const key of [...keys, kept]) {
      const put = await storage.presignPut(key, object, 60);
      const answer = await fetch(put.url, { method: "PUT", headers: put.headers, body: bytes });
      expect(answer.status).toBe(200);
    }

    const listed = await storage.list(`${assetKey}/`);
    expect(listed).toMatchObject({ keys, truncated: false });
    // Each with when it was written: just now, by R2's clock, which is near enough to ours.
    expect(listed.objects.map((object) => object.key)).toEqual(keys);
    for (const { modifiedAt } of listed.objects) {
      expect(Math.abs(modifiedAt!.getTime() - Date.now())).toBeLessThan(10 * 60_000);
    }
    expect(await storage.list(`${assetKey}/`, { after: keys[0] })).toMatchObject({
      keys: keys.slice(1),
      truncated: false,
    });
    expect(await deleteUnder(storage, `${assetKey}/`, { limit: 2 })).toEqual({
      deleted: 2,
      done: false,
    });
    expect(await deleteUnder(storage, `${assetKey}/`)).toEqual({ deleted: 1, done: true });
    expect(await storage.list(`${assetKey}/`)).toMatchObject({ keys: [], truncated: false });
    // Nothing at a key is not an error.
    await storage.deleteMany(keys);
    expect((await storage.head(kept))?.size).toBe(bytes.byteLength);
  }, 60_000);
});
