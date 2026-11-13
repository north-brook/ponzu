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
  /** How many times it may be tried before it has failed for good. Five when left out. */
  maxAttempts?: number;
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
 * Whether a job of `kind` whose payload holds every field of `payload` is still to be run or
 * being run: for a request that must not go ahead while such a job could still act.
 */
export async function hasWaitingJob(
  db: Db,
  { kind, payload }: { kind: string; payload: Record<string, string> },
): Promise<boolean> {
  const [row] = await run(
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, kind),
          waiting,
          sql`${jobs.payload} @> ${JSON.stringify(payload)}::jsonb`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** The id of `recordOnce`'s row for `kind` and `key`: a query can look for it by its key. */
export function onceId(kind: string, key: string): string {
  return `once:${kind}:${key}`;
}

/**
 * Record that `kind` was done for `key`, once ever: true for the first caller, false for
 * every caller after, including one at the same moment. For work that must happen at most
 * once per window, like a cron step's hour (`apps/api/src/cron/steps.ts`): the key names the
 * window.
 *
 * The row is a job recorded already completed, so nothing claims or runs it. Its id is made
 * from the kind and key, so the primary key is what refuses a second: a concurrent insert of
 * the same id waits for the first to commit and then does nothing.
 *
 * "Once ever" holds for 30 days: the retention sweep (`retention.ts`) deletes finished jobs,
 * these marks among them, 30 days after they were recorded. So the key must name a window
 * that is over well before then; a mark meant to last longer needs a table of its own.
 */
export async function recordOnce(db: Db, { kind, key }: { kind: string; key: string }) {
  const [row] = await run(
    db
      .insert(jobs)
      .values({ id: onceId(kind, key), kind, key, completedAt: sql`now()` })
      .onConflictDoNothing()
      .returning({ id: jobs.id }),
  );
  return row !== undefined;
}

/** The kind of `recordHeartbeat`'s rows, which the retention sweep leaves alone. */
export const HEARTBEAT_KIND = "heartbeat";

/** The id of `recordHeartbeat`'s row for `name`. */
export function heartbeatId(name: string): string {
  return `beat:${name}`;
}

/**
 * Record that `name` happened at `at`: one row per name, moved forward and never back, so a
 * late or overlapping caller with an older time leaves a newer one in place. For "when did the
 * minute's cron last run" (`apps/api/src/cron/heartbeat.ts`), read back with `readHeartbeat`.
 *
 * The row is a job recorded already completed, like `recordOnce`'s, so nothing claims or runs
 * it, and it needs no table of its own. Unlike those marks it is kept however old it is
 * (`retention.ts` skips its kind): one row per name, holding a time and nothing personal, and a
 * heartbeat that went quiet a month ago must still read as quiet, not as never.
 */
export async function recordHeartbeat(db: Db, name: string, at: Date): Promise<void> {
  await run(
    db
      .insert(jobs)
      .values({ id: heartbeatId(name), kind: HEARTBEAT_KIND, key: name, completedAt: at })
      .onConflictDoUpdate({
        target: jobs.id,
        set: { completedAt: sql`greatest(${jobs.completedAt}, excluded.completed_at)` },
      }),
  );
}

/** When `name` last happened (`recordHeartbeat`), or null when it never has. */
export async function readHeartbeat(db: Db, name: string): Promise<Date | null> {
  const [row] = await run(
    db
      .select({ at: jobs.completedAt })
      .from(jobs)
      .where(eq(jobs.id, heartbeatId(name)))
      .limit(1),
  );
  return row?.at ?? null;
}

/**
 * Take up to `limit` jobs that are due and that nobody holds, or whose holder's lock has run
 * out, and count an attempt on each, oldest first. A job out of attempts is not taken;
 * `failAbandonedJobs` closes it.
 *
 * `for update skip locked` lets several workers claim at once: each takes different jobs and
 * none waits for another.
 *
 * `now` is what "due" is measured against, for a caller that sets `runAt` by its own clock;
 * Postgres's `now()` when left out. Locks always run on Postgres's.
 */
export async function claimJobs(
  db: Db,
  {
    worker,
    limit = 10,
    lockSeconds = JOB_LOCK_SECONDS,
    now,
  }: { worker: string; limit?: number; lockSeconds?: number; now?: Date },
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
          lte(jobs.runAt, now ?? sql`now()`),
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
 * Make the waiting job of this kind and key due at `now`, when it was put off to later and
 * nobody holds it: what it waited for has happened sooner. False when there is no such job.
 */
export async function bringJobForward(
  db: Db,
  { kind, key, now }: { kind: string; key: string; now: Date },
): Promise<boolean> {
  const moved = await run(
    db
      .update(jobs)
      .set({ runAt: now })
      .where(
        and(
          eq(jobs.kind, kind),
          eq(jobs.key, key),
          waiting,
          isNull(jobs.lockedBy),
          sql`${jobs.runAt} > ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: jobs.id }),
  );
  return moved.length > 0;
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
