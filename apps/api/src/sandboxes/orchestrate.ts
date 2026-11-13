import {
  beginSandbox,
  claimSandbox,
  getCheckpointCover,
  getSandbox,
  getWakeContext,
  liftAgentBlockers,
  moveSandbox,
  recordCanvasClaudeAccount,
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
  canvasSandboxName,
  SandboxError,
  type SandboxErrorCode,
  type SandboxSpec,
} from "@ponzu/sandbox";
import type { WakeStart } from "../analytics/events.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { notify } from "../notifications/notify.ts";
import {
  SANDBOX_VCPUS,
  SESSION_TIMEOUT_MS,
  SNAPSHOT_EXPIRATION_MS,
  STOP_COMMAND_MS,
} from "./constants.ts";
import {
  type Environment,
  newEnvironment,
  newToolsEnvironment,
  portBinding,
  startMark,
} from "./environment.ts";
import { askWakeGates, LIFTED_BY_A_WAKE } from "./gates.ts";

/*
 * Waking a canvas's sandbox (docs/cloud.md, "The sandbox"): the job `requestWake` records, run
 * at once by the request and again by the cron until it is done. First the wake gates
 * (`gates.ts`) are asked whether anything outside the canvas holds it back; the first that
 * says so ends the wake, or puts it off to when that gate said. The database decides who does
 * it: a wake first claims the canvas's row (`waking`, held by the wake's job), so of any number
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

/** The job that wakes a canvas's sandbox. One waits per canvas: its key is the canvas's id. */
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

/** A canvas's sandbox's name at Vercel. */
export function sandboxName(deps: Pick<JobDeps, "config">, canvasId: string): string {
  return canvasSandboxName(deps.config.sandbox.scope, canvasId);
}

/** A canvas's sandbox's spec, on `image`. */
export function sandboxSpec(image: string): SandboxSpec {
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
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  await wakeCanvas(deps, String(payload.canvasId), job, { reason });
}

/** The wake job running: its id is what holds the row while it is `waking`. */
type Wake = Pick<RunningJob, "id" | "attempts" | "maxAttempts">;

/**
 * Make sure the canvas's runner is running on its owner's current Claude credential. Safe to
 * run twice at once and again after a crash at any point. `reason` is the wake's, as recorded,
 * which a gate may read.
 */
