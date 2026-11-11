import {
  beginSandbox,
  claimSandbox,
  getLiveSandbox,
  getWakeContext,
  moveSandbox,
  recordDesignClaudeAccount,
  revokeRunnerToken,
  revokeRunnerTokens,
  type Sandbox,
  type SandboxChanges,
  type SandboxClaim,
  showAgentWaiting,
  type WakeContext,
} from "@ponzu/db";
import { SandboxError, type SandboxErrorCode } from "@ponzu/sandbox";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import {
  claudeProblem,
  type Environment,
  environmentCurrent,
  newEnvironment,
  RUNNER_PORT,
} from "./environment.ts";
import {
  addressBinding,
  REVIVE_BUDGET_MS,
  reviveRunner,
  SYNC_MS,
  stopSandbox,
  syncDisk,
} from "./quiesce.ts";

/*
 * Waking a design's sandbox (docs/cloud.md, "The sandbox"): the job `requestWake` records, run
 * at once by the request and again by the cron until it is done. The database decides who does
 * it: a design has one sandbox row that is not gone, and a wake first claims it (`waking`, held
 * by the wake's job), so of any number of wakes racing one makes or starts a machine and the
 * rest leave it be. The claim counts the sandboxes already up in the workspace and for the
 * owner, and one past the limits waits as if the provider were out of starts.
 *
 *   no sandbox, or a lost one     create one from the image, on a new environment
 *   stopping                      wait for the stop to land, then as asleep
 *   asleep, failed                resume it; on a new environment when its credential changed
 *   awake on an old environment   stop it, then resume it on the new one (a cold start)
 *   disk expired, or gone         mark it gone and create the next generation
 *
 * A provider that is out of starts, limits the rate or does not answer is waited out: the job
 * is tried again when the provider says, and the design's head says it is waiting. A person's
 * message is never failed for it.
 */

/** The job that wakes a design's sandbox. One waits per design: its key is the design's id. */
export const WAKE_JOB = "sandbox.wake";
/** A wake keeps trying for about three hours of waits before it gives up. */
export const WAKE_ATTEMPTS = 40;
/** How long one attempt waits for the provider to say the sandbox is awake. */
const WAKE_TIMEOUT_MS = 90_000;
/**
 * What one attempt may spend, of the function's 300 seconds, before it leaves the rest to the
 * next (quiesce.ts adds the waits up). The rest is for the database and the provider's calls.
 */
const WAKE_BUDGET_MS = 260_000;
/** What a cold start after a failed revive takes at most: `sync`, the stop, the boot. */
const COLD_MS = SYNC_MS + WAKE_TIMEOUT_MS + 10_000;
/** How long one attempt waits for a stop under way to land, and how often it looks. */
const STOP_WAIT_MS = 60_000;
const STOP_POLL_MS = 2_000;
/**
 * The provider's own auto-stop: only a safety net for when the API is not there to stop the
 * sandbox itself, kept this far ahead while it is awake (`sweep.ts`).
 */
export const AUTO_STOP_SECONDS = 20 * 60;
/** Waits between attempts when the provider does not say how long: from 15 s, doubling, to 5 min. */
const WAIT_BASE_MS = 15_000;
const WAIT_MAX_MS = 5 * 60_000;

/** Refusals that pass: the provider is out of starts, limits the pace, or is busy or away. */
const WAITS: ReadonlySet<SandboxErrorCode> = new Set([
  "rate_limited",
  "start_cap_reached",
  "busy",
  "unavailable",
  "not_running",
]);
/** Of those, the ones that mean no machine can be had for now, which the head says. */
const NO_CAPACITY: ReadonlySet<SandboxErrorCode> = new Set(["rate_limited", "start_cap_reached"]);

/**
 * The labels every design sandbox of this database carries at the provider. Other deployments
 * share the provider account; `scope` is what tells their sandboxes from these.
 */
