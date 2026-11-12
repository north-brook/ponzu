import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enqueueJob, newAssetKey } from "@ponzu/db";
import { FakeClock } from "@ponzu/sandbox";
import { RetryLater } from "../jobs/retry.ts";
import { runDueJobs } from "../jobs/run.ts";
import { createTestApp, MemoryStorage } from "../testing/index.ts";
import {
  CANVAS_FILES_DELETE_ATTEMPTS,
  CANVAS_FILES_DELETE_JOB,
  canvasFilesDeleteJob,
  deleteUnder,
  FILES_PER_ATTEMPT,
  FILES_RETRY_MS,
  runCanvasFilesDeleteJob,
} from "./files.ts";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** `count` files under `assetKey`, spread over the areas a canvas stores. */
function fill(storage: MemoryStorage, assetKey: string, count: number) {
  const areas = ["assets", "previews", "exports", "comments"];
  for (let i = 0; i < count; i++) {
    const key = `${assetKey}/${areas[i % areas.length]}/${String(i).padStart(5, "0")}.png`;
    storage.objects.set(key, { body: new Uint8Array([i & 255]), headers: {}, sha256: null });
  }
}

const under = (storage: MemoryStorage, prefix: string) =>
  [...storage.objects.keys()].filter((key) => key.startsWith(prefix));

describe("the guard", () => {
  const key = newAssetKey();
  const refused = [
    "",
    "/",
    "x/",
    "pull-requests/",
    "private/",
    "staging/",
    key,
    `${key.slice(1)}/`,
    `${key}0/`,
    `${key}//`,
    `${key}/assets/`,
    `/${key}/`,
    `${key.toUpperCase()}/`,
    `${key.slice(0, -1)}u/`,
    `${key.slice(0, -1)}*/`,
  ];

  for (const prefix of refused) {
    test(`deleteUnder refuses ${JSON.stringify(prefix)} before asking storage anything`, async () => {
      const storage = new MemoryStorage(new FakeClock(0));
      fill(storage, key, 3);
      storage.objects.set("pull-requests/abc/light.png", {
        body: new Uint8Array(),
        headers: {},
        sha256: null,
      });

      await expect(deleteUnder(storage, prefix)).rejects.toThrow("only an asset key");
      expect(storage.bulk).toEqual([]);
      expect(storage.objects.size).toBe(4);
    });
  }

  test("the job is keyed only by a well-formed asset key", () => {
    expect(() => canvasFilesDeleteJob("")).toThrow();
    expect(() => canvasFilesDeleteJob(`${key}/`)).toThrow();
    expect(canvasFilesDeleteJob(key)).toEqual({
      kind: CANVAS_FILES_DELETE_JOB,
      key,
      payload: { assetKey: key },
      maxAttempts: CANVAS_FILES_DELETE_ATTEMPTS,
    });
  });
});

describe("deleteUnder", () => {
  test("deletes only what is under the key, a thousand at a time, up to its limit", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const key = newAssetKey();
    const other = newAssetKey();
    fill(storage, key, 2500);
    fill(storage, other, 5);
    // A key that shares the asset key's first characters but is another canvas's.
    const near = `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`;
    fill(storage, near, 2);
    storage.objects.set("pull-requests/k/light.png", {
      body: new Uint8Array(),
      headers: {},
      sha256: null,
    });

    expect(await deleteUnder(storage, `${key}/`)).toEqual({
      deleted: FILES_PER_ATTEMPT,
      done: false,
    });
    expect(under(storage, `${key}/`)).toHaveLength(500);
    expect(
      storage.bulk.filter((call) => call.op === "deleteMany").map((call) => call.keys),
    ).toEqual([1000, 1000]);

    expect(await deleteUnder(storage, `${key}/`)).toEqual({ deleted: 500, done: true });
    expect(under(storage, `${key}/`)).toEqual([]);
    expect(under(storage, `${other}/`)).toHaveLength(5);
    expect(under(storage, `${near}/`)).toHaveLength(2);
    expect(storage.objects.has("pull-requests/k/light.png")).toBe(true);
    for (const call of storage.bulk) if (call.op === "list") expect(call.prefix).toBe(`${key}/`);
  });

  test("with nothing under the key it is done at once, and again", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const key = newAssetKey();
    expect(await deleteUnder(storage, `${key}/`)).toEqual({ deleted: 0, done: true });
    expect(await deleteUnder(storage, `${key}/`)).toEqual({ deleted: 0, done: true });
  });

  test("exactly the limit left is done in one attempt", async () => {
    const storage = new MemoryStorage(new FakeClock(0));
    const key = newAssetKey();
    fill(storage, key, FILES_PER_ATTEMPT);
    expect(await deleteUnder(storage, `${key}/`)).toEqual({
      deleted: FILES_PER_ATTEMPT,
      done: true,
    });
  });
});

