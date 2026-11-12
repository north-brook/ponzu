import {
  type AgentBlocker,
  bringJobForward,
  enqueueJob,
  getAwakeSandboxAddress,
  liftAgentBlockers,
  touchSandbox,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { type JobDeps, runJob } from "../jobs/run.ts";
import { runnerTarget } from "./environment.ts";
import { WAKE_ATTEMPTS, WAKE_JOB } from "./orchestrate.ts";

/*
 * The one door from what people do to a canvas's sandbox (docs/cloud.md, "The sandbox" and
 * "Events"). Every route that adds to a canvas's feed, and every op a person commits, calls
 * `requestWake` once it has written, and nothing else reaches for the sandbox:
 *
 *   POST /v1/canvases (with a first message)          "message"
 *   POST /v1/canvases/:id/messages                    "message"
 *   POST /v1/canvases/:id/questions/:id/answer        "answer"
 *   POST /v1/canvases/:id/stop                        "stop"
 *   a person's ops (commitPost), undo and redo       "comment" when the ops left a comment for
 *                                                    the agent, else "edit"
 *   POST /v1/canvases/:id/pull-request (Create PR,    "push": the runner pushes commits only
 *   with commits only the sandbox holds)              the sandbox holds
 *
 * Every reason keeps an awake sandbox awake for longer and pokes its runner. A message, an
 * answer or a comment also records a wake (`orchestrate.ts`), which this request starts at
 * once and the cron finishes if it does not. GitHub's news for the agent (a failed check, a
 * review) comes in a webhook's job instead, which only records one (`queueWake`).
 */

export type WakeReason = "message" | "answer" | "comment" | "stop" | "edit" | "push";

/** What waking takes. A caller of `requestWake` takes these with its own (`CommitDeps`). */
export type WakeDeps = JobDeps & Pick<Deps, "background">;

/**
 * What wakes a sleeping sandbox: a message, an answer or a comment (priority `now` or `next`), and
 * Create PR asking for commits only the sandbox holds (`push`).
 * A person's edit (`later`) does not, and neither does a stop: a sleeping sandbox is running
 * nothing to stop, and the stop is in the feed for when it next wakes.
 */
const WAKES: Record<WakeReason, boolean> = {
  message: true,
  answer: true,
  comment: true,
  stop: false,
  edit: false,
  push: true,
};

/**
 * Something happened to `canvasId` that its runner should hear of: keep its sandbox awake,
 * wake it when the reason calls for one, and poke the runner when it is awake (`POST /poke` on
 * its port, with the port's bearer; a 502 or 503 just after a start is tried again for a second). Call it after
 * the event or op is written.
 *
 * It never fails: what the caller wrote is written, and a request that answered 5xx for it
 * would be sent again and write it twice. A wake it could not record is logged
 * (`wake_failed`), and the event waits in the feed until the sandbox next wakes. The poke is
 * not retried: an awake runner claims once a minute by itself.
 */
export async function requestWake(
  deps: WakeDeps,
  canvasId: string,
  reason: WakeReason,
): Promise<void> {
  try {
    await wake(deps, canvasId, reason);
  } catch (error) {
    deps.log.error("wake_failed", { canvasId, reason, error });
  }
}

/**
 * Record a wake for the canvas and run it, for work that is not a person's request: the cron
 * bringing back a dead runner, or Claude being connected. Resolves once this attempt is over;
 * when a wake was already waiting, at once, since that one will do.
 */
export async function startWake(deps: JobDeps, canvasId: string, reason: string): Promise<void> {
  const recorded = await recordWake(deps, canvasId, reason);
  if (recorded) await runJob(deps, recorded.job, recorded.worker);
}

/**
 * Record a wake for the canvas for the minute's cron to run, held by nobody: for news from
 * GitHub (a failed check, a review), whose webhook job should not wait on a sandbox starting.
 */
export async function queueWake(
  deps: Pick<JobDeps, "db" | "clock">,
  canvasId: string,
  reason: string,
): Promise<void> {
  await enqueueJob(deps.db, {
    kind: WAKE_JOB,
    key: canvasId,
    payload: { canvasId, reason },
    runAt: new Date(deps.clock.now()),
    maxAttempts: WAKE_ATTEMPTS,
  });
}

/** How many wakes `resumeBlocked` starts at once; the minute's cron runs the rest. */
export const RESUME_AT_ONCE = 20;

/**
 * What a wake gate waited on has changed (a card added, the cap raised, wakes no longer
 * paused, a Claude plan's limit reset): lift `blockers` from the canvases they hold, in a
 * workspace, on a Claude account (`accountId`), or everywhere when neither is given, and wake
 * those whose feed holds something their agent must take up. The most recently active
 * `RESUME_AT_ONCE` are started now and the rest queued for the minute's cron; a wake a gate put
 * off to later is made due now instead, and the cron runs it. A canvas with nothing owed is
 * only lifted: it wakes at its next message. A gate that still holds one back says so again at
 * its wake.
 */
export async function resumeBlocked(
  deps: WakeDeps,
  {
    workspaceId,
    accountId,
    blockers,
  }: { workspaceId?: string; accountId?: string; blockers: readonly AgentBlocker[] },
): Promise<{ lifted: number; started: number; queued: number }> {
  const lifted = await liftAgentBlockers(deps.db, {
    blockers,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(accountId === undefined ? {} : { claudeAccountId: accountId }),
  });
  const owed = lifted.filter((canvas) => canvas.pending);
  const now = new Date(deps.clock.now());
  let started = 0;
  for (const [index, canvas] of owed.entries()) {
    const key = canvas.id;
    if (await bringJobForward(deps.db, { kind: WAKE_JOB, key, now })) continue;
    if (index < RESUME_AT_ONCE) {
      deps.background("wake", startWake(deps, canvas.id, "resume"));
      started++;
    } else {
      await queueWake(deps, canvas.id, "resume");
    }
  }
  const counts = { lifted: lifted.length, started, queued: owed.length - started };
  // Asked every minute by the cron's `maintenance` step: said only when it lifted something.
  if (lifted.length > 0) {
    deps.log.info("blocked_resumed", { blockers, workspaceId, accountId, ...counts });
  }
  return counts;
}

/** A wake for the canvas held by a new worker, or null when one is already waiting. */
async function recordWake(deps: Pick<JobDeps, "db" | "clock">, canvasId: string, reason: string) {
  const worker = `wake:${crypto.randomUUID()}`;
  const job = await enqueueJob(deps.db, {
    kind: WAKE_JOB,
    key: canvasId,
    payload: { canvasId, reason },
    runAt: new Date(deps.clock.now()),
    maxAttempts: WAKE_ATTEMPTS,
    lockedBy: worker,
  });
  return job && { job, worker };
}

async function wake(deps: WakeDeps, canvasId: string, reason: WakeReason): Promise<void> {
  // First, so that an idle stop the wake might find the sandbox awake for cannot begin after
  // it looked: that stop holds to nobody having kept the sandbox awake since it went idle.
  await touchSandbox(deps.db, { canvasId, now: new Date(deps.clock.now()) });
  const [recorded, sandbox] = await Promise.all([
    WAKES[reason] ? recordWake(deps, canvasId, reason) : null,
    getAwakeSandboxAddress(deps.db, canvasId),
  ]);
  if (recorded) deps.background("wake", runJob(deps, recorded.job, recorded.worker));
  if (!sandbox) return;
  deps.background(
    "poke",
    (async () => {
      const target = await runnerTarget(deps, sandbox);
      if (target) await deps.poke(target);
    })(),
  );
}