export function designSandboxes(scope: string): Record<string, string> {
  return { ponzu: "design", scope };
}

/** A design's sandbox's labels at the provider, which find one its row lost. */
export function sandboxLabels(
  scope: string,
  designId: string,
  generation: number,
): Record<string, string> {
  return { ...designSandboxes(scope), design: designId, generation: String(generation) };
}

export async function runWakeJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
): Promise<void> {
  await wakeDesign(deps, String(payload.designId), job);
}

/** How a wake went, for the log: what the sandbox went through to be awake. */
type Start = "none" | "warm" | "cold" | "created";

/** The wake job running: its id is what holds the sandbox while it is `waking`. */
type Wake = Pick<RunningJob, "id" | "attempts" | "maxAttempts">;

/**
 * Make sure the design's sandbox is awake on its owner's current Claude credential, and poke its
 * runner. Safe to run twice at once and again after a crash at any point.
 */
export async function wakeDesign(deps: JobDeps, designId: string, job: Wake): Promise<void> {
  const { db, clock, log } = deps;
  const began = clock.now();
  let context = await getWakeContext(db, designId);
  if (!context || context.status === "settled") return;

  // Nothing to start it with. The event waits in the feed; what is missing wakes it once it's
  // there, or the next message does.
  const problem = context.ownerMember ? claudeProblem(context.claude, began) : "claude_owner_left";
  if (problem) {
    await showAgentWaiting(db, { designId, waking: false, blocker: problem });
    log.info("wake_blocked", { designId, blocker: problem });
    return;
  }
  if (!deps.config.sandbox.snapshot) {
    await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { designId, reason: "PONZU_SANDBOX_SNAPSHOT is not set" });
    return;
  }
  await recordDesignClaudeAccount(db, { designId, claudeAccountId: context.claude!.id });

  try {
    if (context.sandbox?.state === "stopping") {
      await showAgentWaiting(db, { designId, waking: true, blocker: null });
      context = await afterStop(deps, designId);
    }
    const woke = await bringUp(deps, context, job.id, began + WAKE_BUDGET_MS);
    if (woke) {
      log.info("sandbox_awake", {
        designId,
        sandboxId: woke.sandbox.id,
        start: woke.start,
        ms: clock.now() - began,
      });
    }
  } catch (error) {
    if (!(error instanceof SandboxError)) throw error;
    const now = new Date(clock.now());
    if (WAITS.has(error.code) && job.attempts < job.maxAttempts) {
      const blocker = NO_CAPACITY.has(error.code) ? "sandbox_busy" : null;
      await showAgentWaiting(db, { designId, waking: true, blocker });
      throw new RetryLater(waitAfter(error, job.attempts), error.message);
    }
    // It will not start this way, or it has been tried long enough. The next message tries again.
    const live = await getLiveSandbox(db, designId);
    if (live) {
      await moveSandbox(db, {
        id: live.id,
        from: ["waking"],
        to: "failed",
        now,
        by: job.id,
        changes: { failure: error.message.slice(0, 500) },
      });
    }
    await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { designId, refusal: error.code, error });
  }
}

/**
 * The design as it is once the stop under way has landed. A stop holds the machine until it
 * is done, and a sandbox resumed meanwhile would be stopped under its runner (docs/cloud.md,
 * "Known constraints"). Waits a while, then leaves it to the next attempt.
 */
async function afterStop(deps: JobDeps, designId: string): Promise<WakeContext> {
  const until = deps.clock.now() + STOP_WAIT_MS;
  for (;;) {
    await deps.clock.sleep(STOP_POLL_MS);
    const context = await getWakeContext(deps.db, designId);
    if (context?.sandbox?.state !== "stopping") return context!;
    if (deps.clock.now() >= until) {
      throw new SandboxError("busy", "A stop of the design's sandbox is still under way.");
    }
  }
}

type Claude = NonNullable<WakeContext["claude"]>;
type Woke = { sandbox: Sandbox; start: Start };

