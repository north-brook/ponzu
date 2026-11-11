import {
  beginSandbox,
  getLiveSandbox,
  getWakeContext,
  moveSandbox,
  recordDesignClaudeAccount,
  revokeRunnerToken,
  revokeRunnerTokens,
  type Sandbox,
  type SandboxChanges,
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

/*
 * Waking a design's sandbox (docs/cloud.md, "The sandbox"): the job `requestWake` records, run
 * at once by the request and again by the cron until it is done. One job waits per design, and
 * the database decides the rest: a design has one sandbox row that is not gone, and every move
 * of it holds to the state it moves from.
 *
 *   no sandbox, or a lost one     create one from the image, on a new environment
 *   asleep, stopping, failed      resume it; on a new environment when its credential changed
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

/** The label every design's sandbox carries at the provider, and no other sandbox does. */
export const DESIGN_SANDBOX = { ponzu: "design" } as const;

/** A design's sandbox's labels at the provider, which find one its row lost. */
export function sandboxLabels(designId: string, generation: number): Record<string, string> {
  return { ...DESIGN_SANDBOX, design: designId, generation: String(generation) };
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

/**
 * Make sure the design's sandbox is awake on its owner's current Claude credential, and poke its
 * runner. Safe to run twice at once and again after a crash at any point.
 */
export async function wakeDesign(
  deps: JobDeps,
  designId: string,
  job: Pick<RunningJob, "attempts" | "maxAttempts">,
): Promise<void> {
  const { db, clock, log } = deps;
  const began = clock.now();
  const context = await getWakeContext(db, designId);
  if (!context || context.status === "settled") return;

  const problem = claudeProblem(context.claude, began);
  if (problem) {
    // Nothing to start it with. The event waits in the feed; connecting Claude wakes it.
    await showAgentWaiting(db, { designId, waking: false, blocker: problem });
    log.info("wake_blocked", { designId, blocker: problem });
    return;
  }
  const claude = context.claude!;
  if (!deps.config.sandbox.snapshot) {
    await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { designId, reason: "PONZU_SANDBOX_SNAPSHOT is not set" });
    return;
  }
  await recordDesignClaudeAccount(db, { designId, claudeAccountId: claude.id });

  try {
    const woke = await bringUp(deps, context);
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
        changes: { failure: error.message.slice(0, 500) },
      });
    }
    await showAgentWaiting(db, { designId, waking: false, blocker: "sandbox_failed" });
    log.error("wake_failed", { designId, refusal: error.code, error });
  }
}

type Claude = NonNullable<WakeContext["claude"]>;
type Woke = { sandbox: Sandbox; start: Start };

/** The sandbox the design has now, awake. Null when someone else is moving it. */
async function bringUp(deps: JobDeps, context: WakeContext): Promise<Woke | null> {
  const { db, clock } = deps;
  const claude = context.claude!;
  const now = new Date(clock.now());
  const sandbox =
    context.sandbox ??
    (await beginSandbox(db, { designId: context.designId, provider: "boat", now })) ??
    (await getLiveSandbox(db, context.designId));
  if (!sandbox) return null;
  const current = context.sandbox !== null && environmentCurrent(context, claude);
  if (sandbox.state === "awake" && current) return { sandbox, start: "none" };
  if (!sandbox.providerId) return create(deps, sandbox, claude);
  return resume(deps, sandbox, claude, current);
}

/** A sandbox of the row's generation, made from the image on a new environment. */
async function create(deps: JobDeps, sandbox: Sandbox, claude: Claude): Promise<Woke | null> {
  const { db, clock, config } = deps;
  const { designId, generation } = sandbox;
  const waking = await moveTo(deps, sandbox, "waking");
  if (!waking) return null;
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
      labels: sandboxLabels(designId, generation),
      env: environment.env,
      ports: [RUNNER_PORT],
      autoStopSeconds: AUTO_STOP_SECONDS,
    });
    providerId = created.sandbox.id;
    const port = created.addresses.find((a) => a.port === RUNNER_PORT);
    if (port) address = await sealedAddress(deps, sandbox.id, port);
  } catch (error) {
    // The token went nowhere.
    await revokeRunnerToken(db, environment.runnerTokenId);
    if (error instanceof SandboxError && error.code === "conflict") {
      return adopt(deps, waking, claude, error);
    }
    throw error;
  }

  const made = await moveSandbox(db, {
    id: sandbox.id,
    from: ["waking"],
    to: "waking",
    now: new Date(clock.now()),
    changes: {
      providerId,
      runnerTokenId: environment.runnerTokenId,
      claudeCredential: environment.claudeCredential,
      ...address,
    },
  });
  if (!made) return null;
  await revokeRunnerTokens(db, designId, { except: environment.runnerTokenId });
  await deps.sandbox.ensureAwake(providerId, { timeoutMs: WAKE_TIMEOUT_MS });
  return awake(deps, made, "created", null);
}

/**
 * The provider made this generation's sandbox once already, for a create whose answer was lost,
 * on an environment that is gone (its runner token was never recorded). Find it by its labels,
 * take it on, and start it on a new environment.
 */
