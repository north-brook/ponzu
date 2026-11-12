import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emptyDoc } from "@ponzu/core";
import {
  deleteCanvasWithFiles,
  enqueueJob,
  getCanvas,
  getCanvasAssetKey,
  getCanvasHead,
  newAssetKey,
  randomString,
  swapCanvasAssetKey,
} from "@ponzu/db";
import {
  ASSET_KEY_RETIRE_ATTEMPTS,
  ASSET_KEY_RETIRE_DELAY_MS,
  ASSET_KEY_RETIRE_JOB,
} from "../canvases/asset-key.ts";
import {
  CANVAS_FILES_DELETE_ATTEMPTS,
  CANVAS_FILES_DELETE_JOB,
  canvasFilesDeleteJob,
  FILES_RETRY_MS,
} from "../canvases/files.ts";
import type { StoredList } from "../deps/storage.ts";
import { runDueJobs } from "../jobs/run.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import {
  createTestApp,
  type MemoryStorage,
  TEST_ASSETS_URL,
  type TestApp,
} from "../testing/index.ts";
import { UPLOADS_SETTLED_MS } from "../uploads/uploads.ts";

/*
 * A canvas's files (docs/cloud.md, "Assets and previews"): deleted with the canvas, through the
 * one purge, and moved under a new asset key when its owner or an admin resets its file links.
 * Everything here runs on the memory storage; nothing is deleted anywhere real.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  // An admin, the canvases' owner, another writer, a reader, and a member GitHub gives nothing.
  ws = await workspaceWithRepo(t, {
    ada: "admin",
    maya: "write",
    kim: "write",
    ines: "read",
    omar: "none",
  });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;

/** `count` files under `assetKey`, spread over the areas a canvas stores, written now. */
function fill(storage: MemoryStorage, assetKey: string, count: number, tag = "") {
  const areas = ["assets", "previews", "exports", "comments"];
  for (let i = 0; i < count; i++) {
    const key = `${assetKey}/${areas[i % areas.length]}/${tag}${String(i).padStart(5, "0")}.png`;
    storage.objects.set(key, {
      body: new Uint8Array([i & 255]),
      headers: { "content-type": "image/png" },
      sha256: null,
      modifiedAt: t.clock.now(),
    });
  }
}

const under = (prefix: string) =>
  [...t.storage.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
/** The paths under `assetKey`, without it: what two keys holding the same files share. */
const paths = (assetKey: string) => under(`${assetKey}/`).map((key) => key.slice(assetKey.length));

async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}
const jobsFor = (kind: string, key: string) =>
  rows(
    `select attempts, completed_at, failed_at, run_at, payload from jobs
      where kind = '${kind}' and key = '${key}' order by created_at`,
  );

/** A pull request's pictures, which outlive the canvas (a description still shows them). */
function pullRequestPictures(): string {
  const key = `pull-requests/${randomString(32)}`;
  for (const theme of ["light", "dark"]) {
    t.storage.objects.set(`${key}/${theme}.png`, {
      body: new Uint8Array([1]),
      headers: {},
      sha256: null,
    });
  }
  return key;
}

/**
 * Runs what the minute's cron runs, after `ms`; then everyone signs in again, since a quarter of
 * an hour is longer than a session's access token lasts.
 */
async function cronAfter(ms: number) {
  t.clock.advance(ms);
  await runDueJobs(t.deps, "canvas-files-test");
  for (const login of Object.keys(ws.people)) {
    ws.people[login]!.headers = (await t.signInAs({ login })).headers;
  }
}

