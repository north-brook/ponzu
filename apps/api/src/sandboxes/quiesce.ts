import {
  getDesign,
  getQuiescedFor,
  getWakeContext,
  runnerHeardSince,
  type Sandbox,
} from "@ponzu/db";
import type { HealthCheck } from "../deps/poke.ts";
import type { JobDeps } from "../jobs/run.ts";

/*
 * The two ends of a sleep (docs/cloud.md, "The sandbox"), as the runner protocol has them.
 *
 * Before a stop the API asks the runner to get ready, through state rather than a command: the
 * sandbox's row is `stopping` already, and every state answer says so (`sleep`, the move's time).
 * `POST /report` on the runner's port only makes it send a report now; it carries nothing, so
 * whatever reaches the port (the agent can, on localhost) can at most make it ask. The runner
 * takes no new work, finishes its turn, lets its edits reach the API, saves a checkpoint, runs
 * `sync` and says it is ready (`quiesced`); the stop waits for that a while, then runs `sync`
 * itself through the provider, and stops. A runner that never answers is stopped all the same.
 *
 * After a warm resume, which thaws the same boot, a runner that had exited stays exited: the API
 * looks at `/health`, and at whether the runner has called it since the thaw, and only when
 * neither says it is up starts the unit again through the provider.
 *
 * Function time. Every wait here runs inside a function with 300 seconds (apps/api/README.md),
 * so each is bounded, and one attempt of a wake keeps to a budget (orchestrate.ts,
 * `WAKE_BUDGET_MS`, 260 s) that the worst of them fits:
 *
 *   a stop to wait out (afterStop), or a stop of its own (quiesce, sync)   60 s, or 30 + 10 s
 *   the resume                                                              90 s
 *   /health, `systemctl start` and /health again                            3 + 15 + 3 s
 *   `sync`, the stop and a cold start on a new environment                  10 + 90 s
 *
 * An attempt with too little left for the revive and the cold start after it skips the revive
 * and goes cold; one with too little left for the cold start is tried again by the job. The
 * sweep puts sandboxes to sleep in parallel, each stop at most 30 + 10 s.
 */

/** How long a stop waits for the runner to be ready, and how often it looks. */
export const QUIESCE_MS = 30_000;
const QUIESCE_POLL_MS = 1_000;
/** How long `sync` may take before the stop goes ahead. */
const SYNC_SECONDS = 10;
/** How long `/health` has to answer after a warm resume, and after the unit is started again. */
export const HEALTH_MS = 3_000;
const SYSTEMCTL_SECONDS = 10;
export const REVIVE_MS = 15_000;
const REVIVE_POLL_MS = 1_000;
/**
 * What starting the unit again may take, at most: the first look, then the start and the looks
 * after it (`REVIVE_MS` holds both, and the last look may run past it).
 */
export const REVIVE_BUDGET_MS = HEALTH_MS + REVIVE_MS + HEALTH_MS;
/** What a stop with `sync` may take before the next start, besides the provider's own calls. */
export const SYNC_MS = SYNC_SECONDS * 1000;

/** Where the API reaches a sandbox's runner, with the token that opens its address. */
export async function runnerAddress(
  { vault }: Pick<JobDeps, "vault">,
  sandbox: Pick<Sandbox, "id" | "address" | "encryptedAddressToken">,
): Promise<{ url: string; token: string | null } | null> {
  if (!sandbox.address) return null;
  const token = sandbox.encryptedAddressToken
    ? await vault.open(sandbox.encryptedAddressToken, addressBinding(sandbox.id))
    : null;
  return { url: sandbox.address, token };
}

export function addressBinding(sandboxId: string) {
  return { column: "sandboxes.encrypted_address_token", row: sandboxId };
}

/**
 * Stop a sandbox the caller has just moved to `stopping` (`stopping` is that row): with
 * `quiesce`, after its runner has said it is ready or `QUIESCE_MS` has passed; then `sync`
 * through the provider, then the stop. A runner known to be dead is not waited for.
 */
export async function stopSandbox(
  deps: JobDeps,
  stopping: Sandbox,
  { quiesce }: { quiesce: boolean },
): Promise<void> {
  const { clock, log } = deps;
  const began = clock.now();
  let ready = false;
  const address = quiesce ? await runnerAddress(deps, stopping) : null;
  if (address) {
    let asked = true;
    try {
      await deps.runnerPort.report(address);
    } catch (error) {
      // Not answering its port: there is no runner to wait for.
      asked = false;
      log.info("quiesce_unanswered", { designId: stopping.designId, error });
    }
    while (asked && clock.now() - began < QUIESCE_MS) {
      const answered = await getQuiescedFor(deps.db, stopping.designId);
      if (answered?.getTime() === stopping.stateAt.getTime()) {
        ready = true;
        break;
      }
      await clock.sleep(QUIESCE_POLL_MS);
    }
  }
  const quiesceMs = clock.now() - began;
  const synced = clock.now();
  await syncDisk(deps, stopping.providerId!, stopping.designId);
  const syncMs = clock.now() - synced;
  await deps.sandbox.stop(stopping.providerId!);
  log.info("sandbox_stopping", {
    designId: stopping.designId,
    sandboxId: stopping.id,
    quiesced: ready,
    asked: address !== null,
    quiesceMs,
    syncMs,
  });
  // Under its workspace, which the row does not say. The stop is done whatever this finds.
  const design = await getDesign(deps.db, stopping.designId).catch(() => null);
  if (design) {
    deps.analytics.capture(
      "sandbox slept",
      { design_id: design.id, quiesced: ready },
      { distinctId: design.ownerId, workspaceId: design.workspaceId },
    );
  }
}