async function adopt(
  deps: JobDeps,
  sandbox: Sandbox,
  claude: Claude,
  conflict: SandboxError,
): Promise<Woke | null> {
  const [found] = await deps.sandbox.list({
    labels: sandboxLabels(sandbox.designId, sandbox.generation),
  });
  if (!found) throw conflict;
  const adopted = await moveSandbox(deps.db, {
    id: sandbox.id,
    from: ["waking"],
    to: "waking",
    now: new Date(deps.clock.now()),
    changes: { providerId: found.id, runnerTokenId: null, claudeCredential: null },
  });
  if (!adopted) return null;
  deps.log.warn("sandbox_adopted", { designId: sandbox.designId, sandboxId: sandbox.id });
  return resume(deps, adopted, claude, false);
}

/**
 * The design's sandbox back up: as it was, or on a new environment when `current` is false.
 * One the provider has lost is marked gone and the next generation is made in its place.
 */
async function resume(
  deps: JobDeps,
  sandbox: Sandbox,
  claude: Claude,
  current: boolean,
): Promise<Woke | null> {
  const { db, clock } = deps;
  const { designId } = sandbox;
  const providerId = sandbox.providerId!;
  if (sandbox.state === "awake") {
    // Running on an old environment, which cannot be replaced while it runs.
    await moveSandbox(db, {
      id: sandbox.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(clock.now()),
    });
    await deps.sandbox.stop(providerId);
  }
  const waking = await moveTo(deps, sandbox, "waking");
  if (!waking) return null;
  await showAgentWaiting(db, { designId, waking: true, blocker: null });

  const environment = current ? null : await newEnvironment(deps, designId, claude);
  const wakeOptions = {
    ...(environment ? { env: environment.env } : {}),
    autoStopSeconds: AUTO_STOP_SECONDS,
    timeoutMs: WAKE_TIMEOUT_MS,
  };
  try {
    let wake: Awaited<ReturnType<typeof deps.sandbox.ensureAwake>>;
    try {
      wake = await deps.sandbox.ensureAwake(providerId, wakeOptions);
    } catch (error) {
      // Someone started it on its old environment meanwhile: stop it and start it on this one.
      if (!(environment && error instanceof SandboxError && error.code === "conflict")) throw error;
      await deps.sandbox.stop(providerId);
      wake = await deps.sandbox.ensureAwake(providerId, wakeOptions);
    }
    return awake(deps, waking, wake.start, environment);
  } catch (error) {
    if (environment) await revokeRunnerToken(db, environment.runnerTokenId);
    const lost =
      error instanceof SandboxError &&
      (error.code === "not_found" || error.code === "snapshot_expired");
    if (!lost) throw error;
    return replace(deps, waking, claude, error);
  }
}

/**
 * The provider has lost the sandbox, or its disk: mark it gone and make the next generation.
 * Nothing is lost with it: the runner clones the branch again, and the canvas and the thread
 * are in the database.
 */
async function replace(
  deps: JobDeps,
  sandbox: Sandbox,
  claude: Claude,
  why: SandboxError,
): Promise<Woke | null> {
  const { db, clock, log } = deps;
  const now = new Date(clock.now());
  await moveSandbox(db, {
    id: sandbox.id,
    from: ["waking"],
    to: "gone",
    now,
    changes: { failure: why.message.slice(0, 500) },
  });
  log.warn("sandbox_lost", {
    designId: sandbox.designId,
    sandboxId: sandbox.id,
    refusal: why.code,
  });
  if (why.code === "snapshot_expired") {
    // Its machine is gone but the provider still lists it.
    await deps.sandbox.destroy(sandbox.providerId!);
  }
  const next = await beginSandbox(db, { designId: sandbox.designId, provider: "boat", now });
  return next ? create(deps, next, claude) : null;
}

/** The sandbox is awake: record it, with where its runner is, and poke the runner. */
async function awake(
  deps: JobDeps,
  sandbox: Sandbox,
  start: Start,
  environment: Environment | null,
): Promise<Woke | null> {
  const { db, clock, vault } = deps;
  const providerId = sandbox.providerId!;
  let address: SandboxChanges = {};
  let token: string | null = null;
  if (sandbox.address) {
    token = sandbox.encryptedAddressToken
      ? await vault.open(sandbox.encryptedAddressToken, addressBinding(sandbox.id))
      : null;
  } else {
    const port = await deps.sandbox.address(providerId, RUNNER_PORT);
    address = await sealedAddress(deps, sandbox.id, port);
    token = port.token;
  }
  const now = clock.now();
  const moved = await moveSandbox(db, {
    id: sandbox.id,
    from: ["waking"],
    to: "awake",
    now: new Date(now),
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
  if (environment) {
    await revokeRunnerTokens(db, sandbox.designId, { except: environment.runnerTokenId });
  }
  // The runner says what it is doing as soon as it is up; until then the head says waking.
  await showAgentWaiting(db, { designId: sandbox.designId, waking: true, blocker: null });
  try {
    await deps.poke({ url: moved.address!, token });
  } catch (error) {
    // A runner that is still starting claims by itself once it is up.
    deps.log.info("poke_missed", { designId: sandbox.designId, error });
  }
  return { sandbox: moved, start };
}

/** Into `to` from any state a wake picks a sandbox up in. */
function moveTo(deps: JobDeps, sandbox: Sandbox, to: "waking") {
  return moveSandbox(deps.db, {
    id: sandbox.id,
    from: ["waking", "asleep", "stopping", "failed"],
    to,
    now: new Date(deps.clock.now()),
  });
}

function addressBinding(sandboxId: string) {
  return { column: "sandboxes.encrypted_address_token", row: sandboxId };
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
