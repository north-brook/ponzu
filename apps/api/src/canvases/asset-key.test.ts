import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newAssetKey } from "@ponzu/db";
import { FakeClock } from "@ponzu/sandbox";
import { UpstreamError } from "../http/errors.ts";
import { RetryLater } from "../jobs/retry.ts";
import { createTestApp, MemoryStorage, type TestApp } from "../testing/index.ts";
import { underKey } from "../uploads/uploads.ts";
import { copyUnder, runAssetKeyRetireJob } from "./asset-key.ts";
import { FILES_PER_ATTEMPT } from "./files.ts";

const put = (storage: MemoryStorage, key: string, byte: number, modifiedAt?: number) =>
  storage.objects.set(key, {
    body: new Uint8Array([byte]),
    headers: { "content-type": "image/png" },
    sha256: null,
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  });

const paths = (storage: MemoryStorage, key: string) =>
  [...storage.objects.keys()]
    .filter((k) => k.startsWith(`${key}/`))
    .map((k) => k.slice(key.length))
    .sort();

describe("underKey", () => {
  const from = newAssetKey();
  const to = newAssetKey();

  test("moves a key under another canvas key to the same path under the new one", () => {
    expect(underKey(`${from}/assets/logo.png`, to)).toBe(`${to}/assets/logo.png`);
    expect(underKey(`${from}/exports/up_1-deck.pdf`, to)).toBe(`${to}/exports/up_1-deck.pdf`);
  });

  test("leaves what is already under it, and every key that is not under an asset key", () => {
    for (const key of [
      `${to}/assets/logo.png`,
      "staging/up_1-paste.png",
      "private/abc/up_2-session.tar.zst",
      "pull-requests/k/light.png",
      "no-slash",
      `${from}`,
    ]) {
      expect(underKey(key, to)).toBe(key);
    }
  });
});

describe("copyUnder", () => {
  test("refuses anything but two different asset keys, before asking storage anything", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const key = newAssetKey();
    for (const [from, to] of [
      [key, key],
      ["", key],
      [key, "pull-requests"],
      [`${key}/`, newAssetKey()],
    ]) {
      await expect(copyUnder(storage, from!, to!)).rejects.toThrow("two different asset keys");
    }
    expect(storage.bulk).toEqual([]);
  });

  test("copies 2,500 files a page at a time, and again only what the new key lacks", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const from = newAssetKey();
    const to = newAssetKey();
    for (let i = 0; i < 2500; i++)
      put(storage, `${from}/assets/${String(i).padStart(5, "0")}.png`, i);
    // Another canvas whose key starts the same way is not copied.
    const near = `${from.slice(0, -1)}${from.endsWith("0") ? "1" : "0"}`;
    put(storage, `${near}/assets/theirs.png`, 9);

    expect(await copyUnder(storage, from, to)).toBe(2500);
    expect(paths(storage, to)).toEqual(paths(storage, from));
    expect(paths(storage, near)).toEqual(["/assets/theirs.png"]);
    expect(storage.bulk.filter((c) => c.prefix === `${from}/`)).toHaveLength(3);

    // Nothing new: nothing copied.
    expect(await copyUnder(storage, from, to)).toBe(0);
  });

  test("with changedSince, copies again what changed at or after it, or says nothing of when", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const from = newAssetKey();
    const to = newAssetKey();
    put(storage, `${from}/assets/old.png`, 1, 1000);
    put(storage, `${from}/assets/changed.png`, 2, 5000);
    put(storage, `${from}/assets/unknown.png`, 3);
    for (const name of ["old", "changed", "unknown"]) put(storage, `${to}/assets/${name}.png`, 0);

    expect(await copyUnder(storage, from, to, { changedSince: 5000 })).toBe(2);
    expect(storage.objects.get(`${to}/assets/old.png`)?.body).toEqual(new Uint8Array([0]));
    expect(storage.objects.get(`${to}/assets/changed.png`)?.body).toEqual(new Uint8Array([2]));
    expect(storage.objects.get(`${to}/assets/unknown.png`)?.body).toEqual(new Uint8Array([3]));
  });

  test("an object that went after it was listed is skipped; any other failure throws", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const from = newAssetKey();
    const to = newAssetKey();
    put(storage, `${from}/previews/1-light.png`, 1);
    put(storage, `${from}/previews/2-light.png`, 2);
    const list = storage.list.bind(storage);
    storage.list = async (prefix, options) => {
      const page = await list(prefix, options);
      // A later preview replaced the first as the page was read.
      if (prefix === `${from}/`) storage.objects.delete(`${from}/previews/1-light.png`);
      return page;
    };
    expect(await copyUnder(storage, from, to)).toBe(2);
    expect(paths(storage, to)).toEqual(["/previews/2-light.png"]);

    storage.copy = async () => {
      throw new UpstreamError("storage", "COPY an object answered 500", { status: 500 });
    };
    await expect(copyUnder(storage, from, newAssetKey())).rejects.toThrow("500");
  });

  test("the memory storage answers a copy of nothing as R2 does: 404, naming no key", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const key = `${newAssetKey()}/assets/gone.png`;
    const refused = await storage.copy(key, `${newAssetKey()}/assets/gone.png`).catch((e) => e);
    expect(refused).toBeInstanceOf(UpstreamError);
    expect((refused as UpstreamError).status).toBe(404);
    expect((refused as Error).message).not.toContain(key);
  });
});

/*
 * The retire job with the canvas still under the new key is run through the route, in
 * routes/canvas-files.test.ts. Here, the canvas is gone or under yet another key.
 */
describe("the retire job", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  const depsWith = (storage: MemoryStorage) => ({ db: t.db, storage, log: t.deps.log });

  test("reset again or deleted meanwhile: nothing is copied, the old key still goes", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const from = newAssetKey();
    const to = newAssetKey();
    put(storage, `${from}/assets/late.png`, 2, 90_000);
    const deps = depsWith(storage);

    await runAssetKeyRetireJob(deps, { canvasId: "cnv_gone", from, to, swappedAt: 60_000 });

    expect(paths(storage, from)).toEqual([]);
    expect(paths(storage, to)).toEqual([]);
  });

  test("more than an attempt deletes comes back; on the last attempt it fails loudly", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const from = newAssetKey();
    for (let i = 0; i <= FILES_PER_ATTEMPT; i++) put(storage, `${from}/assets/${i}.png`, 1);
    const deps = depsWith(storage);
    const payload = { canvasId: "cnv_gone", from, to: newAssetKey(), swappedAt: 0 };

    const waited = await runAssetKeyRetireJob(deps, payload, { attempts: 1, maxAttempts: 2 }).catch(
      (e) => e,
    );
    expect(waited).toBeInstanceOf(RetryLater);
    expect(paths(storage, from)).toHaveLength(1);

    for (let i = 0; i <= FILES_PER_ATTEMPT; i++) put(storage, `${from}/more/${i}.png`, 1);
    const failed = await runAssetKeyRetireJob(deps, payload, { attempts: 2, maxAttempts: 2 }).catch(
      (e) => e,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(RetryLater);
  });
});