/** The sandbox the design has now, awake. Null when another wake has it in hand. */
async function bringUp(
  deps: JobDeps,
  context: WakeContext,
  by: string,
  deadline: number,
): Promise<Woke | null> {
  const { db, clock, config } = deps;
  const claude = context.claude!;
  const now = new Date(clock.now());
  const { limits } = config.sandbox;
  const sandbox = context.sandbox;
  if (!sandbox) {
    const begun = await beginSandbox(db, {
      designId: context.designId,
      provider: "boat",
      now,
      by,
      limits,
    });
    return create(deps, claimed(begun), claude, by);
  }

  const current = environmentCurrent(context, claude);
  if (sandbox.state === "awake" && current) return { sandbox, start: "none" };
  let from: Sandbox["state"][] = ["asleep", "failed", "waking"];
  if (sandbox.state === "awake") {
    // Running on an old environment, which cannot be replaced while it runs.
    const stopping = await moveSandbox(db, {
      id: sandbox.id,
      from: ["awake"],
      to: "stopping",
      now,
    });
    if (!stopping) return null;
    // Its runner saves what it has before the machine goes (quiesce.ts).
    await stopSandbox(deps, stopping, { quiesce: true });
    from = ["stopping"];
  }
  const waking = claimed(
    await claimSandbox(db, { id: sandbox.id, from, now: new Date(clock.now()), by, limits }),
  );
  if (!waking) return null;
  if (!waking.providerId) return create(deps, waking, claude, by);
  return resume(deps, waking, claude, current, by, deadline);
}

/**
 * The sandbox a claim took, or null when another wake has it. Past the limits it waits, as for
 * a provider out of starts, and the head says so.
 */
function claimed(claim: SandboxClaim): Sandbox | null {
  if (claim && "full" in claim) {
    throw new SandboxError(
      "start_cap_reached",
      "As many sandboxes are up in this workspace, or for this owner, as may be.",
    );
  }
  return claim?.sandbox ?? null;
}

/** A sandbox of the claimed row's generation, made from the image on a new environment. */
async function create(
  deps: JobDeps,
  waking: Sandbox | null,
  claude: Claude,
  by: string,
): Promise<Woke | null> {
  if (!waking) return null;
  const { db, clock, config } = deps;
  const { designId, generation } = waking;
  await showAgentWaiting(db, { designId, waking: true, blocker: null });

  const environment = await newEnvironment(deps, designId, claude);
  let providerId: string;
  let address: SandboxChanges = {};
  try {
    const created = await deps.sandbox.create({
      // A create sent again for this generation, after a crash or a lost answer, finds the
      // sandbox the first one made rather than making a second.
      idempotencyKey: `${designId}-${generation}`,
      from: config.sandbox.snapshot!,
      size: "small",
      name: `design-${designId}`,
      labels: sandboxLabels(config.sandbox.scope, designId, generation),
      env: environment.env,
      ports: [RUNNER_PORT],
      autoStopSeconds: AUTO_STOP_SECONDS,
    });
    providerId = created.sandbox.id;
    const port = created.addresses.find((a) => a.port === RUNNER_PORT);
    if (port) address = await sealedAddress(deps, waking.id, port);
  } catch (error) {
    // The token went nowhere.
    await revokeRunnerToken(db, environment.runnerTokenId);
    if (error instanceof SandboxError && error.code === "conflict") {
      return adopt(deps, waking, claude, by, error);
    }
    throw error;
  }

  const made = await moveSandbox(db, {
    id: waking.id,
    from: ["waking"],
    to: "waking",
    now: new Date(clock.now()),
    by,
    changes: {
      providerId,
      runnerTokenId: environment.runnerTokenId,
      claudeCredential: environment.claudeCredential,
      ...address,
    },
  });
  if (!made) return null;
  await deps.sandbox.ensureAwake(providerId, { timeoutMs: WAKE_TIMEOUT_MS });
  return awake(deps, made, "created", by);
}

