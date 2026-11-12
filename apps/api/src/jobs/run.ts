import {
  claimJobs,
  completeJob,
  enqueueJob,
  failAbandonedJobs,
  failJob,
  type Job,
  type NewJob,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { jobHandlers } from "./registry.ts";
import { RetryLater } from "./retry.ts";

/*
 * Work that must finish even if the request that started it does not (docs/cloud.md, "The
 * sandbox"). A request records a job and runs it at once, holding it; the one-minute cron
 * (`routes/cron.ts`) runs whatever is due and nobody holds, which is a job whose attempt
 * failed, or whose request died. Every job is run at least once and may be run more than
 * once, so each kind's work is safe to repeat. What runs each kind is in `registry.ts`.
 */

export type JobDeps = Pick<
  Deps,
  | "db"
  | "clock"
  | "vault"
  | "github"
  | "log"
  | "sandboxes"
  | "runnerBundle"
  | "poke"
  | "storage"
  | "config"
  | "analytics"
  | "features"
>;

/** A job as its handler sees it: which attempt this is, out of how many. */
export type RunningJob = Pick<Job, "id" | "kind" | "payload" | "attempts" | "maxAttempts">;

/** The wait before the next attempt: a minute after the first, doubling, at most an hour. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3600_000;

/** How many jobs one cron run takes. */
const CLAIM_LIMIT = 10;

/**
 * Run one job that `worker` holds, then complete it or, if it threw, give it back to be tried
 * again later (or, on its last attempt, to have failed for good). Never rejects for the job's
 * own failure: that is logged and recorded on the row.
 */
export async function runJob(deps: JobDeps, job: RunningJob, worker: string): Promise<void> {
  await runHeldJob(deps, job, worker, async () => {
    const handler = jobHandlers()[job.kind];
    if (!handler) throw new Error(`Nothing runs jobs of kind ${job.kind}.`);
    await handler(deps, job.payload, job);
  });
}

/**
 * Run `work` for a job `worker` holds, then complete the job or give it back as `runJob` does:
 * for a module that runs its own kind of job where it has less than `JobDeps` to hand. The
 * cron runs any retry through `runJob`.
 */
export async function runHeldJob(
  { db, clock, log, analytics }: Pick<JobDeps, "db" | "clock" | "log" | "analytics">,
  job: RunningJob,
  worker: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const later = error instanceof RetryLater;
    const wait = later ? error.ms : Math.min(RETRY_BASE_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS);
    await failJob(db, {
      id: job.id,
      worker,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "failed",
      retryAt: new Date(clock.now() + wait),
    });
    if (later) {
      log.info("job_waiting", { jobId: job.id, kind: job.kind, attempts: job.attempts, wait });
    } else {
      log.warn("job_failed", { jobId: job.id, kind: job.kind, attempts: job.attempts, error });
      analytics.exception(error, {
        job_kind: job.kind,
        job_id: job.id,
        attempt: job.attempts,
      });
    }
    return;
  }
  await completeJob(db, { id: job.id, worker });
}

/** What `runNow` takes: a job's deps, and somewhere to run it past the response. */
export type RunNowDeps = JobDeps & Pick<Deps, "background">;

/**
 * Record a job and run it at once, held, without waiting for it: the request's own instance
 * runs it through `deps.background`, and if that instance dies the lock runs out and the
 * minute's cron runs it instead. This is what `requestWake` does for a wake, for every other
 * kind: `notify`, a canvas's files purge and the like.
 *
 * A job of the same kind and key already waiting is left to do the work, and nothing new is
 * recorded or run: null. With `runAt` later than now the job is only recorded, for the cron to
 * run when it is due. Throws only when the job could not be recorded; the run itself never
 * rejects (`runJob`).
 */
export async function runNow(
  deps: RunNowDeps,
  job: Pick<NewJob, "kind" | "key" | "payload" | "runAt" | "maxAttempts">,
): Promise<Job | null> {
  const now = deps.clock.now();
  if (job.runAt && job.runAt.getTime() > now) return enqueueJob(deps.db, job);
  const worker = `${job.kind}:${crypto.randomUUID()}`;
  const recorded = await enqueueJob(deps.db, {
    ...job,
    runAt: job.runAt ?? new Date(now),
    lockedBy: worker,
  });
  if (recorded) deps.background(job.kind, runJob(deps, recorded, worker));
  return recorded;
}

/** What the cron does each minute: close what ran out of attempts, then run what is due. */
export async function runDueJobs(
  deps: JobDeps,
  worker: string,
): Promise<{ ran: number; abandoned: number }> {
  const { db, clock, log } = deps;
  const abandoned = await failAbandonedJobs(db);
  for (const job of abandoned) log.error("job_abandoned", { jobId: job.id, kind: job.kind });
  const jobs = await claimJobs(db, { worker, limit: CLAIM_LIMIT, now: new Date(clock.now()) });
  await Promise.all(jobs.map((job) => runJob(deps, job, worker)));
  return { ran: jobs.length, abandoned: abandoned.length };
}
