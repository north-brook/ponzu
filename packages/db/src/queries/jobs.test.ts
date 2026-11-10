import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { jobs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { claimJobs, completeJob, enqueueJob, failJob } from "./jobs.ts";

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
  const job = await enqueueJob(db, { kind: "wake", key: "des_1", payload: { designId: "des_1" } });

  expect(job!.id).toMatch(/^job_/);
  expect(job).toMatchObject({
    kind: "wake",
    key: "des_1",
    payload: { designId: "des_1" },
    attempts: 0,
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
  });
});

test("one unfinished job per kind and key", async () => {
  const first = await enqueueJob(db, { kind: "wake", key: "des_1" });

  // Two messages arrive together and both ask for the wake.
  expect(await enqueueJob(db, { kind: "wake", key: "des_1" })).toBeNull();
  // Another design, another kind of job, and jobs with no key are all separate.
  expect(await enqueueJob(db, { kind: "wake", key: "des_2" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sleep", key: "des_1" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sweep" })).not.toBeNull();
  expect(await enqueueJob(db, { kind: "sweep" })).not.toBeNull();

  const [claimed] = await claimJobs(db, { worker: "w1", limit: 1 });
  expect(claimed!.id).toBe(first!.id);
  await completeJob(db, { id: first!.id, worker: "w1" });
  // Once it is finished the design can be woken again.
  expect(await enqueueJob(db, { kind: "wake", key: "des_1" })).not.toBeNull();
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
  expect(await failJob(db, { id: job!.id, worker: "w1", error: "boat 503", retryAt })).toBe(true);

  expect(await stored(job!.id)).toMatchObject({
    lastError: "boat 503",
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

test("a job out of attempts is left alone", async () => {
  const job = await enqueueJob(db, { kind: "wake" });
  await db.update(jobs).set({ attempts: 5 });

  expect(await claimJobs(db, { worker: "w1" })).toEqual([]);
  expect(await stored(job!.id)).toMatchObject({ attempts: 5, completedAt: null });
});