/**
 * The provider made this generation's sandbox once already, for a create whose answer was lost,
 * on an environment that is gone (its runner token was never recorded). Find it by its labels,
 * take it on, and start it on a new environment.
 */
async function adopt(
  deps: JobDeps,
  waking: Sandbox,
  claude: Claude,
  by: string,
  conflict: SandboxError,
): Promise<Woke | null> {
  const [found] = await deps.sandbox.list({
    labels: sandboxLabels(deps.config.sandbox.scope, waking.designId, waking.generation),
  });
  if (!found) throw conflict;
  const adopted = await moveSandbox(deps.db, {
    id: waking.id,
    from: ["waking"],
    to: "waking",
    now: new Date(deps.clock.now()),
    by,
    changes: { providerId: found.id, runnerTokenId: null, claudeCredential: null },
  });
  if (!adopted) return null;
  deps.log.warn("sandbox_adopted", { designId: waking.designId, sandboxId: waking.id });
  return resume(deps, adopted, claude, false, by, deps.clock.now() + WAKE_BUDGET_MS / 2);
}

/**
 * The claimed sandbox back up: as it was, or on a new environment when `current` is false.
 * One the provider has lost is marked gone and the next generation is made in its place.
 */
async function resume(
  deps: JobDeps,
  waking: Sandbox,
  claude: Claude,
  current: boolean,
  by: string,
  deadline: number,
): Promise<Woke | null> {
  const { db, clock } = deps;
  const providerId = waking.providerId!;
  await showAgentWaiting(db, { designId: waking.designId, waking: true, blocker: null });

  let environment = current ? null : await newEnvironment(deps, waking.designId, claude);
  const options = {
    ...(environment ? { env: environment.env } : {}),
    autoStopSeconds: AUTO_STOP_SECONDS,
    timeoutMs: WAKE_TIMEOUT_MS,
  };
  try {
    let wake: Awaited<ReturnType<typeof deps.sandbox.ensureAwake>>;
    try {
      wake = await deps.sandbox.ensureAwake(providerId, options);
    } catch (error) {
      // Someone started it on its old environment meanwhile: stop it and start it on this one.
      if (!(environment && error instanceof SandboxError && error.code === "conflict")) throw error;
      await deps.sandbox.stop(providerId);
      wake = await deps.sandbox.ensureAwake(providerId, options);
    }
    if (wake.start !== "cold") {
      // A thaw brings back the boot as it was, a runner that had exited included (quiesce.ts);
      // so may a machine an earlier attempt left running. Started again through the provider
      // only when there is time left for the cold start after it, should that fail too.
      const left = deadline - clock.now();
      const runner = await reviveRunner(deps, waking, {
        startUnit: left >= REVIVE_BUDGET_MS + COLD_MS,
      });
      if (runner === "stay_down") return null;
      if (runner === "down") {
        deps.log.warn("runner_down_after_warm_resume", {
          designId: waking.designId,
          sandboxId: waking.id,
        });
        // The next attempt starts here again, on a machine that is up.
        if (deadline - clock.now() < COLD_MS)
          throw new SandboxError("busy", "The wake ran out of time to start the runner again.");
        if (environment) await revokeRunnerToken(db, environment.runnerTokenId);
        // A new environment is always a cold start, and a boot starts the unit. What the
        // machine wrote is flushed first: a health check can fail for its address alone.
        environment = await newEnvironment(deps, waking.designId, claude);
        await syncDisk(deps, providerId, waking.designId);
        await deps.sandbox.stop(providerId);
        wake = await deps.sandbox.ensureAwake(providerId, {
          ...options,
          env: environment.env,
        });
      }
    }
    return await awake(deps, waking, wake.start, by, environment);
  } catch (error) {
    if (environment) await revokeRunnerToken(db, environment.runnerTokenId);
    const lost =
      error instanceof SandboxError &&
      (error.code === "not_found" || error.code === "snapshot_expired");
    if (!lost) throw error;
    return replace(deps, waking, claude, by, error);
  }
}

