import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { jobs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failAbandonedJobs,
  failJob,
  HEARTBEAT_KIND,
  hasWaitingJob,
  readHeartbeat,
  recordHeartbeat,
  recordOnce,
} from "./jobs.ts";

// Claiming takes whatever is due, so each test gets a queue of its own.
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

const stored = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

/** Pretend the job was locked `seconds` ago. */
const lockedFor = (id: string, seconds: number) =>
  db
    .update(jobs)
    .set({ lockedAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(jobs.id, id));

test("a job is recorded, due now and held by nobody", async () => {
  const job = await enqueueJob(db, { kind: "wake", key: "cnv_1", payload: { canvasId: "cnv_1" } });

  expect(job!.id).toMatch(/^job_/);
  expect(job).toMatchObject({
    kind: "wake",
    key: "cnv_1",
    payload: { canvasId: "cnv_1" },
    attempts: 0,
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
  });
});

test("one unfinished job per kind and key", async () => {
  const first = await enqueueJob(db, { kind: "wake", key: "cnv_1" });

  // Two messages arrive together and both ask for the wake.
  expect(await enqueueJob(db, { kind: "wake", key: "cnv_1" })).toBeNull();
  // Another canvas, another kind of job, and jobs with no key are all separate.
  expect(await enqueueJob(db, { kind: "wake", key: "cnv_2" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sleep", key: "cnv_1" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sweep" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sweep" })).not.toBeNull();

  const [claimed] = await claimJobs(db, { worker: "w1", limit: 1 });
  expect(claimed!.id).toBe(first!.id);
  await completeJob(db, { id: first!.id, worker: "w1" });
  // Once it is finished the canvas can be woken again.
  expect(await enqueueJob(db, { kind: "wake", key: "cnv_1" })).not.toBeNull();
});

test("a claim takes due jobs, oldest first, and counts the attempt", async () => {
  const later = await enqueueJob(db, { kind: "a", runAt: new Date(Date.now() - 1_000) });
  const sooner = await enqueueJob(db, { kind: "b", runAt: new Date(Date.now() - 60_000) });
  await enqueueJob(db, { kind: "c", runAt: new Date(Date.now() + 60_000) });

  const first = await claimJobs(db, { worker: "w1", limit: 1 });
  const rest = await claimJobs(db, { worker: "w2" });

  expect(first).toMatchObject([{ id: sooner!.id, lockedBy: "w1", attempts: 1 }]);
  // The job for a minute from now is not due, and what w1 holds is not on offer.
  expect(rest).toMatchObject([{ id: later!.id, lockedBy: "w2", attempts: 1 }]);
  expect(await claimJobs(db, { worker: "w3" })).toEqual([]);
});

test("a claim can say what time it is, for jobs timed by the caller's clock", async () => {
  const at = new Date("2030-01-01T00:00:00Z");
  const job = await enqueueJob(db, { kind: "later", runAt: at });

  expect(await claimJobs(db, { worker: "w1" })).toEqual([]);
  expect(await claimJobs(db, { worker: "w1", now: new Date(at.getTime() - 1) })).toEqual([]);
  expect(await claimJobs(db, { worker: "w1", now: at })).toMatchObject([{ id: job!.id }]);
});

test("workers claiming at once take different jobs", async () => {
  for (let i = 0; i < 6; i++) await enqueueJob(db, { kind: "work" });

  const [one, two] = await Promise.all([
    claimJobs(db, { worker: "w1", limit: 3 }),
    claimJobs(db, { worker: "w2", limit: 3 }),
  ]);

  const ids = [...one, ...two].map((job) => job.id);
  expect(new Set(ids).size).toBe(6);
  expect(one.every((job) => job.lockedBy === "w1")).toBe(true);
  expect(two.every((job) => job.lockedBy === "w2")).toBe(true);
});

test("a job whose holder died is taken over when its lock runs out", async () => {
  const job = await enqueueJob(db, { kind: "wake", lockedBy: "request-1" });
  expect(job).toMatchObject({ lockedBy: "request-1", attempts: 1 });
  expect(await claimJobs(db, { worker: "cron" })).toEqual([]);

  await lockedFor(job!.id, 301);
  const [taken] = await claimJobs(db, { worker: "cron" });

  expect(taken).toMatchObject({ id: job!.id, lockedBy: "cron", attempts: 2 });
  // The first holder comes back to life and must not finish someone else's job.
  expect(await completeJob(db, { id: job!.id, worker: "request-1" })).toBe(false);
  expect(await failJob(db, { id: job!.id, worker: "request-1", error: "late" })).toBe(false);
  expect(await completeJob(db, { id: job!.id, worker: "cron" })).toBe(true);
});

test("a finished job is finished", async () => {
  const job = await enqueueJob(db, { kind: "wake" });
  await claimJobs(db, { worker: "w1" });

  expect(await completeJob(db, { id: job!.id, worker: "w1" })).toBe(true);

  expect(await stored(job!.id)).toMatchObject({ lockedAt: null, lockedBy: null });
  expect((await stored(job!.id)).completedAt).toBeInstanceOf(Date);
  expect(await completeJob(db, { id: job!.id, worker: "w1" })).toBe(false);
  expect(await claimJobs(db, { worker: "w2" })).toEqual([]);
});

test("a failed job goes back with its error, to be tried again when asked", async () => {
  const job = await enqueueJob(db, { kind: "wake" });
  await claimJobs(db, { worker: "w1" });

  const retryAt = new Date(Date.now() + 60_000);
  expect(await failJob(db, { id: job!.id, worker: "w1", error: "vercel 503", retryAt })).toBe(true);

  expect(await stored(job!.id)).toMatchObject({
    lastError: "vercel 503",
    lockedBy: null,
    attempts: 1,
    runAt: retryAt,
  });
  expect(await claimJobs(db, { worker: "w2" })).toEqual([]);

  await db.update(jobs).set({ runAt: new Date(Date.now() - 1_000) });
  expect(await claimJobs(db, { worker: "w2" })).toMatchObject([{ id: job!.id, attempts: 2 }]);
  // With no time given, it is due again at once.
  await failJob(db, { id: job!.id, worker: "w2", error: "again" });
  expect(await claimJobs(db, { worker: "w3" })).toMatchObject([{ id: job!.id, attempts: 3 }]);
});

test("a job that fails its last attempt has failed for good, and frees its key", async () => {
  const job = await enqueueJob(db, { kind: "wake", key: "cnv_1" });
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(await stored(job!.id)).toMatchObject({ failedAt: null });
    expect(await enqueueJob(db, { kind: "wake", key: "cnv_1" })).toBeNull();
    const [claimed] = await claimJobs(db, { worker: "w1" });
    expect(claimed).toMatchObject({ id: job!.id, attempts: attempt });
    await failJob(db, { id: job!.id, worker: "w1", error: "vercel 503" });
  }

  const dead = await stored(job!.id);
  expect(dead).toMatchObject({ attempts: 5, lastError: "vercel 503", lockedBy: null });
  expect(dead.failedAt).toBeInstanceOf(Date);
  expect(dead.completedAt).toBeNull();
  expect(await claimJobs(db, { worker: "w2" })).toEqual([]);
  // Vercel was down for a few minutes. The canvas can be woken again.
  const next = await enqueueJob(db, { kind: "wake", key: "cnv_1" });
  expect(next).toMatchObject({ kind: "wake", key: "cnv_1", attempts: 0 });
});

test("a job whose worker died on its last attempt is closed by the sweep", async () => {
  const job = await enqueueJob(db, { kind: "wake", key: "cnv_1" });
  await db.update(jobs).set({ attempts: 4 });
  await claimJobs(db, { worker: "w1" });
  const held = await enqueueJob(db, { kind: "sleep", key: "cnv_1" });
  await claimJobs(db, { worker: "w2" });

  // While w1 may still be working, the job is neither taken over nor written off.
  expect(await failAbandonedJobs(db)).toEqual([]);
  expect(await claimJobs(db, { worker: "cron" })).toEqual([]);
  expect(await enqueueJob(db, { kind: "wake", key: "cnv_1" })).toBeNull();

  await lockedFor(job!.id, 301);
  await lockedFor(held!.id, 301);
  const abandoned = await failAbandonedJobs(db);

  // Only the one out of attempts; the other has attempts left and goes round again.
  expect(abandoned).toMatchObject([{ id: job!.id, attempts: 5, lockedBy: null }]);
  expect(abandoned[0]!.failedAt).toBeInstanceOf(Date);
  expect(await failAbandonedJobs(db)).toEqual([]);
  expect(await enqueueJob(db, { kind: "wake", key: "cnv_1" })).not.toBeNull();
  // The worker that died comes back and cannot finish what was closed without it.
  expect(await completeJob(db, { id: job!.id, worker: "w1" })).toBe(false);
});

test("something recorded once is refused after, at once or later, and is never claimed", async () => {
  const slot = { kind: "cron.step", key: "selfcheck@2026-11-12T10:00:00.000Z" };
  const [first, second] = await Promise.all([recordOnce(db, slot), recordOnce(db, slot)]);
  expect([first, second].sort()).toEqual([false, true]);
  expect(await recordOnce(db, slot)).toBe(false);
  // Another window, or another kind, is its own.
  expect(await recordOnce(db, { ...slot, key: "selfcheck@2026-11-12T11:00:00.000Z" })).toBe(true);
  expect(await recordOnce(db, { ...slot, kind: "other" })).toBe(true);
  // Recorded as done: nothing runs it, and it does not stand in the way of a job of that key.
  expect(await claimJobs(db, { worker: "cron" })).toEqual([]);
  expect(await failAbandonedJobs(db)).toEqual([]);
  expect(await enqueueJob(db, slot)).not.toBeNull();
});

test("a heartbeat is one row, moved forward and never back, and is never claimed", async () => {
  expect(await readHeartbeat(db, "cron.minute")).toBeNull();
  const at = new Date("2026-11-12T10:00:00.000Z");
  await recordHeartbeat(db, "cron.minute", at);
  expect(await readHeartbeat(db, "cron.minute")).toEqual(at);

  const later = new Date(at.getTime() + 60_000);
  // A late or overlapping caller with an older time, at the same moment as a newer one.
  await Promise.all([
    recordHeartbeat(db, "cron.minute", later),
    recordHeartbeat(db, "cron.minute", new Date(at.getTime() - 60_000)),
  ]);
  expect(await readHeartbeat(db, "cron.minute")).toEqual(later);
  await recordHeartbeat(db, "cron.minute", at);
  expect(await readHeartbeat(db, "cron.minute")).toEqual(later);

  // Another name is its own; the rows are finished jobs nobody runs.
  expect(await readHeartbeat(db, "other")).toBeNull();
  const rows = await db.select().from(jobs);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: HEARTBEAT_KIND, key: "cron.minute", completedAt: later });
  expect(await claimJobs(db, { worker: "cron" })).toEqual([]);
  expect(await failAbandonedJobs(db)).toEqual([]);
});

test("a job waits, by its payload, until it is finished", async () => {
  const forget = { kind: "account.forget", payload: { workosUserId: "user_w1" } };
  expect(await hasWaitingJob(db, forget)).toBe(false);

  const job = await enqueueJob(db, {
    kind: "account.forget",
    key: "usr_1",
    payload: { userId: "usr_1", workosUserId: "user_w1" },
  });
  expect(await hasWaitingJob(db, forget)).toBe(true);
  // Another WorkOS user, or another kind with the same payload, is not it.
  expect(await hasWaitingJob(db, { ...forget, payload: { workosUserId: "user_w2" } })).toBe(false);
  expect(await hasWaitingJob(db, { ...forget, kind: "account.other" })).toBe(false);

  // Being run still counts; finished does not.
  await claimJobs(db, { worker: "w1" });
  expect(await hasWaitingJob(db, forget)).toBe(true);
  await completeJob(db, { id: job!.id, worker: "w1" });
  expect(await hasWaitingJob(db, forget)).toBe(false);
});
