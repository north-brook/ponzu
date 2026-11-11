import { claimJobs, completeJob, failAbandonedJobs, failJob, type Job } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { runWebhookJob, WEBHOOK_JOB } from "../github/webhook.ts";
import { REFRESH_JOB, runRefreshJob } from "../pull-requests/refresh.ts";
import { runWakeJob, WAKE_JOB } from "../sandboxes/wake.ts";

/*
 * Work that must finish even if the request that started it does not (docs/cloud.md, "The
 * sandbox"). A request records a job and runs it at once, holding it; the one-minute cron
 * (`routes/cron.ts`) runs whatever is due and nobody holds, which is a job whose attempt
 * failed, or whose request died. Every job is run at least once and may be run more than
 * once, so each kind's work is safe to repeat.
 */

export type JobDeps = Pick<
  Deps,
  "db" | "clock" | "vault" | "github" | "log" | "storage" | "config"
>;

/**
 * What runs a job of each kind. A kind is added here by the module whose work it is. Made when
 * asked, not when this module loads: a module that runs its own jobs imports this one, and may
 * be loaded first.
 */
const handlers = (): Record<string, (deps: JobDeps, payload: Job["payload"]) => Promise<void>> => ({
  [WEBHOOK_JOB]: runWebhookJob,
  [WAKE_JOB]: runWakeJob,
  [REFRESH_JOB]: runRefreshJob,
});

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
export async function runJob(
  deps: JobDeps,
  job: Pick<Job, "id" | "kind" | "payload" | "attempts">,
  worker: string,
): Promise<void> {
  const { db, clock, log } = deps;
  try {
    const handler = handlers()[job.kind];
    if (!handler) throw new Error(`Nothing runs jobs of kind ${job.kind}.`);
    await handler(deps, job.payload);
  } catch (error) {
    const wait = Math.min(RETRY_BASE_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS);
    await failJob(db, {
      id: job.id,
      worker,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "failed",
      retryAt: new Date(clock.now() + wait),
    });
    log.warn("job_failed", { jobId: job.id, kind: job.kind, attempts: job.attempts, error });
    return;
  }
  await completeJob(db, { id: job.id, worker });
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
