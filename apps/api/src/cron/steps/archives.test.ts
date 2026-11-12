import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sampleDoc } from "@ponzu/core/fixtures";
import { type Db, deleteCanvas, randomString } from "@ponzu/db";
import { ARCHIVE_RECORD_HOURS } from "../../runner/checkpoint.ts";
import {
  call,
  canvasWithRunner,
  type StartedRunner,
  type Workspace,
  workspaceWithRepo,
} from "../../testing/canvases.ts";
import { createTestApp, type TestApp } from "../../testing/index.ts";
import { CRON_STEPS, runCronSteps } from "../steps.ts";
import {
  ARCHIVES_HOUR,
  ARCHIVES_MINUTE,
  archivesStep,
  ORPHAN_AGE_MS,
  ORPHANS_PER_RUN,
  sweepOrphanArchives,
} from "./archives.ts";

/*
 * The orphan archive sweep (docs/cloud.md, "Saving the sandbox"): what no checkpoint records
 * under `private/`, a day old, is deleted; every checkpoint a canvas still has is kept, however
 * old it is.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterAll(() => t.close());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const send = (runner: StartedRunner, path: string, body: unknown) =>
  call(t, runner.headers, "POST", `/v1/runner${path}`, body);
const now = () => new Date(t.clock.now());

/** Uploads an archive as the runner does; answers its upload id and key. */
async function archive(runner: StartedRunner, purpose: "session" | "workspace", text: string) {
  const body = bytes(text);
  const name = `${purpose}.tar.gz`;
  const signed = await send(runner, "/uploads", {
    files: [
      { purpose, name, contentType: "application/gzip", size: body.byteLength, sha256: sha(body) },
    ],
  });
  expect(signed.status).toBe(200);
  const [file] = signed.body.files;
  const put = await t.storage.fetch(file.put.url, {
    method: "PUT",
    headers: file.put.headers,
    body: body as Uint8Array<ArrayBuffer>,
  });
  expect(put.status).toBe(200);
  return {
    id: file.id as string,
    key: decodeURIComponent(new URL(file.put.url).pathname.slice(1)),
  };
}

const checkpoint = (runner: StartedRunner, turn: number, over: Record<string, unknown>) =>
  send(runner, "/checkpoint", {
    turn,
    claudeSessionId: "sess-1",
    wipCommit: null,
    session: null,
    workspace: null,
    ...over,
  });

/** An object put straight into storage, written `age` ago (or with no time at all). */
function put(key: string, age: number | null) {
  t.storage.objects.set(key, {
    body: bytes(key),
    headers: {},
    sha256: null,
    ...(age === null ? {} : { modifiedAt: t.clock.now() - age }),
  });
}
const has = (key: string) => t.storage.objects.has(key);
const orphanKey = () => `private/${randomString(32)}/up_${randomString(16)}-session.tar.gz`;

/** Clears what earlier tests left under `private/`, so each counts only its own. */
function clearPrivate() {
  for (const key of [...t.storage.objects.keys()]) {
    if (key.startsWith("private/")) t.storage.objects.delete(key);
  }
}