/**
 * The provider has lost the sandbox, or its disk: mark it gone and make the next generation.
 * Nothing is lost with it: the runner clones the branch again, and the canvas and the thread
 * are in the database.
 */
async function replace(
  deps: JobDeps,
  waking: Sandbox,
  claude: Claude,
  by: string,
  why: SandboxError,
): Promise<Woke | null> {
  const { db, clock, log, config } = deps;
  const now = new Date(clock.now());
  const gone = await moveSandbox(db, {
    id: waking.id,
    from: ["waking"],
    to: "gone",
    now,
    by,
    changes: { failure: why.message.slice(0, 500) },
  });
  if (!gone) return null;
  log.warn("sandbox_lost", {
    designId: waking.designId,
    sandboxId: waking.id,
    refusal: why.code,
  });
  if (why.code === "snapshot_expired") {
    // Its machine is gone but the provider still lists it.
    await deps.sandbox.destroy(waking.providerId!);
  }
  const next = await beginSandbox(db, {
    designId: waking.designId,
    provider: "boat",
    now,
    by,
    limits: config.sandbox.limits,
  });
  return create(deps, claimed(next), claude, by);
}

/**
 * The sandbox is awake: record it, with where its runner is and the environment it was started
 * on when that is new, revoke every runner token but the one its environment carries, and poke
 * the runner.
 */
async function awake(
  deps: JobDeps,
  waking: Sandbox,
  start: Start,
  by: string,
  environment: Environment | null = null,
): Promise<Woke | null> {
  const { db, clock, vault } = deps;
  let address: SandboxChanges = {};
  let token: string | null = null;
  if (waking.address) {
    token = waking.encryptedAddressToken
      ? await vault.open(waking.encryptedAddressToken, addressBinding(waking.id))
      : null;
  } else {
    const port = await deps.sandbox.address(waking.providerId!, RUNNER_PORT);
    address = await sealedAddress(deps, waking.id, port);
    token = port.token;
  }
  const now = clock.now();
  const moved = await moveSandbox(db, {
    id: waking.id,
    from: ["waking"],
    to: "awake",
    now: new Date(now),
    by,
    changes: {
      ...address,
      autoStopAt: new Date(now + AUTO_STOP_SECONDS * 1000),
      ...(environment
        ? {
            runnerTokenId: environment.runnerTokenId,
            claudeCredential: environment.claudeCredential,
          }
        : {}),
    },
  });
  if (!moved) return null;
  if (moved.runnerTokenId) {
    await revokeRunnerTokens(db, moved.designId, { except: moved.runnerTokenId });
  }
  // The runner says what it is doing as soon as it is up; until then the head says waking.
  await showAgentWaiting(db, { designId: moved.designId, waking: true, blocker: null });
  try {
    await deps.poke({ url: moved.address!, token });
  } catch (error) {
    // A runner that is still starting claims by itself once it is up.
    deps.log.info("poke_missed", { designId: moved.designId, error });
  }
  return { sandbox: moved, start };
}

async function sealedAddress(
  { vault }: Pick<JobDeps, "vault">,
  sandboxId: string,
  port: { url: string; token: string | null },
): Promise<SandboxChanges> {
  return {
    address: port.url,
    encryptedAddressToken: port.token
      ? await vault.seal(port.token, addressBinding(sandboxId))
      : null,
  };
}

/** When to try again: when the provider said, or by doubling waits. */
function waitAfter(error: SandboxError, attempts: number): number {
  if (error.retryAfterSeconds !== undefined) return Math.max(5_000, error.retryAfterSeconds * 1000);
  return Math.min(WAIT_BASE_MS * 2 ** Math.max(0, attempts - 1), WAIT_MAX_MS);
}
