import {
  beginSandbox,
  claimSandbox,
  getCheckpointCover,
  getSandbox,
  getWakeContext,
  moveSandbox,
  recordDesignClaudeAccount,
  revokeRunnerToken,
  revokeRunnerTokens,
  type SandboxClaim,
  type SandboxRow,
  showAgentWaiting,
  type WakeContext,
} from "@ponzu/db";
import { IMAGE_COMMANDS, RUNNER_PORT } from "@ponzu/runner/protocol";
import {
  type At,
  designSandboxName,
  SandboxError,
  type SandboxErrorCode,
  type SandboxSpec,
} from "@ponzu/sandbox";
import type { WakeStart } from "../analytics/events.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import {
  SANDBOX_VCPUS,
  SESSION_TIMEOUT_MS,
  SNAPSHOT_EXPIRATION_MS,
  STOP_COMMAND_MS,
} from "./constants.ts";
import {
  claudeProblem,
  credentialMark,
  type Environment,
  newEnvironment,
  portBinding,
} from "./environment.ts";

/*
 * Waking a design's sandbox (docs/cloud.md, "The sandbox"): the job `requestWake` records, run
 * at once by the request and again by the cron until it is done. The database decides who does
 * it: a wake first claims the design's row (`waking`, held by the wake's job), so of any number
 * of wakes racing one starts the runner and the rest leave it be. The claim counts the
 * sandboxes already up in the workspace and for the owner; one past the limits waits.
 *
 *   no row                 insert it as waking, under the limits
 *   asleep                 waking
 *   stopping               wait up to 30 s for the stop to land, then as asleep; else retry later
 *   awake, same credential nothing: the request's poke reached it
 *   awake, old credential  waking: a restart in place
 *   waking, held by another wake inside its lease   nothing
 *
 * Then one path covers a create, a resume and a restart in place: `up()` (the only call that
 * resumes; it creates, recreates on a new image, or resumes), `ponzu-stop` if the session was
 * already running (a restart, or a session left running), then `ponzu-start` detached with the
 * runner's environment. The row is awake once the start is sent; the runner claims by itself as
 * soon as it is up.
 *
 * Vercel rate-limiting, being busy, being away, or a session that ended between `up()` and the
 * start, is waited out: the job is tried again, and the head says it is waiting.
 */

/** The job that wakes a design's sandbox. One waits per design: its key is the design's id. */
export const WAKE_JOB = "sandbox.wake";
/** A wake keeps trying for about three hours of waits before it gives up. */
export const WAKE_ATTEMPTS = 40;
/** How long one attempt waits for a stop under way to land, and how often it looks. */
const STOP_WAIT_MS = 30_000;
const STOP_POLL_MS = 1_000;
/** Waits between attempts when Vercel does not say how long: from 15 s, doubling, to 5 min. */
const WAIT_BASE_MS = 15_000;
const WAIT_MAX_MS = 5 * 60_000;

/** Refusals that pass: Vercel limits the pace, is busy or away, or the session ended. */
const WAITS: ReadonlySet<SandboxErrorCode> = new Set([
  "rate_limited",
  "busy",
  "unavailable",
  "not_running",
]);

/** A design's sandbox's name at Vercel. */
export function sandboxName(deps: Pick<JobDeps, "config">, designId: string): string {
  return designSandboxName(deps.config.sandbox.scope, designId);
}

/** A design's sandbox's spec, on `image`. */
export function designSpec(image: string): SandboxSpec {
  return {
    image,
    persistent: true,
    ports: [RUNNER_PORT],
    timeoutMs: SESSION_TIMEOUT_MS,
    snapshotExpirationMs: SNAPSHOT_EXPIRATION_MS,
    vcpus: SANDBOX_VCPUS,
  };
}

export async function runWakeJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
): Promise<void> {
  await wakeDesign(deps, String(payload.designId), job);
}

/** The wake job running: its id is what holds the row while it is `waking`. */
type Wake = Pick<RunningJob, "id" | "attempts" | "maxAttempts">;

/**
 * Make sure the design's runner is running on its owner's current Claude credential. Safe to
 * run twice at once and again after a crash at any point.
 */