describe("the orphan archive sweep", () => {
  test("keeps every recorded checkpoint, however old, and deletes the unrecorded ones over a day old", async () => {
    clearPrivate();
    const { runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const session = await archive(runner, "session", "the whole conversation");
    const workspace = await archive(runner, "workspace", "the scratch files");
    const recorded = await checkpoint(runner, 1, { session: session.id, workspace: workspace.id });
    expect(recorded.status).toBe(200);
    // An archive whose checkpoint call never came.
    const never = await archive(runner, "session", "a turn the runner died in");
    // An archive a checkpoint replaced, whose delete failed: put back as if it had stayed.
    const replaced = await archive(runner, "session", "an older transcript");
    expect(
      (await checkpoint(runner, 2, { session: replaced.id, keep: { workspace: true } })).status,
    ).toBe(200);
    const newest = await archive(runner, "session", "the newest transcript");
    expect(
      (await checkpoint(runner, 3, { session: newest.id, keep: { workspace: true } })).status,
    ).toBe(200);
    await t.backgroundDone();
    expect(has(replaced.key)).toBe(false);
    put(replaced.key, 0);
    t.storage.objects.get(replaced.key)!.modifiedAt = t.storage.objects.get(never.key)!.modifiedAt;

    // Not under private/: never looked at, whatever its age.
    const asset = `${randomString(32)}/assets/old.png`;
    put(asset, 30 * DAY);
    put("pull-requests/abc/light.png", 30 * DAY);
    put("staging/up_old-light.png", 30 * DAY);

    // A day less a minute: nothing goes yet.
    t.clock.advance(DAY - 60_000);
    expect(await sweepOrphanArchives(t.deps, now())).toEqual({
      listed: 4,
      recorded: 0,
      young: 4,
      undated: 0,
      deleted: 0,
    });

    // A week on, the recorded transcript and work in progress stay; the two orphans go.
    t.clock.advance(7 * DAY);
    expect(await sweepOrphanArchives(t.deps, now())).toEqual({
      listed: 4,
      recorded: 2,
      young: 0,
      undated: 0,
      deleted: 2,
    });
    expect(has(newest.key)).toBe(true);
    expect(has(workspace.key)).toBe(true);
    expect(has(never.key)).toBe(false);
    expect(has(replaced.key)).toBe(false);
    for (const key of [asset, "pull-requests/abc/light.png", "staging/up_old-light.png"]) {
      expect(has(key)).toBe(true);
    }
    // And the canvas still restores from them.
    const restore = await call(t, runner.headers, "POST", "/v1/runner/restore", {});
    expect(restore.status).toBe(200);
    expect(restore.body.saved.turn).toBe(3);
    expect(restore.body.session).not.toBeNull();
    expect(restore.body.workspace).not.toBeNull();

    // Ids and counts only, never a key.
    const line = t.logs.findLast((l) => l.event === "archives_swept");
    expect(line).toMatchObject({ level: "info", deleted: 2, recorded: 2 });
    expect(JSON.stringify(t.logs)).not.toContain(never.key.split("/")[1]!);
  });

  test("a deleted canvas's archives go once they are a day old, and an undated object stays", async () => {
    clearPrivate();
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const session = await archive(runner, "session", "a conversation");
    expect((await checkpoint(runner, 1, { session: session.id })).status).toBe(200);
    // The canvas goes and its rows with it, and the delete of its archives never happened.
    expect(await deleteCanvas(t.db, canvas.id)).toBe(true);
    expect(has(session.key)).toBe(true);
    const undated = orphanKey();
    put(undated, null);

    t.clock.advance(DAY + 1);
    expect(await sweepOrphanArchives(t.deps, now())).toEqual({
      listed: 2,
      recorded: 0,
      young: 0,
      undated: 1,
      deleted: 1,
    });
    expect(has(session.key)).toBe(false);
    expect(has(undated)).toBe(true);
  });

  test("deletes at most 2,000 a run, reads a bounded number of pages, and goes round the whole bucket over runs", async () => {
    clearPrivate();
    const keys = Array.from({ length: 2500 }, orphanKey).sort();
    for (const key of keys) put(key, 2 * DAY);
    t.storage.bulk.length = 0;

    // Started in the middle: the end of the bucket first, then round from its beginning.
    const start = keys[1200]!;
    const first = await sweepOrphanArchives(t.deps, now(), { start });
    expect(first.deleted).toBe(ORPHANS_PER_RUN);
    // Two pages after the start (1,000 and 299), then the bucket's first page of 1,000.
    expect(first.listed).toBe(2299);
    expect(t.storage.bulk.filter((b) => b.op === "deleteMany").every((b) => b.keys! <= 1000)).toBe(
      true,
    );
    // Everything after the start went, then the beginning, up to the cap.
    for (const key of keys.slice(1201)) expect(has(key)).toBe(false);
    const left = keys.filter(has);
    expect(left).toEqual([...keys.slice(ORPHANS_PER_RUN - 1299, 1201)]);

    // The next run takes the rest, wherever it starts.
    const second = await sweepOrphanArchives(t.deps, now());
    expect(second.deleted).toBe(left.length);
    expect(keys.filter(has)).toEqual([]);

    // A page budget stops a run early, whatever is left.
    for (const key of keys) put(key, 2 * DAY);
    t.storage.bulk.length = 0;
    const short = await sweepOrphanArchives(t.deps, now(), { start: "private/", pages: 1 });
    expect(short).toMatchObject({ listed: 1000, deleted: 1000 });
    expect(t.storage.bulk.filter((b) => b.op === "list")).toHaveLength(1);
    await sweepOrphanArchives(t.deps, now());
    await sweepOrphanArchives(t.deps, now());
    expect(keys.filter(has)).toEqual([]);
  });

  test("a run that starts past the last key still goes round to the beginning", async () => {
    clearPrivate();
    const keys = Array.from({ length: 3 }, orphanKey);
    for (const key of keys) put(key, 2 * DAY);
    expect(await sweepOrphanArchives(t.deps, now(), { start: "private/~" })).toMatchObject({
      listed: 3,
      deleted: 3,
    });
    // An empty bucket answers nothing, and asks twice at most.
    t.storage.bulk.length = 0;
    expect(await sweepOrphanArchives(t.deps, now())).toMatchObject({ listed: 0, deleted: 0 });
    expect(t.storage.bulk.filter((b) => b.op === "list").length).toBeLessThanOrEqual(2);
  });

  test("when the database cannot say what is recorded, nothing is deleted", async () => {
    clearPrivate();
    const key = orphanKey();
    put(key, 2 * DAY);
    const broken = {
      select: () => {
        throw new Error("Postgres did not answer");
      },
    } as unknown as Db;
    await expect(
      sweepOrphanArchives({ ...t.deps, db: broken }, now(), { start: "private/" }),
    ).rejects.toThrow("Postgres did not answer");
    expect(has(key)).toBe(true);
  });

  test("a start outside private/ is refused before storage is asked", async () => {
    t.storage.bulk.length = 0;
    await expect(sweepOrphanArchives(t.deps, now(), { start: "staging/" })).rejects.toThrow();
    await expect(sweepOrphanArchives(t.deps, now(), { start: "" })).rejects.toThrow();
    expect(t.storage.bulk).toEqual([]);
  });

  test("an archive uploaded too long ago is not recorded, so the sweep can never race a checkpoint", async () => {
    const { runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const late = await archive(runner, "session", "kept back");
    // Its address lasted ten minutes; twelve hours after that, it is refused.
    t.clock.advance(10 * 60_000 + ARCHIVE_RECORD_HOURS * HOUR + 1);
    const refused = await checkpoint(runner, 1, { session: late.id });
    expect(refused.status).toBe(404);
    expect(ARCHIVE_RECORD_HOURS * HOUR + 10 * 60_000).toBeLessThan(ORPHAN_AGE_MS);
    // One just inside the window is recorded.
    const fresh = await archive(runner, "session", "on time");
    t.clock.advance(ARCHIVE_RECORD_HOURS * HOUR);
    expect((await checkpoint(runner, 1, { session: fresh.id })).status).toBe(200);
  });
});

describe("the archives step", () => {
  test("is in the cron, and runs once a day at its hour and minute", async () => {
    expect(CRON_STEPS).toContain(archivesStep);
    clearPrivate();
    const key = orphanKey();
    put(key, 2 * DAY);
    const steps = [archivesStep];

    // Every minute of a day, from midnight UTC.
    t.clock.advance(DAY - (t.clock.now() % DAY));
    const ran: { at: string; counts: Record<string, number> }[] = [];
    for (let minute = 0; minute < 24 * 60; minute++) {
      const answer = await runCronSteps(t.deps, now(), steps);
      const counts = answer.steps.archives;
      if (counts && Object.keys(counts).length > 0) ran.push({ at: now().toISOString(), counts });
      t.clock.advance(60_000);
    }
    const at = `${String(ARCHIVES_HOUR).padStart(2, "0")}:${ARCHIVES_MINUTE}`;
    expect(ran.map((r) => r.at.slice(11, 16))).toEqual([at]);
    expect(ran[0]!.counts).toMatchObject({ deleted: 1 });
    expect(has(key)).toBe(false);
  });
});