export async function wakeCanvas(
  deps: JobDeps,
  canvasId: string,
  job: Wake,
  { reason = null }: { reason?: string | null } = {},
): Promise<void> {
  const { db, clock, log } = deps;
  const began = clock.now();
  const context = await getWakeContext(db, canvasId);
  if (!context || context.status === "settled") return;

  // Something outside the canvas must change first. The event waits in the feed; what it waits
  // on wakes it once it has changed, or the next message does, or (when the gate said when)
  // this wake, tried again then.
  const refused = askWakeGates(context, new Date(began), { deps, reason });
  if (refused) {
    const { blocker, retryAt, gate } = refused;
    // A turn already running when a feature's gate closes finishes (billing §4, sweep §6): the
    // head keeps saying it works. Claude's and the owner's blockers stop it, as they always have.
    const turnRuns = LIFTED_BY_A_WAKE.has(blocker);
    await showAgentWaiting(db, {
      canvasId,
      waking: false,
      blocker,
      blockedUntil: retryAt,
      turnRuns,
    });
    log.info("wake_blocked", { canvasId, blocker });
    if (retryAt && job.attempts < job.maxAttempts) {
      throw new RetryLater(Math.max(0, retryAt.getTime() - began), `The ${gate} gate holds it.`);
    }
    return;
  }
  // Every gate lets it through: what one of them said before no longer holds.
  if (context.agentBlocker && LIFTED_BY_A_WAKE.has(context.agentBlocker)) {
    await liftAgentBlockers(db, { blockers: [context.agentBlocker], canvasId });
  }
  // A driven canvas runs no Claude, so it pins no account to itself.
  if (!context.driven) {
    await recordCanvasClaudeAccount(db, { canvasId, claudeAccountId: context.claude!.id });
  }

  try {
    const waking = await claim(deps, context, job.id);
    if (!waking) return;
    const woke = await bringUp(deps, context, waking, job.id);
    if (!woke) return;
    const ms = clock.now() - began;
    log.info("sandbox_awake", { canvasId, start: woke.start, fresh: woke.fresh, ms });
    // About the canvas's owner, whose Claude it runs on: whoever's message woke it, it runs
    // for them.
    deps.analytics.capture(
      "sandbox woke",
      {
        canvas_id: canvasId,
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
      await showAgentWaiting(db, { canvasId, waking: true, blocker });
      throw new RetryLater(waitAfter(error, job.attempts), error.message);
    }
    // It will not start this way, or it has been tried long enough. The next message tries again.
    const failedAt = new Date(clock.now());
    const gaveUp = await moveSandbox(db, {
      canvasId,
      from: ["waking"],
      to: "asleep",
      now: failedAt,
      by: job.id,
      changes: { failure: error.message.slice(0, 500) },
    });
    await showAgentWaiting(db, { canvasId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { canvasId, refusal: error.code, error });
    // Only the run that put it to sleep pings: the ping is keyed by this moment, so a second run
    // of the job (or one racing it) that finds it asleep already would ping again.
    if (gaveUp) {
      await notify(deps, { kind: "wake_failed", canvasId, failedAt: failedAt.toISOString() });
    }
  }
}

/**
 * The canvas's row, now `waking` and held by the wake `by`; null when there is nothing for this
 * wake to do (another holds it, or it is awake on the credential it should be).
 */
async function claim(deps: JobDeps, context: WakeContext, by: string): Promise<SandboxRow | null> {
  const { db, clock } = deps;
  const { limits } = deps.config.sandbox;
  const { canvasId } = context;
  let row = context.sandbox;
  const now = () => new Date(clock.now());
  if (!row) return claimed(await beginSandbox(db, { canvasId, now: now(), by, limits }));
  if (row.state === "stopping") {
    await showAgentWaiting(db, { canvasId, waking: true, blocker: null });
    row = await afterStop(deps, canvasId);
    if (!row) return claim(deps, { ...context, sandbox: null }, by);
  }
  switch (row.state) {
    case "asleep":
      return claimed(
        await claimSandbox(db, { canvasId, from: ["asleep"], now: now(), by, limits }),
      );
    case "awake":
      // On the credential it should be (or in tools mode, driven): the request's poke reached it.
      if (row.claudeCredential === startMark(context)) return null;
      // A restart in place, on the owner's new credential.
      return claimed(await claimSandbox(db, { canvasId, from: ["awake"], now: now(), by, limits }));
    case "waking":
      // Its own, from an earlier attempt, or one left past its lease.
      return claimed(
        await claimSandbox(db, { canvasId, from: ["waking"], now: now(), by, limits }),
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
async function afterStop(deps: JobDeps, canvasId: string): Promise<SandboxRow | null> {
  const until = deps.clock.now() + STOP_WAIT_MS;
  for (;;) {
    await deps.clock.sleep(STOP_POLL_MS);
    const row = await getSandbox(deps.db, canvasId);
    if (row?.state !== "stopping") return row;
    if (deps.clock.now() >= until) {
      throw new SandboxError("busy", "A stop of the canvas's sandbox is still under way.");
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
 * The runner started in the canvas's sandbox, and the row awake on it. Null when the row was
 * taken from this wake meanwhile (a retire, or another wake after the lease).
 */
async function bringUp(
  deps: JobDeps,
  context: WakeContext,
  waking: SandboxRow,
  by: string,
): Promise<Woke | null> {
  const { db, clock, vault, sandboxes } = deps;
  const { canvasId } = context;
  await showAgentWaiting(db, { canvasId, waking: true, blocker: null });

  const name = sandboxName(deps, canvasId);
  const image = await imageFor(deps, waking);
  const up = await sandboxes.up(name, sandboxSpec(image));
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
    environment = context.driven
      ? await newToolsEnvironment(deps, canvasId)
      : await newEnvironment(deps, canvasId, context.claude!);
    await sandboxes.start(at, {
      cmd: IMAGE_COMMANDS.start,
      env: environment.env,
      sudo: true,
    });
    const encryptedPortToken = await vault.seal(environment.portToken, portBinding(canvasId));
    // A restart in place keeps the session, and with it when the session began.
    const sessionStartedAt =
      waking.sessionId === up.sessionId && waking.sessionStartedAt
        ? waking.sessionStartedAt
        : new Date(up.startedAt);
    const awake = await moveSandbox(db, {
      canvasId,
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
      await letGo(deps, canvasId, at);
      return null;
    }
    // The runner it replaced, if any, hears at its next call that it is done.
    await revokeRunnerTokens(db, canvasId, { except: environment.runnerTokenId });
    return {
      start: up.wasRunning ? "restart" : up.fresh ? "create" : "resume",
      fresh: up.fresh,
      recreated: up.recreated,
      image,
    };
  } catch (error) {
    // `up()` resumed or created a session that serves nothing now: stopped, whatever the
    // refusal (and whatever the database does meanwhile), so a wake that is tried again (or
    // gives up) leaves no VM running behind a row that is not awake. The next attempt's `up()`
    // resumes it in a couple of seconds.
    try {
      if (environment) await revokeRunnerToken(db, environment.runnerTokenId);
    } finally {
      await stopQuietly(deps, at);
    }
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
 * runs there itself), and the sandbox is removed when its canvas is settled or gone, since the
 * retire that took the row may have finished before this wake's `up()` made it again.
 */
async function letGo(deps: JobDeps, canvasId: string, at: At): Promise<void> {
  const row = await getSandbox(deps.db, canvasId);
  const theirs =
    row?.state === "waking" || (row?.state === "awake" && row.sessionId === at.sessionId);
  if (theirs) return;
  await stopQuietly(deps, at);
  const context = await getWakeContext(deps.db, canvasId);
  if (!context || context.status === "settled") {
    await deps.sandboxes.remove(at.name).catch((error: unknown) => {
      deps.log.warn("sandbox_remove_failed", { canvasId, error });
    });
  }
  deps.log.warn("wake_let_go", { canvasId, sessionId: at.sessionId, state: row?.state ?? null });
}

/**
 * The image the canvas's sandbox is to run. The image set now, unless its sandbox runs another
 * one and the canvas's last checkpoint does not hold everything that went into its session:
 * `up()` recreates a sandbox on a new image, which loses its disk, so it waits until a sleep's
 * checkpoint covers it (docs/cloud.md, "How images roll out").
 */
async function imageFor(deps: JobDeps, row: SandboxRow): Promise<string> {
  const image = deps.config.sandbox.image;
  if (!row.image || sameImage(row.image, image)) return image;
  const cover = await getCheckpointCover(deps.db, row.canvasId);
  const held = imageHold(cover);
  if (!held) return image;
  deps.log.info("sandbox_move_held", {
    canvasId: row.canvasId,
    from: row.image,
    to: image,
    reason: held,
  });
  return row.image;
}

/** Why a canvas on another image stays on it at this wake, or null when it moves. */
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