export async function wakeDesign(deps: JobDeps, designId: string, job: Wake): Promise<void> {
  const { db, clock, log } = deps;
  const began = clock.now();
  const context = await getWakeContext(db, designId);
  if (!context || context.status === "settled") return;

  // Nothing to start it with. The event waits in the feed; what is missing wakes it once it's
  // there, or the next message does.
  const problem = context.ownerMember ? claudeProblem(context.claude, began) : "claude_owner_left";
  if (problem) {
    await showAgentWaiting(db, { designId, waking: false, blocker: problem });
    log.info("wake_blocked", { designId, blocker: problem });
    return;
  }
  await recordDesignClaudeAccount(db, { designId, claudeAccountId: context.claude!.id });

  try {
    const waking = await claim(deps, context, job.id);
    if (!waking) return;
    const woke = await bringUp(deps, context, waking, job.id);
    if (!woke) return;
    const ms = clock.now() - began;
    log.info("sandbox_awake", { designId, start: woke.start, fresh: woke.fresh, ms });
    // About the design's owner, whose Claude it runs on: whoever's message woke it, it runs
    // for them.
    deps.analytics.capture(
      "sandbox woke",
      {
        design_id: designId,
        start: woke.start,
        duration_ms: ms,
        fresh: woke.fresh,
        recreated: woke.recreated,
        image: woke.image,
      },
      { distinctId: context.ownerId, workspaceId: context.workspaceId },
    );
  } catch (error) {
    if (!(error instanceof SandboxError)) throw error;
    if (WAITS.has(error.code) && job.attempts < job.maxAttempts) {
      const blocker = error.code === "rate_limited" ? "sandbox_busy" : null;
      await showAgentWaiting(db, { designId, waking: true, blocker });
      throw new RetryLater(waitAfter(error, job.attempts), error.message);
    }
    // It will not start this way, or it has been tried long enough. The next message tries again.
    await moveSandbox(db, {
      designId,
      from: ["waking"],
      to: "asleep",
      now: new Date(clock.now()),
      by: job.id,
      changes: { failure: error.message.slice(0, 500) },
    });
    await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { designId, refusal: error.code, error });
  }
}

/**
 * The design's row, now `waking` and held by the wake `by`; null when there is nothing for this
 * wake to do (another holds it, or it is awake on the credential it should be).
 */
async function claim(deps: JobDeps, context: WakeContext, by: string): Promise<SandboxRow | null> {
  const { db, clock } = deps;
  const { limits } = deps.config.sandbox;
  const { designId } = context;
  let row = context.sandbox;
  const now = () => new Date(clock.now());
  if (!row) return claimed(await beginSandbox(db, { designId, now: now(), by, limits }));
  if (row.state === "stopping") {
    await showAgentWaiting(db, { designId, waking: true, blocker: null });
    row = await afterStop(deps, designId);
    if (!row) return claim(deps, { ...context, sandbox: null }, by);
  }
  switch (row.state) {
    case "asleep":
      return claimed(
        await claimSandbox(db, { designId, from: ["asleep"], now: now(), by, limits }),
      );
    case "awake":
      // On the credential it should be: the request's poke reached it.
      if (row.claudeCredential === credentialMark(context.claude!)) return null;
      // A restart in place, on the owner's new credential.
      return claimed(await claimSandbox(db, { designId, from: ["awake"], now: now(), by, limits }));
    case "waking":
      // Its own, from an earlier attempt, or one left past its lease.
      return claimed(
        await claimSandbox(db, { designId, from: ["waking"], now: now(), by, limits }),
      );
    default:
      return null;
  }
}

/**
 * The row once the stop under way has landed, or null when it is gone (a retire deleted it). A
 * wake into a session whose runner is shutting down would be stopped under it, and a retire
 * holds the row until its sandbox is deleted, so a late delete never hits a new sandbox.
 */
async function afterStop(deps: JobDeps, designId: string): Promise<SandboxRow | null> {
  const until = deps.clock.now() + STOP_WAIT_MS;
  for (;;) {
    await deps.clock.sleep(STOP_POLL_MS);
    const row = await getSandbox(deps.db, designId);
    if (row?.state !== "stopping") return row;
    if (deps.clock.now() >= until) {
      throw new SandboxError("busy", "A stop of the design's sandbox is still under way.");
    }
  }
}

/** The row a claim took. Past the limits it waits, and the head says so. */
function claimed(claim: SandboxClaim): SandboxRow | null {
  if (claim && "full" in claim) {
    throw new SandboxError(
      "rate_limited",
      "As many sandboxes are up in this workspace, or for this owner, as may be.",
    );
  }
  return claim?.sandbox ?? null;
}

/** How a wake went. */
interface Woke {
  start: WakeStart;
  fresh: boolean;
  recreated: boolean;
  image: string;
}

/**
 * The runner started in the design's sandbox, and the row awake on it. Null when the row was
 * taken from this wake meanwhile (a retire, or another wake after the lease).
 */
