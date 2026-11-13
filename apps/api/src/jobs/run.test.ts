import { afterAll, beforeAll, expect, test } from "bun:test";
import { jobs, SEARCH_REINDEX_JOB } from "@ponzu/db";
import { ACCOUNT_FORGET_JOB } from "../account/forget.ts";
import { ASSET_KEY_RETIRE_JOB } from "../canvases/asset-key.ts";
import { CANVAS_FILES_DELETE_JOB } from "../canvases/files.ts";
import { MEMBERS_JOB } from "../email/members.ts";
import { BASE_REBUILD_JOB } from "../environments/rebuild.ts";
import { PEOPLE_JOB } from "../github/people.ts";
import { WEBHOOK_JOB } from "../github/webhook.ts";
import { BADGE_JOB } from "../notifications/badge.ts";
import { DELIVER_JOB } from "../notifications/deliver.ts";
import { DIGEST_JOB } from "../notifications/digest.ts";
import { NOTIFY_JOB } from "../notifications/notify.ts";
import { REFRESH_JOB } from "../pull-requests/refresh.ts";
import { WAKE_JOB } from "../sandboxes/orchestrate.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { JOB_MODULES, type JobKinds, jobHandlers } from "./registry.ts";
import { runDueJobs, runNow } from "./run.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const stored = async (id: string) => (await t.db.select().from(jobs)).find((job) => job.id === id)!;

test("the registry runs every kind the API records, each from one module", () => {
  expect(Object.keys(jobHandlers()).sort()).toEqual(
    [
      WEBHOOK_JOB,
      WAKE_JOB,
      REFRESH_JOB,
      BASE_REBUILD_JOB,
      PEOPLE_JOB,
      CANVAS_FILES_DELETE_JOB,
      SEARCH_REINDEX_JOB,
      NOTIFY_JOB,
      DELIVER_JOB,
      BADGE_JOB,
      DIGEST_JOB,
      ASSET_KEY_RETIRE_JOB,
      ACCOUNT_FORGET_JOB,
      MEMBERS_JOB,
    ].sort(),
  );
  const named = JOB_MODULES.flatMap((kinds) => Object.keys(kinds()));
  expect(named).toHaveLength(new Set(named).size);
});

test("two modules naming one kind is refused, not settled by whichever comes last", () => {
  const one = (): JobKinds => ({ "test.kind": async () => {} });
  expect(() => jobHandlers([one, one])).toThrow("Two modules run jobs of kind test.kind.");
});

test("run now: the job is recorded held, run past the response, and completed", async () => {
  // A workspace nobody has: the people job finds nothing to read and is done.
  const job = await runNow(t.deps, {
    kind: PEOPLE_JOB,
    key: "run-now-1",
    payload: { installationId: 404_404 },
  });
  expect(job).toMatchObject({ kind: PEOPLE_JOB, key: "run-now-1", attempts: 1 });
  expect(job!.lockedBy).toStartWith(`${PEOPLE_JOB}:`);
  // Nothing else can take it while this request holds it.
  expect(await runDueJobs(t.deps, "cron:test")).toEqual({ ran: 0, abandoned: 0 });

  await t.backgroundDone();
  const done = await stored(job!.id);
  expect(done.completedAt).toBeInstanceOf(Date);
  expect(done.lockedBy).toBeNull();
});

test("run now while the same job waits: the waiting one does it, and nothing runs twice", async () => {
  const later = new Date(t.clock.now() + 3_600_000);
  const waiting = await runNow(t.deps, {
    kind: PEOPLE_JOB,
    key: "run-now-2",
    payload: { installationId: 404_404 },
    runAt: later,
  });
  // Due later: recorded for the cron, held by nobody, and not run.
  expect(waiting).toMatchObject({ attempts: 0, lockedBy: null, runAt: later });
  expect(
    await runNow(t.deps, { kind: PEOPLE_JOB, key: "run-now-2", payload: { installationId: 1 } }),
  ).toBeNull();
  await t.backgroundDone();
  expect((await stored(waiting!.id)).completedAt).toBeNull();

  // The cron runs it once it is due.
  t.clock.advance(3_600_000);
  expect(await runDueJobs(t.deps, "cron:test")).toEqual({ ran: 1, abandoned: 0 });
  expect((await stored(waiting!.id)).completedAt).toBeInstanceOf(Date);
});

test("run now of a job that fails: it is given back, and the cron tries it again", async () => {
  // A payload no refresh can read: the attempt throws.
  const job = await runNow(t.deps, { kind: REFRESH_JOB, key: "run-now-3", payload: {} });
  await t.backgroundDone();
  const failed = await stored(job!.id);
  expect(failed).toMatchObject({ attempts: 1, completedAt: null, failedAt: null, lockedBy: null });
  expect(failed.lastError).toContain("ZodError");
  expect(failed.runAt.getTime()).toBe(t.clock.now() + 60_000);
  expect(t.logs.some((line) => line.event === "job_failed" && line.jobId === job!.id)).toBe(true);

  t.clock.advance(60_000);
  expect(await runDueJobs(t.deps, "cron:test")).toEqual({ ran: 1, abandoned: 0 });
  expect((await stored(job!.id)).attempts).toBe(2);
});