describe("DELETE /v1/canvases/:id takes the canvas's files with it", () => {
  test("2,500 files over two attempts; pull request pictures and other canvases' files stay", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Purged"));
    const other = await canvasIn(t, ws, "maya", emptyDoc("Kept"));
    const key = (await getCanvasAssetKey(t.db, canvas.id))!;
    const otherKey = (await getCanvasAssetKey(t.db, other.id))!;
    fill(t.storage, key, 2500);
    fill(t.storage, otherKey, 7);
    const pictures = pullRequestPictures();

    expect((await call(t, as("maya"), "DELETE", `/v1/canvases/${canvas.id}`)).status).toBe(204);
    await t.backgroundDone();

    // The job was recorded as the row went, keyed by its asset key, and ran at once.
    expect(await getCanvas(t.db, canvas.id)).toBeNull();
    const [first] = await jobsFor(CANVAS_FILES_DELETE_JOB, key);
    expect(first).toMatchObject({
      attempts: 1,
      completed_at: null,
      failed_at: null,
      payload: { assetKey: key, until: t.clock.now() + UPLOADS_SETTLED_MS },
    });
    expect(under(`${key}/`)).toHaveLength(500);

    await cronAfter(FILES_RETRY_MS);
    expect(under(`${key}/`)).toEqual([]);
    // Empty, and waiting for its last pass once every upload address has run out.
    const [emptied] = await jobsFor(CANVAS_FILES_DELETE_JOB, key);
    expect(emptied).toMatchObject({ attempts: 2, completed_at: null, failed_at: null });
    await cronAfter(UPLOADS_SETTLED_MS - FILES_RETRY_MS);
    const [done] = await jobsFor(CANVAS_FILES_DELETE_JOB, key);
    expect(done).toMatchObject({ attempts: 3, failed_at: null });
    expect(done!.completed_at).not.toBeNull();

    expect(under(`${otherKey}/`)).toHaveLength(7);
    expect(under(`${pictures}/`)).toEqual([`${pictures}/dark.png`, `${pictures}/light.png`]);
    expect(
      t.analytics.of("canvas deleted").filter((e) => e.properties.canvas_id === canvas.id),
    ).toHaveLength(1);
    // The asset key is the capability to the files: no log line carries it.
    expect(JSON.stringify(t.logs)).not.toContain(key);
  });

  test("a file an upload address signed before the delete lands after the purge is deleted too", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Late"));
    const key = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, key, 3);

    expect((await call(t, as("maya"), "DELETE", `/v1/canvases/${canvas.id}`)).status).toBe(204);
    await t.backgroundDone();
    expect(under(`${key}/`)).toEqual([]);

    // An address signed a minute before the delete is good for nine more: its bytes land now.
    fill(t.storage, key, 1, "late-");
    await cronAfter(UPLOADS_SETTLED_MS - 1);
    expect(under(`${key}/`)).toHaveLength(1);
    expect((await jobsFor(CANVAS_FILES_DELETE_JOB, key))[0]?.completed_at).toBeNull();

    await cronAfter(1);
    expect(under(`${key}/`)).toEqual([]);
    const [done] = await jobsFor(CANVAS_FILES_DELETE_JOB, key);
    expect(done).toMatchObject({ attempts: 2, failed_at: null });
    expect(done!.completed_at).not.toBeNull();
    // The purge's attempts and one more, so the final pass always has one left.
    const [attempts] = await rows(
      `select max_attempts from jobs where kind = '${CANVAS_FILES_DELETE_JOB}' and key = '${key}'`,
    );
    expect(attempts!.max_attempts).toBe(CANVAS_FILES_DELETE_ATTEMPTS + 1);
  });

  test("deleted twice at once: one job, one event, and both requests are answered as done", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Twice"));
    const key = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, key, 3);

    const answers = await Promise.all([
      call(t, as("maya"), "DELETE", `/v1/canvases/${canvas.id}`),
      call(t, as("ada"), "DELETE", `/v1/canvases/${canvas.id}`),
    ]);
    await t.backgroundDone();

    // The one that lost finds no row: 204 if it got past the read first, 404 if it did not.
    expect(answers.map((a) => a.status)).toContain(204);
    for (const answer of answers) expect([204, 404]).toContain(answer.status);
    expect(await jobsFor(CANVAS_FILES_DELETE_JOB, key)).toHaveLength(1);
    expect(
      t.analytics.of("canvas deleted").filter((e) => e.properties.canvas_id === canvas.id),
    ).toHaveLength(1);
    expect(under(`${key}/`)).toEqual([]);

    // And once more, after: there is no such canvas.
    expect((await call(t, as("maya"), "DELETE", `/v1/canvases/${canvas.id}`)).status).toBe(404);
  });
});