async function bringUp(
  deps: JobDeps,
  context: WakeContext,
  waking: SandboxRow,
  by: string,
): Promise<Woke | null> {
  const { db, clock, vault, sandboxes } = deps;
  const { designId } = context;
  const claude = context.claude!;
  await showAgentWaiting(db, { designId, waking: true, blocker: null });

  const name = sandboxName(deps, designId);
  const image = await imageFor(deps, waking);
  const up = await sandboxes.up(name, designSpec(image));
  const at: At = { name, sessionId: up.sessionId };
  let environment: Environment | null = null;
  try {
    // Whatever runs there (a runner on an old credential, a leaked session, a supervisor of an
    // older runner) is shut down first; `ponzu-start` would otherwise find its lock taken.
    if (up.wasRunning) {
      await sandboxes.exec(at, {
        cmd: IMAGE_COMMANDS.stop,
        sudo: true,
        timeoutMs: STOP_COMMAND_MS,
      });
    }
    environment = await newEnvironment(deps, designId, claude);
    await sandboxes.start(at, {
      cmd: IMAGE_COMMANDS.start,
      env: environment.env,
      sudo: true,
    });
    const encryptedPortToken = await vault.seal(environment.portToken, portBinding(designId));
    // A restart in place keeps the session, and with it when the session began.
    const sessionStartedAt =
      waking.sessionId === up.sessionId && waking.sessionStartedAt
        ? waking.sessionStartedAt
        : new Date(up.startedAt);
    const awake = await moveSandbox(db, {
      designId,
      from: ["waking"],
      to: "awake",
      now: new Date(clock.now()),
      by,
      changes: {
        sessionId: up.sessionId,
        sessionStartedAt,
        address: up.urls[RUNNER_PORT] ?? null,
        encryptedPortToken,
        expiresAt: new Date(up.expiresAt),
        image,
        runnerTokenId: environment.runnerTokenId,
        claudeCredential: environment.claudeCredential,
      },
    });
    if (!awake) {
      // Taken from this wake (a retire, a repair, or a wake after the lease).
      await revokeRunnerToken(db, environment.runnerTokenId);
      await letGo(deps, designId, at);
      return null;
    }
    // The runner it replaced, if any, hears at its next call that it is done.
    await revokeRunnerTokens(db, designId, { except: environment.runnerTokenId });
    return {
      start: up.wasRunning ? "restart" : up.fresh ? "create" : "resume",
      fresh: up.fresh,
      recreated: up.recreated,
      image,
    };
  } catch (error) {
    if (environment) await revokeRunnerToken(db, environment.runnerTokenId);
    // `up()` resumed or created a session that serves nothing now: stopped, whatever the
    // refusal, so a wake that is tried again (or gives up) leaves no VM running behind a row
    // that is not awake. The next attempt's `up()` resumes it in a couple of seconds.
    await stopQuietly(deps, at);
    throw error;
  }
}

/** Stop `at`, best effort: a stop that fails is left to the session's timeout and reconcile. */
async function stopQuietly(deps: JobDeps, at: At): Promise<void> {
  await deps.sandboxes.stop(at).catch((stop: unknown) => {
    deps.log.warn("sandbox_stop_failed", { name: at.name, sessionId: at.sessionId, error: stop });
  });
}

/**
 * A wake whose row was taken from it after its `up()`: what it started is stopped unless the
 * row's holder now runs on that same session (a wake after the lease, which shuts down whatever
 * runs there itself), and the sandbox is removed when its design is settled or gone, since the
 * retire that took the row may have finished before this wake's `up()` made it again.
 */
async function letGo(deps: JobDeps, designId: string, at: At): Promise<void> {
  const row = await getSandbox(deps.db, designId);
  const theirs =
    row?.state === "waking" || (row?.state === "awake" && row.sessionId === at.sessionId);
  if (theirs) return;
  await stopQuietly(deps, at);
  const context = await getWakeContext(deps.db, designId);
  if (!context || context.status === "settled") {
    await deps.sandboxes.remove(at.name).catch((error: unknown) => {
      deps.log.warn("sandbox_remove_failed", { designId, error });
    });
  }
  deps.log.warn("wake_let_go", { designId, sessionId: at.sessionId, state: row?.state ?? null });
}

/**
 * The image the design's sandbox is to run. The image set now, unless its sandbox runs another
 * one and the design's last checkpoint does not hold everything that went into its session:
 * `up()` recreates a sandbox on a new image, which loses its disk, so it waits until a sleep's
 * checkpoint covers it (docs/cloud.md, "How images roll out").
 */
async function imageFor(deps: JobDeps, row: SandboxRow): Promise<string> {
  const image = deps.config.sandbox.image;
  if (!row.image || sameImage(row.image, image)) return image;
  const cover = await getCheckpointCover(deps.db, row.designId);
  const held = imageHold(cover);
  if (!held) return image;
  deps.log.info("sandbox_move_held", {
    designId: row.designId,
    from: row.image,
    to: image,
    reason: held,
  });
  return row.image;
}

/** Why a design on another image stays on it at this wake, or null when it moves. */
export function imageHold(cover: "covered" | "behind" | "none"): Held | null {
  if (cover === "behind") return "checkpoint_behind";
  if (cover === "none") return "no_checkpoint";
  return null;
}

export type Held = "checkpoint_behind" | "no_checkpoint";

/** Whether two image references name the same digest. */
export function sameImage(a: string, b: string): boolean {
  const digest = (image: string) => image.slice(image.lastIndexOf("@") + 1);
  return digest(a) === digest(b);
}

/** When to try again: when Vercel said, or by doubling waits. */
function waitAfter(error: SandboxError, attempts: number): number {
  if (error.retryAfterSeconds !== undefined) return Math.max(5_000, error.retryAfterSeconds * 1000);
  return Math.min(WAIT_BASE_MS * 2 ** Math.max(0, attempts - 1), WAIT_MAX_MS);
}
