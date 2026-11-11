import { getQuiescedFor, getWakeContext, type Sandbox } from "@ponzu/db";
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
 * looks at `/health` and starts the unit again through the provider.
 */

/** How long a stop waits for the runner to be ready, and how often it looks. */
export const QUIESCE_MS = 30_000;
const QUIESCE_POLL_MS = 1_000;
/** How long `sync` may take before the stop goes ahead. */
const SYNC_SECONDS = 30;
/** How long `/health` has to answer after a warm resume, and after the unit is started again. */
export const HEALTH_MS = 3_000;
export const REVIVE_MS = 20_000;
const REVIVE_POLL_MS = 1_000;

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
  // What was written and not flushed is lost by a stop that turns cold, whatever the runner did.
  const synced = clock.now();
  try {
    const result = await deps.sandbox.exec(stopping.providerId!, "sync", {
      timeoutSeconds: SYNC_SECONDS,
    });
    if (result.exitCode !== 0) log.warn("sync_failed", { designId: stopping.designId });
  } catch (error) {
    log.warn("sync_failed", { designId: stopping.designId, error });
  }
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
}

export type Revived = "up" | "revived" | "down" | "stay_down";

/**
 * After a warm resume: whether the runner answers `/health`, and if it does not, start its unit
 * again through the provider (`systemctl start`, which does nothing to one that runs) and look
 * again. `down` when it still does not answer: only a cold start on a new environment is left.
 * `stay_down` when the design was settled or deleted meanwhile: its runner exited on purpose,
 * the sweep destroys the sandbox, and nothing is started.
 */
export async function reviveRunner(deps: JobDeps, sandbox: Sandbox): Promise<Revived> {
  const { clock, log } = deps;
  const address = await runnerAddress(deps, sandbox);
  if (!address) return "up";
  if (await deps.runnerPort.healthy(address, HEALTH_MS)) return "up";
  const context = await getWakeContext(deps.db, sandbox.designId);
  if (!context || context.status === "settled") return "stay_down";
  const began = clock.now();
  try {
    const started = await deps.sandbox.exec(
      sandbox.providerId!,
      "sudo systemctl start ponzu-runner",
      { timeoutSeconds: 30 },
    );
    if (started.exitCode !== 0) {
      log.warn("runner_revive_failed", {
        designId: sandbox.designId,
        sandboxId: sandbox.id,
        exitCode: started.exitCode,
      });
      return "down";
    }
  } catch (error) {
    log.warn("runner_revive_failed", { designId: sandbox.designId, sandboxId: sandbox.id, error });
    return "down";
  }
  while (clock.now() - began < REVIVE_MS) {
    if (await deps.runnerPort.healthy(address, HEALTH_MS)) {
      log.info("runner_revived", {
        designId: sandbox.designId,
        sandboxId: sandbox.id,
        ms: clock.now() - began,
      });
      return "revived";
    }
    await clock.sleep(REVIVE_POLL_MS);
  }
  log.warn("runner_revive_failed", { designId: sandbox.designId, sandboxId: sandbox.id });
  return "down";
}