describe("deleteCanvasWithFiles", () => {
  const job = () => ({
    kind: CANVAS_FILES_DELETE_JOB,
    maxAttempts: CANVAS_FILES_DELETE_ATTEMPTS,
    runAt: new Date(t.clock.now()),
  });

  test("records nothing for a canvas that is not there", async () => {
    expect(await deleteCanvasWithFiles(t.db, { canvasId: "cnv_never", job: job() })).toEqual({
      deleted: false,
      job: null,
    });
  });

  test("records the job unheld, for the cron, without a worker; held, attempt 1, with one", async () => {
    const free = await canvasIn(t, ws, "maya", emptyDoc("Free"));
    const freeKey = (await getCanvasAssetKey(t.db, free.id))!;
    const freeJob = await deleteCanvasWithFiles(t.db, { canvasId: free.id, job: job() });
    expect(freeJob).toMatchObject({
      deleted: true,
      job: { kind: CANVAS_FILES_DELETE_JOB, attempts: 0, payload: { assetKey: freeKey } },
    });
    const [row] = await rows(`select locked_by from jobs where id = '${freeJob.job!.id}'`);
    expect(row!.locked_by).toBeNull();

    const held = await canvasIn(t, ws, "maya", emptyDoc("Held"));
    const heldJob = await deleteCanvasWithFiles(t.db, {
      canvasId: held.id,
      job: { ...job(), lockedBy: "worker-1" },
    });
    expect(heldJob.job).toMatchObject({ attempts: 1, maxAttempts: CANVAS_FILES_DELETE_ATTEMPTS });
    const [locked] = await rows(`select locked_by from jobs where id = '${heldJob.job!.id}'`);
    expect(locked!.locked_by).toBe("worker-1");
  });

  test("a job already waiting for the key does the work: the row goes, nothing new is recorded", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Waiting"));
    const key = (await getCanvasAssetKey(t.db, canvas.id))!;
    await enqueueJob(t.db, canvasFilesDeleteJob(key));

    expect(await deleteCanvasWithFiles(t.db, { canvasId: canvas.id, job: job() })).toEqual({
      deleted: true,
      job: null,
    });
    expect(await getCanvas(t.db, canvas.id)).toBeNull();
    expect(await jobsFor(CANVAS_FILES_DELETE_JOB, key)).toHaveLength(1);
  });
});

describe("swapCanvasAssetKey", () => {
  const retire = (from: string) => ({
    kind: ASSET_KEY_RETIRE_JOB,
    payload: { from },
    runAt: new Date(t.clock.now() + 1000),
    maxAttempts: 1,
  });

  test("holds only while the key is still the old one, and says why it did not", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Swapped"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    const to = newAssetKey();
    const now = new Date(t.clock.now());

    expect(
      await swapCanvasAssetKey(t.db, { canvasId: canvas.id, from, to, now, job: retire(from) }),
    ).toBe("swapped");
    expect(await getCanvasAssetKey(t.db, canvas.id)).toBe(to);
    expect((await getCanvasHead(t.db, canvas.id))?.assetKeyRotatedAt).toEqual(now);
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, from)).toHaveLength(1);

    // The same swap again: the key is no longer `from`. Nothing changes, nothing is recorded.
    const again = newAssetKey();
    expect(
      await swapCanvasAssetKey(t.db, {
        canvasId: canvas.id,
        from,
        to: again,
        now,
        job: retire(from),
      }),
    ).toBe("changed");
    expect(await getCanvasAssetKey(t.db, canvas.id)).toBe(to);
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, from)).toHaveLength(1);

    expect(
      await swapCanvasAssetKey(t.db, {
        canvasId: "cnv_never",
        from,
        to: again,
        now,
        job: retire(again),
      }),
    ).toBe("missing");
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, again)).toEqual([]);
  });
});

