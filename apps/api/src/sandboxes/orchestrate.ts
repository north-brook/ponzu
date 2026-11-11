import {
  beginSandbox,
  type CheckpointCover,
  claimSandbox,
  getCheckpointCover,
  getLiveSandbox,
  getWakeContext,
  moveSandbox,
  moveSandboxOnto,
  newId,
  recordDesignClaudeAccount,
  revokeRunnerToken,
  revokeRunnerTokens,
  type Sandbox,
  type SandboxChanges,
  type SandboxClaim,
  showAgentWaiting,
  takeMoveSlot,
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
  HEALTH_MS,
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
 *   ... from another image        move it: a new sandbox from the image set now, which restores
 *                                 the last checkpoint; the old one is resumed instead when the
 *                                 move may not or cannot happen (`moveOnto`)
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
/**
 * What moving onto a new image may take of an attempt: the create, the boot and the runner's
 * first `/health`, which took 7 to 31 s from the call in the image's runs (its README). An
 * attempt starts a move only with time for this and for resuming the old sandbox after it, so
 * a move that fails still wakes the design in the same attempt.
 */
const MOVE_MS = 100_000;
/** How often a move looks for the new runner's `/health`. */
const HEALTH_POLL_MS = 1_000;
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
type Start = "none" | "warm" | "cold" | "created" | "moved";

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
      const ms = clock.now() - began;
      log.info("sandbox_awake", {
        designId,
        sandboxId: woke.sandbox.id,
        start: woke.start,
        image: woke.sandbox.image,
        ms,
      });
      // About the design's owner, whose Claude it runs on: whoever's message woke it, it runs
      // for them.
      const about = { distinctId: context.ownerId, workspaceId: context.workspaceId };
      if (woke.replaced) deps.analytics.capture("sandbox lost", { design_id: designId }, about);
      if (woke.start !== "none") {
        deps.analytics.capture(
          "sandbox woke",
          {
            design_id: designId,
            start: WAKE_STARTS[woke.start],
            duration_ms: ms,
            image: woke.sandbox.image,
          },
          about,
        );
      }
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
/** A sandbox awake, how it came up, and whether it replaced one the provider had lost. */
type Woke = { sandbox: Sandbox; start: Start; replaced?: boolean };

/** How analytics names each way a sandbox comes up. */
const WAKE_STARTS = { created: "new", cold: "cold", warm: "warm", moved: "moved" } as const;

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
  const moved = await moveOnto(deps, context, waking, claude, by, deadline);
  if (moved.done) return moved.woke;
  return resume(deps, moved.waking, claude, current, by, deadline);
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
      image: config.sandbox.snapshot!,
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
    changes: {
      providerId: found.id,
      // Made by this generation's create, from the image set then.
      image: deps.config.sandbox.snapshot!,
      runnerTokenId: null,
      claudeCredential: null,
    },
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
  // A runner that calls the API after this was thawed by this resume, and is up.
  const since = clock.now();
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
        since,
      });
      if (runner === "stay_down") return null;
      if (runner === "down") {
        // Neither `/health` nor any call from it since the thaw: there is no runner here to
        // lose a turn, so the machine is stopped without asking it to get ready.
        deps.log.warn("runner_down_after_warm_resume", {
          designId: waking.designId,
          sandboxId: waking.id,
          start: wake.start,
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

/** Why a design on another image is not moved at this wake (`sandbox_move_held`). */
export type Held =
  | "moving_off"
  | "image_failed"
  | "checkpoint_behind"
  | "no_checkpoint"
  | "no_time"
  | "moves_at_once";

/**
 * Why a design whose sandbox is from another image than `image` may not move onto it, by what
 * is known before a wake begins, or null when it may. The wake adds the time it has left and the
 * moves under way.
 */
export function moveHold(
  sandbox: Pick<Sandbox, "imageFailed">,
  image: string,
  maxMoves: number,
  cover: CheckpointCover,
): Held | null {
  if (maxMoves === 0) return "moving_off";
  if (sandbox.imageFailed === image) return "image_failed";
  if (cover === "behind") return "checkpoint_behind";
  if (cover === "none") return "no_checkpoint";
  return null;
}

/**
 * Either the wake is done (the design moved, or another wake took the sandbox), or it goes on
 * with `waking`, the sandbox it holds, as it would have without a move.
 */
type MoveOutcome = { done: true; woke: Woke | null } | { done: false; waking: Sandbox };

/**
 * Move the design whose sandbox `waking` was made from another image onto a new sandbox from the
 * image set now (docs/cloud.md, "How images roll out"). It is the restore of a lost sandbox,
 * chosen on purpose: the new sandbox's runner finds no disk and restores the last checkpoint,
 * and resumes the same Claude session. So it happens only when that loses nothing and there is
 * room for it:
 *
 *   - the sandbox is asleep or failed (the claim took it from there), never under a turn;
 *   - the last checkpoint holds every event that went into the session; when it is behind (a
 *     turn cut off, a checkpoint that failed) the old one is woken, saves one, and the design
 *     moves at a later wake;
 *   - a move onto this image has not failed for this design before;
 *   - fewer than `PONZU_SANDBOX_MAX_MOVES` are under way, since each is one of the provider's
 *     rationed starts;
 *   - there is time in this attempt for the move and for resuming the old one after it.
 *
 * A move whose sandbox does not start, or whose runner does not answer, is undone: the new one
 * is destroyed, the image is recorded as failed for this design, and the old one is resumed in
 * the same attempt, so a broken image costs a design one slower wake, not a loop. Only once the
 * new sandbox's runner answers does the row move, and only then is the old machine destroyed.
 */
async function moveOnto(
  deps: JobDeps,
  context: WakeContext,
  waking: Sandbox,
  claude: Claude,
  by: string,
  deadline: number,
): Promise<MoveOutcome> {
  const { db, clock, config, log } = deps;
  const image = config.sandbox.snapshot!;
  if (waking.image === image) return { done: false, waking };
  const designId = waking.designId;
  const fields = { designId, sandboxId: waking.id, from: waking.image, to: image };
  const held = (reason: Held): MoveOutcome => {
    log.info("sandbox_move_held", { ...fields, reason });
    return { done: false, waking };
  };
  const hold = moveHold(
    waking,
    image,
    config.sandbox.maxMoves,
    await getCheckpointCover(db, designId),
  );
  if (hold) return held(hold);
  if (deadline - clock.now() < MOVE_MS + WAKE_TIMEOUT_MS) return held("no_time");
  const slot = await takeMoveSlot(db, {
    id: waking.id,
    by,
    now: new Date(clock.now()),
    max: config.sandbox.maxMoves,
  });
  if (!slot) return held("moves_at_once");

  await showAgentWaiting(db, { designId, waking: true, blocker: null });
  const began = clock.now();
  const until = began + MOVE_MS;
  const generation = waking.generation + 1;
  const labels = sandboxLabels(config.sandbox.scope, designId, generation);
  const nextId = newId("sbx");
  const environment = await newEnvironment(deps, designId, claude);
  let providerId: string | null = null;
  let address: SandboxChanges = {};
  try {
    const created = await deps.sandbox.create({
      idempotencyKey: `${designId}-${generation}`,
      from: image,
      size: "small",
      name: `design-${designId}`,
      labels,
      env: environment.env,
      ports: [RUNNER_PORT],
      autoStopSeconds: AUTO_STOP_SECONDS,
    });
    providerId = created.sandbox.id;
    const port =
      created.addresses.find((a) => a.port === RUNNER_PORT) ??
      (await deps.sandbox.address(providerId, RUNNER_PORT));
    await deps.sandbox.ensureAwake(providerId, {
      timeoutMs: Math.max(10_000, until - clock.now()),
    });
    if (!(await answers(deps, port, until))) {
      throw new SandboxError("unavailable", "Its runner did not answer /health in time.");
    }
    address = await sealedAddress(deps, nextId, port);
  } catch (error) {
    await revokeRunnerToken(db, environment.runnerTokenId);
    await destroyQuietly(deps, designId, providerId, labels);
    // Ours (the database, the vault), or a create refused before anything was made for want of
    // starts or a provider that is away: the image is not to blame, and the job tries again.
    if (!(error instanceof SandboxError)) throw error;
    if (!providerId && WAITS.has(error.code)) throw error;
    if (!providerId && error.code === "conflict") {
      // An earlier attempt of this wake made this generation's machine and was cut off: it is
      // destroyed above, so the provider forgets the key, and the next attempt starts afresh.
      throw new SandboxError("busy", error.message, { retryAfterSeconds: 5 });
    }
    const reason = error.message.slice(0, 500);
    log.error("sandbox_move_failed", { ...fields, reason, ms: clock.now() - began });
    deps.analytics.exception(error, { design_id: designId, image });
    const kept = await moveSandbox(db, {
      id: waking.id,
      from: ["waking"],
      to: "waking",
      now: new Date(clock.now()),
      by,
      changes: { imageFailed: image, movingSince: null },
    });
    if (!kept) return { done: true, woke: null };
    // The old sandbox, as if no move had been tried: the person waits a little longer, no more.
    return { done: false, waking: kept };
  }

  const moved = await moveSandboxOnto(db, {
    id: waking.id,
    nextId,
    by,
    now: new Date(clock.now()),
    changes: {
      providerId,
      image,
      address: address.address ?? null,
      encryptedAddressToken: address.encryptedAddressToken ?? null,
      runnerTokenId: environment.runnerTokenId,
      claudeCredential: environment.claudeCredential,
    },
  });
  if (!moved) {
    // Another wake took the sandbox over meanwhile; it does the rest.
    await revokeRunnerToken(db, environment.runnerTokenId);
    await destroyQuietly(deps, designId, providerId, labels);
    return { done: true, woke: null };
  }
  // The old machine's disk is what the checkpoint holds; the new one has restored it.
  await destroyQuietly(deps, designId, waking.providerId, null);
  const ms = clock.now() - began;
  log.info("sandbox_moved", {
    ...fields,
    sandboxId: moved.sandbox.id,
    fromSandboxId: waking.id,
    ms,
  });
  deps.analytics.capture(
    "sandbox moved",
    { design_id: designId, from_image: waking.image, to_image: image, duration_ms: ms },
    // About the design's owner, whose Claude it runs on, as "sandbox woke" is.
    { distinctId: context.ownerId, workspaceId: context.workspaceId },
  );
  return { done: true, woke: await awake(deps, moved.sandbox, "moved", by) };
}

/** Whether a runner answers `/health` through its address before `until`. */
async function answers(
  deps: JobDeps,
  port: { url: string; token: string | null },
  until: number,
): Promise<boolean> {
  const address = { url: port.url, token: port.token };
  for (;;) {
    if ((await deps.runnerPort.health(address, HEALTH_MS)).ok) return true;
    if (deps.clock.now() >= until) return false;
    await deps.clock.sleep(HEALTH_POLL_MS);
  }
}

/**
 * Destroy a machine a move made or left, by its id or, not knowing it, by its generation's
 * labels. A destroy that fails is logged: the orphan sweep finds the machine once no row
 * claims it.
 */
async function destroyQuietly(
  deps: JobDeps,
  designId: string,
  providerId: string | null,
  labels: Record<string, string> | null,
): Promise<void> {
  try {
    const ids = providerId
      ? [providerId]
      : labels
        ? (await deps.sandbox.list({ labels }))
            .filter((found) => found.state !== "gone")
            .map((found) => found.id)
        : [];
    for (const id of ids) await deps.sandbox.destroy(id);
  } catch (error) {
    deps.log.warn("sandbox_destroy_failed", { designId, providerId, error });
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
  const made = await create(deps, claimed(next), claude, by);
  return made && { ...made, replaced: true };
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
  // A sandbox made just now has a runner still booting, which claims the feed by itself once it
  // is up: a poke would only find nobody listening yet. A move's runner has answered `/health`
  // already and may have made its first claim before the row moved: a message sent meanwhile
  // found no awake sandbox to poke, so it is poked now rather than at its next minute's claim.
  if (start === "created") return { sandbox: moved, start };
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