describe("the job", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  async function jobRow(key: string) {
    const result = (await t.db.execute(
      `select attempts, completed_at, failed_at, run_at from jobs
        where kind = '${CANVAS_FILES_DELETE_JOB}' and key = '${key}'`,
    )) as unknown as { rows: Record<string, unknown>[] };
    return result.rows[0]!;
  }

  test("2,500 files go over two attempts, ten seconds apart, and the job completes", async () => {
    const key = newAssetKey();
    fill(t.storage, key, 2500);
    await enqueueJob(t.db, { ...canvasFilesDeleteJob(key), runAt: new Date(t.clock.now()) });

    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toHaveLength(500);
    expect(await jobRow(key)).toMatchObject({ attempts: 1, completed_at: null, failed_at: null });

    // Not due again until the wait is over.
    t.clock.advance(FILES_RETRY_MS - 1);
    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toHaveLength(500);

    t.clock.advance(1);
    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toEqual([]);
    const done = await jobRow(key);
    expect(done.attempts).toBe(2);
    expect(done.completed_at).not.toBeNull();
    // The asset key is the capability to the files: no log line carries it.
    expect(JSON.stringify(t.logs)).not.toContain(key);
  });

  test("a delete storage half refuses is tried again, and finishes what is left", async () => {
    const key = newAssetKey();
    fill(t.storage, key, 2500);
    t.storage.failDeletes = 1;
    await enqueueJob(t.db, { ...canvasFilesDeleteJob(key), runAt: new Date(t.clock.now()) });

    // The first attempt fails at its first page, having removed half of it.
    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toHaveLength(2000);
    const failed = await jobRow(key);
    expect(failed).toMatchObject({ attempts: 1, completed_at: null, failed_at: null });

    // Then the usual backoff, a minute after a first failure; the 2,000 left fit one attempt.
    t.clock.advance(60_000 - 1);
    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toHaveLength(2000);
    t.clock.advance(1);
    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toEqual([]);
    const done = await jobRow(key);
    expect(done.attempts).toBe(2);
    expect(done.completed_at).not.toBeNull();
  });

  test("files left after the last attempt fail the job loudly, not as a wait", async () => {
    const key = newAssetKey();
    fill(t.storage, key, FILES_PER_ATTEMPT + 1);
    await enqueueJob(t.db, {
      ...canvasFilesDeleteJob(key),
      maxAttempts: 1,
      runAt: new Date(t.clock.now()),
    });

    await runDueJobs(t.deps, "files-test");
    expect(under(t.storage, `${key}/`)).toHaveLength(1);
    const row = await jobRow(key);
    expect(row.attempts).toBe(1);
    expect(row.failed_at).not.toBeNull();
    expect(t.logs.findLast((line) => line.event === "job_failed")).toMatchObject({
      kind: CANVAS_FILES_DELETE_JOB,
    });
    expect(JSON.stringify(t.logs)).not.toContain(key);
  });

  test("a purge that needs every attempt still keeps one for the final pass at until", async () => {
    // What deleteCanvasAndFiles records: the purge's attempts and one more for the final pass.
    const job = {
      attempts: CANVAS_FILES_DELETE_ATTEMPTS,
      maxAttempts: CANVAS_FILES_DELETE_ATTEMPTS + 1,
    };
    const until = t.clock.now() + 60_000;

    // Emptied on the purge's last attempt, before until: it waits for the final pass.
    const emptied = newAssetKey();
    fill(t.storage, emptied, 1);
    const wait = runCanvasFilesDeleteJob(t.deps, { assetKey: emptied, until }, job);
    await expect(wait).rejects.toBeInstanceOf(RetryLater);

    // Still not empty on the purge's last attempt: a failure, not a wait into the final pass.
    const full = newAssetKey();
    fill(t.storage, full, FILES_PER_ATTEMPT + 1);
    const failed = runCanvasFilesDeleteJob(t.deps, { assetKey: full, until }, job);
    await expect(failed).rejects.toThrow("more remain");
    await expect(failed).rejects.not.toBeInstanceOf(RetryLater);

    // The final pass itself, at until, completes.
    t.clock.advance(60_000);
    await runCanvasFilesDeleteJob(
      t.deps,
      { assetKey: emptied, until },
      {
        ...job,
        attempts: job.maxAttempts,
      },
    );
  });

  test("one job waits per asset key, however often it is recorded", async () => {
    const key = newAssetKey();
    fill(t.storage, key, 1);
    expect(await enqueueJob(t.db, canvasFilesDeleteJob(key))).not.toBeNull();
    expect(await enqueueJob(t.db, canvasFilesDeleteJob(key))).toBeNull();
  });
});
