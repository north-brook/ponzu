import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { type Json, jobs } from "../schema/index.ts";

export type Job = typeof jobs.$inferSelect;

/** How long a worker holds a job before another may take it over. */
export const JOB_LOCK_SECONDS = 300;

export interface NewJob {
  kind: string;
  /** What it is about. While a job of this kind and key is unfinished, another is not added. */
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

/** Record a job. Null when an unfinished job of the same kind and key is already recorded. */
export async function enqueueJob(db: Db, job: NewJob): Promise<Job | null> {
  const { lockedBy, ...columns } = job;
  const [row] = await db
    .insert(jobs)
    .values({
      ...columns,
      id: newId("job"),
      ...(lockedBy ? { lockedBy, lockedAt: sql`now()`, attempts: 1 } : {}),
    })
    .onConflictDoNothing({ target: [jobs.kind, jobs.key], where: isNull(jobs.completedAt) })
    .returning();
  return row ?? null;
}

/**
 * Take up to `limit` jobs that are due and that nobody holds, or whose holder's lock has run
 * out, and count an attempt on each. A job out of attempts is left alone.
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
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        isNull(jobs.completedAt),
        lte(jobs.runAt, sql`now()`),
        lt(jobs.attempts, jobs.maxAttempts),
        or(
          isNull(jobs.lockedAt),
          sql`${jobs.lockedAt} < now() - make_interval(secs => ${lockSeconds})`,
        ),
      ),
    )
    .orderBy(jobs.runAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(jobs)
    .set({ lockedAt: sql`now()`, lockedBy: worker, attempts: sql`${jobs.attempts} + 1` })
    .where(inArray(jobs.id, due))
    .returning();
}

/** Finish a job. False when `worker` no longer holds it: its lock ran out and someone else took it. */
export async function completeJob(
  db: Db,
  { id, worker }: { id: string; worker: string },
): Promise<boolean> {
  const done = await db
    .update(jobs)
    .set({ completedAt: sql`now()`, lockedAt: null, lockedBy: null })
    .where(held(id, worker))
    .returning({ id: jobs.id });
  return done.length > 0;
}

/**
 * Give a job back after a failed attempt, to be tried again at `retryAt` (now, when left out)
 * if it has attempts left. False when `worker` no longer holds it.
 */
export async function failJob(
  db: Db,
  { id, worker, error, retryAt }: { id: string; worker: string; error: string; retryAt?: Date },
): Promise<boolean> {
  const released = await db
    .update(jobs)
    .set({ lastError: error, lockedAt: null, lockedBy: null, runAt: retryAt ?? sql`now()` })
    .where(held(id, worker))
    .returning({ id: jobs.id });
  return released.length > 0;
}

const held = (id: string, worker: string) =>
  and(eq(jobs.id, id), eq(jobs.lockedBy, worker), isNull(jobs.completedAt));
