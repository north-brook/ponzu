import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { type Json, jobs } from "../schema/index.ts";
import { run } from "./run.ts";

export type Job = typeof jobs.$inferSelect;

/** How long a worker holds a job before another may take it over. */
export const JOB_LOCK_SECONDS = 300;

export interface NewJob {
  kind: string;
  /** What it is about. While a job of this kind and key is waiting, another is not added. */
  key?: string;
  payload?: Json;
  /** Now, when left out. */
  runAt?: Date;
  /**
   * Take the job as it is recorded, for a request that records a job and runs it itself. If
   * that request dies, the lock runs out and the cron takes the job over.
   */
  lockedBy?: string;
}

/** Neither completed nor failed: still to be run, or being run. */
const waiting = and(isNull(jobs.completedAt), isNull(jobs.failedAt));

/** Held by nobody, or by a worker whose lock has run out. */
const free = (lockSeconds: number) =>
  or(isNull(jobs.lockedAt), sql`${jobs.lockedAt} < now() - make_interval(secs => ${lockSeconds})`);

/**
 * Record a job. Null when a job of the same kind and key is already waiting. One that
 * completed, or failed for good, is over and does not stand in the way of a new one.
 */
export async function enqueueJob(db: Db, job: NewJob): Promise<Job | null> {
  const { lockedBy, ...columns } = job;
  const [row] = await run(
    db
      .insert(jobs)
      .values({
        ...columns,
        id: newId("job"),
        ...(lockedBy ? { lockedBy, lockedAt: sql`now()`, attempts: 1 } : {}),
      })
      .onConflictDoNothing({ target: [jobs.kind, jobs.key], where: waiting })
      .returning(),
  );
  return row ?? null;
}

/**
 * Take up to `limit` jobs that are due and that nobody holds, or whose holder's lock has run
 * out, and count an attempt on each, oldest first. A job out of attempts is not taken;
 * `failAbandonedJobs` closes it.
 *
 * `for update skip locked` lets several workers claim at once: each takes different jobs and
 * none waits for another.
 */
export async function claimJobs(
  db: Db,
  {
    worker,
    limit = 10,
    lockSeconds = JOB_LOCK_SECONDS,
  }: { worker: string; limit?: number; lockSeconds?: number },
): Promise<Job[]> {
  // In `with`, so that it runs once. As a subquery of the update it is run again for each
  // row whenever the planner joins by nested loop, and each run locks the next `limit` rows.
  const due = db.$with("due").as(
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          waiting,
          lte(jobs.runAt, sql`now()`),
          lt(jobs.attempts, jobs.maxAttempts),
          free(lockSeconds),
        ),
      )
      .orderBy(jobs.runAt)
      .limit(limit)
      .for("update", { skipLocked: true }),
  );
  const claimed = await run(
    db
      .with(due)
      .update(jobs)
      .set({ lockedAt: sql`now()`, lockedBy: worker, attempts: sql`${jobs.attempts} + 1` })
      .where(inArray(jobs.id, db.select({ id: due.id }).from(due)))
      .returning(),
  );
  return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

/** Finish a job. False when `worker` no longer holds it: its lock ran out and someone else took it. */
export async function completeJob(
  db: Db,
  { id, worker }: { id: string; worker: string },
): Promise<boolean> {
  const done = await run(
    db
      .update(jobs)
      .set({ completedAt: sql`now()`, lockedAt: null, lockedBy: null })
      .where(held(id, worker))
      .returning({ id: jobs.id }),
  );
  return done.length > 0;
}

/**
 * Give a job back after a failed attempt. With attempts left it is tried again at `retryAt`
 * (now, when left out); on its last attempt it has failed for good. False when `worker` no
 * longer holds it.
 */
export async function failJob(
  db: Db,
  { id, worker, error, retryAt }: { id: string; worker: string; error: string; retryAt?: Date },
): Promise<boolean> {
  const released = await run(
    db
      .update(jobs)
      .set({
        lastError: error,
        lockedAt: null,
        lockedBy: null,
        runAt: retryAt ?? sql`now()`,
        failedAt: sql`case when ${jobs.attempts} >= ${jobs.maxAttempts} then now() end`,
      })
      .where(held(id, worker))
      .returning({ id: jobs.id }),
  );
  return released.length > 0;
}

/**
 * Close the jobs that are out of attempts with no worker left holding them: whoever had the
 * last attempt died before it could say how it went. Until such a job is closed, nothing of
 * its kind and key can be recorded. The cron calls this on every sweep, and gets the jobs
 * back so that it can act on what will now never happen.
 */
export function failAbandonedJobs(
  db: Db,
  { lockSeconds = JOB_LOCK_SECONDS }: { lockSeconds?: number } = {},
): Promise<Job[]> {
  return run(
    db
      .update(jobs)
      .set({ failedAt: sql`now()`, lockedAt: null, lockedBy: null })
      .where(and(waiting, gte(jobs.attempts, jobs.maxAttempts), free(lockSeconds)))
      .returning(),
  );
}

const held = (id: string, worker: string) =>
  and(eq(jobs.id, id), eq(jobs.lockedBy, worker), isNull(jobs.completedAt));