/**
 * `sync` through the provider, before any stop of a running machine: what was written and not
 * flushed is lost by a stop that turns cold, whatever the runner did. A failure is logged; the
 * stop goes ahead.
 */
export async function syncDisk(deps: JobDeps, providerId: string, designId: string) {
  try {
    const result = await deps.sandbox.exec(providerId, "sync", { timeoutSeconds: SYNC_SECONDS });
    if (result.exitCode !== 0) deps.log.warn("sync_failed", { designId });
  } catch (error) {
    deps.log.warn("sync_failed", { designId, error });
  }
}

export type Revived = "up" | "revived" | "down" | "stay_down";

/**
 * After a warm resume: whether the runner is up, and if it does not seem to be, start its unit
 * again through the provider (`systemctl start`, which does nothing to one that runs) and look
 * again. `down` when it still does not: only a cold start on a new environment is left.
 * `stay_down` when the design was settled or deleted meanwhile: its runner exited on purpose,
 * the sweep destroys the sandbox, and nothing is started. With `startUnit` false (the wake has
 * no time left for it), a runner that does not seem up is `down` at once.
 *
 * Up is either of two things. `/health` answers through the sandbox's address; or the runner has
 * called the API since `since` (the resume began): a state report, a claim, an ack. The second
 * is what the thawed process does first, and on 2026-11-11 it did so for eighteen seconds while
 * its address answered nothing (docs/cloud.md, "A warm resume and a stopped runner"): taking a
 * failed health check alone for a dead runner had the wake stop the machine under a turn that
 * had just begun. A runner that calls in is up whatever its address does, and that is logged
 * (`runner_health_unreachable`) with what each look got, never the address's token.
 */
export async function reviveRunner(
  deps: JobDeps,
  sandbox: Sandbox,
  { startUnit = true, since }: { startUnit?: boolean; since?: number } = {},
): Promise<Revived> {
  const { clock, log } = deps;
  const address = await runnerAddress(deps, sandbox);
  if (!address) return "up";
  const ids = { designId: sandbox.designId, sandboxId: sandbox.id };
  const looks: HealthCheck[] = [];
  const look = async () => {
    const check = await deps.runnerPort.health(address, HEALTH_MS);
    looks.push(check);
    return check.ok;
  };
  /** What the looks got, for the log: how many, the first and the last. */
  const seen = () => ({
    host: hostOf(address.url),
    looks: looks.length,
    first: looks[0] && describe(looks[0]),
    last: looks.length > 1 ? describe(looks.at(-1)!) : undefined,
  });
  const heard = async () => {
    if (since === undefined) return false;
    if (!(await runnerHeardSince(deps.db, { designId: sandbox.designId, since: new Date(since) })))
      return false;
    log.warn("runner_health_unreachable", { ...ids, ...seen(), sinceMs: clock.now() - since });
    return true;
  };

  if (await look()) return "up";
  log.info("runner_health_failed", { ...ids, ...seen() });
  if (await heard()) return "up";
  const context = await getWakeContext(deps.db, sandbox.designId);
  if (!context || context.status === "settled") return "stay_down";
  if (!startUnit) return "down";
  const began = clock.now();
  try {
    const started = await deps.sandbox.exec(
      sandbox.providerId!,
      "sudo systemctl start ponzu-runner",
      { timeoutSeconds: SYSTEMCTL_SECONDS },
    );
    if (started.exitCode !== 0) {
      if (await heard()) return "up";
      log.warn("runner_revive_failed", { ...ids, ...seen(), exitCode: started.exitCode });
      return "down";
    }
  } catch (error) {
    if (await heard()) return "up";
    log.warn("runner_revive_failed", { ...ids, ...seen(), error });
    return "down";
  }
  while (clock.now() - began < REVIVE_MS) {
    if (await look()) {
      log.info("runner_revived", { ...ids, ...seen(), ms: clock.now() - began });
      return "revived";
    }
    if (await heard()) return "up";
    await clock.sleep(REVIVE_POLL_MS);
  }
  log.warn("runner_revive_failed", { ...ids, ...seen(), heard: false });
  return "down";
}

/** One look as a log field: what answered, or what the request failed with, and how long. */
function describe(check: HealthCheck): string {
  return `${check.status ?? check.error ?? "no answer"} in ${check.ms} ms`;
}

/** An address's host alone: the path and the token are no business of a log. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