describe("POST /v1/canvases/:id/asset-key/rotate", () => {
  const rotate = (login: string, id: string) =>
    call(t, as(login), "POST", `/v1/canvases/${id}/asset-key/rotate`);

  test("only its owner or a workspace admin; a reader and a stranger are refused", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Guarded"));
    const key = (await getCanvasAssetKey(t.db, canvas.id))!;

    const kim = await rotate("kim", canvas.id);
    expect([kim.status, kim.body.error.code]).toEqual([403, "forbidden"]);
    expect(kim.body.error.message).toBe(
      "Only its owner or a workspace admin can reset its file links.",
    );
    expect((await rotate("ines", canvas.id)).status).toBe(403);
    expect((await rotate("omar", canvas.id)).status).toBe(404);
    expect((await rotate("maya", "cnv_never")).status).toBe(404);
    // None of them moved anything.
    expect(await getCanvasAssetKey(t.db, canvas.id)).toBe(key);
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, key)).toEqual([]);

    const admin = await rotate("ada", canvas.id);
    expect(admin.status).toBe(200);
    expect(
      t.analytics.of("canvas file links reset").filter((e) => e.properties.canvas_id === canvas.id),
    ).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ by_owner: false }) }),
    ]);
  });

  test("moves every file under a new key, answers it, and retires the old a quarter of an hour later", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Reset"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 1500);
    const pictures = pullRequestPictures();

    const answered = await rotate("maya", canvas.id);
    await t.backgroundDone();

    expect(answered.status).toBe(200);
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;
    expect(to).not.toBe(from);
    expect(answered.body).toMatchObject({
      id: canvas.id,
      assetsUrl: `${TEST_ASSETS_URL}/${to}/`,
      assetKeyRotatedAt: new Date(t.clock.now()).toISOString(),
      access: "write",
    });
    expect((await getCanvasHead(t.db, canvas.id))?.assetKeyRotatedAt).toEqual(
      new Date(t.clock.now()),
    );
    expect(paths(to)).toEqual(paths(from));
    expect(paths(to)).toHaveLength(1500);
    // The bytes and the headers they are served with came across too.
    const sample = paths(from)[7]!;
    expect(t.storage.objects.get(`${to}${sample}`)?.body).toEqual(
      t.storage.objects.get(`${from}${sample}`)!.body,
    );
    expect(t.storage.objects.get(`${to}${sample}`)?.headers).toEqual({
      "content-type": "image/png",
    });

    const [job] = await jobsFor(ASSET_KEY_RETIRE_JOB, from);
    expect(job).toMatchObject({
      attempts: 0,
      payload: { canvasId: canvas.id, from, to, swappedAt: t.clock.now() },
    });
    expect(new Date(job!.run_at as string).getTime()).toBe(
      t.clock.now() + ASSET_KEY_RETIRE_DELAY_MS,
    );
    expect(ASSET_KEY_RETIRE_DELAY_MS).toBe(15 * 60_000);

    // The old key still serves until the job is due.
    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS - 1);
    expect(paths(from)).toHaveLength(1500);
    await cronAfter(1);
    expect(paths(from)).toEqual([]);
    expect(paths(to)).toHaveLength(1500);
    const [retired] = await jobsFor(ASSET_KEY_RETIRE_JOB, from);
    expect(retired!.completed_at).not.toBeNull();
    expect(retired!.attempts).toBe(1);
    expect(retired!.payload).toMatchObject({ canvasId: canvas.id });
    expect(ASSET_KEY_RETIRE_ATTEMPTS).toBeGreaterThan(1);

    expect(under(`${pictures}/`)).toHaveLength(2);
    expect(
      t.analytics.of("canvas file links reset").filter((e) => e.properties.canvas_id === canvas.id),
    ).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ by_owner: true }) }),
    ]);
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain(from);
    expect(logged).not.toContain(to);
  });

  test("an upload that completes between the two copy passes is under the new key", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Racing"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 20);
    const png = new TextEncoder().encode("\x89PNG late");
    const declared = {
      name: "late.png",
      contentType: "image/png",
      size: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    // Signed before the reset, so its address is under the old key.
    const signed = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads`, {
      files: [declared],
    });
    const [file] = signed.body.files;

    // The first pass lists the old key's files; the bytes arrive, and the upload completes, as
    // that pass copies what it listed.
    let landed: { status: number; body: any } | null = null;
    const list = t.storage.list.bind(t.storage);
    t.storage.list = async (prefix: string, options?: { after?: string }): Promise<StoredList> => {
      const page = await list(prefix, options);
      if (prefix === `${from}/` && landed === null) {
        await t.storage.fetch(file.put.url, {
          method: "PUT",
          headers: file.put.headers,
          body: png,
        });
        landed = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads/complete`, {
          ids: [file.id],
        });
      }
      return page;
    };
    let answered: { status: number; body: any };
    try {
      answered = await rotate("maya", canvas.id);
    } finally {
      t.storage.list = list;
    }
    await t.backgroundDone();

    expect(answered.status).toBe(200);
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;
    // Completed before the swap: under the old key, as the key then was.
    expect(landed!.status).toBe(200);
    const ref = landed!.body.files[0].ref as string;
    expect(landed!.body.files[0].url).toBe(`${TEST_ASSETS_URL}/${from}/${ref}`);
    // The second pass took it across, so the reference resolves under the new address.
    expect(t.storage.objects.get(`${to}/${ref}`)?.body).toEqual(png);
    expect(paths(to)).toEqual(paths(from));

    // Completed again after the swap, it answers the new address.
    const again = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads/complete`, {
      ids: [file.id],
    });
    expect(again.body.files[0].url).toBe(`${TEST_ASSETS_URL}/${to}/${ref}`);

    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(from)).toEqual([]);
    expect(t.storage.objects.get(`${to}/${ref}`)?.body).toEqual(png);
  });

  test("an upload signed before, its bytes landing after the reset, is served from the new key", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("After"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    const bytes = (text: string) => new TextEncoder().encode(text);
    const sign = async (name: string, body: Uint8Array) => {
      const signed = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads`, {
        files: [
          {
            name,
            contentType: "image/png",
            size: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
          },
        ],
      });
      return signed.body.files[0];
    };
    const completed = bytes("\x89PNG completed");
    const forgotten = bytes("\x89PNG never completed");
    const one = await sign("one.png", completed);
    const two = await sign("two.png", forgotten);

    expect((await rotate("maya", canvas.id)).status).toBe(200);
    await t.backgroundDone();
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;

    // Both addresses were signed for the old key, and still take their bytes.
    for (const [file, body] of [
      [one, completed],
      [two, forgotten],
    ] as const) {
      const put = await t.storage.fetch(file.put.url, {
        method: "PUT",
        headers: file.put.headers,
        body,
      });
      expect(put.status).toBe(200);
    }
    // Completed now, the first is copied to the new key and answered there.
    const done = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads/complete`, {
      ids: [one.id],
    });
    expect(done.status).toBe(200);
    const ref = done.body.files[0].ref as string;
    expect(done.body.files[0].url).toBe(`${TEST_ASSETS_URL}/${to}/${ref}`);
    expect(t.storage.objects.get(`${to}/${ref}`)?.body).toEqual(completed);

    // The second never completes; the retire job's last pass still takes it across before it
    // deletes the old key, so a person who completes it later finds it.
    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(from)).toEqual([]);
    expect(paths(to).some((path) => path.startsWith("/assets/two-"))).toBe(true);
  });

  test("two resets at once make one: the second answers the first's key and leaves no copies", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Both"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 5);
    const before = new Set(t.storage.objects.keys());

    // The admin's reset runs whole while the owner's first pass copies.
    let inner: { status: number; body: any } | null = null;
    const list = t.storage.list.bind(t.storage);
    t.storage.list = async (prefix: string, options?: { after?: string }): Promise<StoredList> => {
      const page = await list(prefix, options);
      if (prefix === `${from}/` && inner === null) {
        t.storage.list = list;
        inner = await rotate("ada", canvas.id);
      }
      return page;
    };
    let outer: { status: number; body: any };
    try {
      outer = await rotate("maya", canvas.id);
    } finally {
      t.storage.list = list;
    }
    await t.backgroundDone();

    const key = (await getCanvasAssetKey(t.db, canvas.id))!;
    expect([inner!.status, outer.status]).toEqual([200, 200]);
    expect(inner!.body.assetsUrl).toBe(`${TEST_ASSETS_URL}/${key}/`);
    expect(outer.body.assetsUrl).toBe(`${TEST_ASSETS_URL}/${key}/`);
    // One retire job, for the key both started from; one event, for the reset that held.
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, from)).toHaveLength(1);
    expect(
      t.analytics.of("canvas file links reset").filter((e) => e.properties.canvas_id === canvas.id),
    ).toHaveLength(1);
    // The losing reset's copies were deleted at once: only the old key and the new hold files.
    const added = [...t.storage.objects.keys()].filter((k) => !before.has(k));
    expect(new Set(added.map((k) => k.slice(0, k.indexOf("/"))))).toEqual(new Set([key]));
  });

  test("deleted after the swap, as the second pass copies: the retire job takes what it left", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Late delete"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 4);

    // The first pass makes four copies. As the second begins, the canvas is deleted and its files
    // job (keyed by the new key, the row's as it went) runs whole; that pass then copies on.
    const copy = t.storage.copy.bind(t.storage);
    let copies = 0;
    let to = "";
    t.storage.copy = async (source: string, target: string) => {
      to = target.slice(0, target.indexOf("/"));
      if (++copies === 5) {
        expect((await call(t, as("ada"), "DELETE", `/v1/canvases/${canvas.id}`)).status).toBe(204);
        await t.backgroundDone();
      }
      return copy(source, target);
    };
    let answered: { status: number; body: any };
    try {
      answered = await rotate("maya", canvas.id);
    } finally {
      t.storage.copy = copy;
    }
    await t.backgroundDone();
    // Gone by the time it would answer, so it answers as for any deleted canvas.
    expect(answered.status).toBe(404);
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, from)).toHaveLength(1);
    // Its files job emptied the new key and waits for its last pass.
    expect((await jobsFor(CANVAS_FILES_DELETE_JOB, to))[0]).toMatchObject({
      attempts: 1,
      completed_at: null,
    });
    // The second pass wrote under the new key after the files job's first pass.
    expect(paths(to).length).toBeGreaterThan(0);

    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(from)).toEqual([]);
    expect(paths(to)).toEqual([]);
  });

  test("a slow first pass and a failed second: the retire job copies what changed since the first began", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Slow"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 2);
    t.clock.advance(120_000);
    const began = t.clock.now();
    const image = `${from}/assets/00000.png`;
    const body = (n: number) => new Uint8Array([n, n, n]);

    // The first pass copies the image, which is then rewritten under the old key; that pass runs
    // on for two minutes, longer than the slack for storage's clock. Then every copy fails.
    const copy = t.storage.copy.bind(t.storage);
    let copies = 0;
    t.storage.copy = async (source: string, target: string) => {
      copies++;
      if (copies > 2) throw new Error("storage is down");
      await copy(source, target);
      if (source === image) {
        t.clock.advance(1);
        t.storage.objects.set(image, {
          body: body(2),
          headers: { "content-type": "image/png" },
          sha256: null,
          modifiedAt: t.clock.now(),
        });
        t.clock.advance(120_000);
      }
    };
    let answered: { status: number; body: any };
    try {
      answered = await rotate("maya", canvas.id);
    } finally {
      t.storage.copy = copy;
    }
    await t.backgroundDone();
    expect(answered.status).toBe(200);
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;
    expect(t.storage.objects.get(`${to}/assets/00000.png`)?.body).not.toEqual(body(2));
    const [job] = await jobsFor(ASSET_KEY_RETIRE_JOB, from);
    expect(job).toMatchObject({ payload: { copiedSince: began } });

    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(from)).toEqual([]);
    expect(t.storage.objects.get(`${to}/assets/00000.png`)?.body).toEqual(body(2));
  });

  test("a file written under the new key since the swap is never copied over by the old", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Newer"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 2);
    expect((await rotate("maya", canvas.id)).status).toBe(200);
    await t.backgroundDone();
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;
    const body = (byte: number) => new Uint8Array([byte]);
    const write = (key: string, byte: number) =>
      t.storage.objects.set(key, {
        body: body(byte),
        headers: { "content-type": "image/png" },
        sha256: null,
        modifiedAt: t.clock.now(),
      });

    // The runner, still on the old address, replaces an image there a moment after the swap;
    // then, under the new key, replaces it again. The retire job copies the old key's late
    // change, but not over the newer file.
    t.clock.advance(1000);
    write(`${from}/assets/logo.png`, 1);
    t.clock.advance(1000);
    write(`${to}/assets/logo.png`, 2);
    // And a late change with nothing newer under the new key is copied across.
    write(`${from}/assets/late.png`, 3);

    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(from)).toEqual([]);
    expect(t.storage.objects.get(`${to}/assets/logo.png`)?.body).toEqual(body(2));
    expect(t.storage.objects.get(`${to}/assets/late.png`)?.body).toEqual(body(3));
  });

  test("reset twice within the quarter hour: a late file under the first key reaches the third", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Twice"));
    const first = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, first, 2);
    // Written well before the reset, past the slack allowed for storage's clock.
    t.clock.advance(120_000);
    expect((await rotate("maya", canvas.id)).status).toBe(200);
    await t.backgroundDone();
    const second = (await getCanvasAssetKey(t.db, canvas.id))!;
    // A file deleted under the second key on purpose stays deleted.
    const [kept, dropped] = paths(second);
    t.storage.objects.delete(`${second}${dropped}`);
    t.clock.advance(60_000);
    expect((await rotate("ada", canvas.id)).status).toBe(200);
    await t.backgroundDone();
    const third = (await getCanvasAssetKey(t.db, canvas.id))!;
    expect(new Set([first, second, third]).size).toBe(3);

    // An upload signed for the first key lands there after both resets.
    t.clock.advance(60_000);
    t.storage.objects.set(`${first}/assets/late.png`, {
      body: new Uint8Array([7]),
      headers: { "content-type": "image/png" },
      sha256: null,
      modifiedAt: t.clock.now(),
    });

    await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    expect(paths(first)).toEqual([]);
    expect(t.storage.objects.get(`${third}/assets/late.png`)?.body).toEqual(new Uint8Array([7]));
    expect(paths(third)).toContain(kept!);
    expect(paths(third)).not.toContain(dropped!);
  });

  test("a file written under the new key after a pass listed it is not copied over", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Mid-pass"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 1);
    expect((await rotate("maya", canvas.id)).status).toBe(200);
    await t.backgroundDone();
    const to = (await getCanvasAssetKey(t.db, canvas.id))!;
    const write = (key: string, byte: number) =>
      t.storage.objects.set(key, {
        body: new Uint8Array([byte]),
        headers: { "content-type": "image/png" },
        sha256: null,
        modifiedAt: t.clock.now(),
      });
    t.clock.advance(1000);
    write(`${from}/assets/logo.png`, 1);

    // The retire job lists the new key, and only then the runner writes logo.png there.
    const list = t.storage.list.bind(t.storage);
    t.storage.list = async (prefix, options) => {
      const page = await list(prefix, options);
      if (prefix === `${to}/`) {
        t.clock.advance(1000);
        write(`${to}/assets/logo.png`, 2);
      }
      return page;
    };
    try {
      await cronAfter(ASSET_KEY_RETIRE_DELAY_MS);
    } finally {
      t.storage.list = list;
    }
    expect(paths(from)).toEqual([]);
    expect(t.storage.objects.get(`${to}/assets/logo.png`)?.body).toEqual(new Uint8Array([2]));
  });

  test("a canvas deleted while it is reset: refused as gone, and its copies deleted", async () => {
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Vanishing"));
    const from = (await getCanvasAssetKey(t.db, canvas.id))!;
    fill(t.storage, from, 5);
    const before = new Set(t.storage.objects.keys());

    const list = t.storage.list.bind(t.storage);
    let deleted = false;
    t.storage.list = async (prefix: string, options?: { after?: string }): Promise<StoredList> => {
      const page = await list(prefix, options);
      if (prefix === `${from}/` && !deleted) {
        deleted = true;
        t.storage.list = list;
        expect((await call(t, as("ada"), "DELETE", `/v1/canvases/${canvas.id}`)).status).toBe(204);
      }
      return page;
    };
    let answered: { status: number; body: any };
    try {
      answered = await rotate("maya", canvas.id);
    } finally {
      t.storage.list = list;
    }
    await t.backgroundDone();

    expect(answered.status).toBe(404);
    expect(await jobsFor(ASSET_KEY_RETIRE_JOB, from)).toEqual([]);
    // The canvas's own files went with it, and the reset's copies were deleted too.
    expect(under(`${from}/`)).toEqual([]);
    expect([...t.storage.objects.keys()].filter((k) => !before.has(k))).toEqual([]);
  });
});
