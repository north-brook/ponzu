import {
  getCanvas,
  hasPendingEvents,
  moveSandbox,
  revokeRunnerTokens,
  type SandboxRow,
} from "@ponzu/db";
import { IMAGE_COMMANDS } from "@ponzu/runner/protocol";
import { type At, SandboxError } from "@ponzu/sandbox";
import type { SleepWhy } from "../analytics/events.ts";
import type { JobDeps } from "../jobs/run.ts";
import { STOP_COMMAND_MS } from "./constants.ts";
import { sandboxName } from "./orchestrate.ts";
import { startWake } from "./wake.ts";

export type { SleepWhy } from "../analytics/events.ts";

/*
 * Putting an awake sandbox to sleep (docs/cloud.md, "The sandbox"). The API runs the runner's
 * shutdown itself rather than leave it to the SIGTERM Vercel's stop sends (its grace is not
 * documented; about 20 s was measured): `ponzu-stop` signals the supervisor and waits for it,
 * and the runner interrupts its turn, flushes what it has, reports, saves a checkpoint and closes
 * Claude Code; then `sync`. Then the stop, which snapshots the disk. Every call is pinned to the
 * session the row holds, so a session that already ended is never resumed to be stopped.
 */

export interface SleepOptions {
  /** Only if nobody has kept it awake since then, so a fresh message wins over an idle stop. */
  idleBefore?: Date;
  /**
   * Wake it again at once, for this reason (a restart). Without it, the pending rule: a wake
   * when the feed holds work no runner took.
   */
  wake?: string;
  /** Why it failed, for the row (`sandbox_failed`). */
  failure?: string;
  /**
   * Let the runner go before its shutdown, so it writes nothing more: the sweep has said what
   * happens to the turn it cut (a lapse sends it again), and the runner's own "send a message to
   * pick it up" would say otherwise. Its disk is kept by the stop's snapshot all the same.
   */
  silenced?: boolean;
}

/**
 * How long an awake row has been awake at `now`: since it woke (`state_at`), not since
 * `awake_since`, which the meter moves on as it cuts. Zero for a row that is not awake.
 */
export function awakeFor(row: Pick<SandboxRow, "state" | "stateAt">, now: number): number {
  return row.state === "awake" ? now - row.stateAt.getTime() : 0;
}

/** Put the awake `row` to sleep. False when it was not this call that moved it. */
export async function putToSleep(
  deps: JobDeps,
  row: SandboxRow,
  why: SleepWhy,
  options: SleepOptions = {},
): Promise<boolean> {
  const { db, clock, log, sandboxes } = deps;
  const { canvasId } = row;
  const by = `stop:${crypto.randomUUID()}`;
  const stopping = await moveSandbox(db, {
    canvasId,
    from: ["awake"],
    to: "stopping",
    now: new Date(clock.now()),
    hold: by,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(options.idleBefore ? { idleBefore: options.idleBefore } : {}),
  });
  if (!stopping) return false;
  const awakeMs = awakeFor(row, clock.now());
  const began = clock.now();
  if (options.silenced) await revokeRunnerTokens(db, canvasId);
  if (stopping.sessionId) {
    const at: At = { name: sandboxName(deps, canvasId), sessionId: stopping.sessionId };
    try {
      const done = await sandboxes.exec(at, {
        cmd: IMAGE_COMMANDS.stop,
        sudo: true,
        timeoutMs: STOP_COMMAND_MS,
      });
      if (done.exitCode !== 0)
        log.warn("runner_stop_failed", { canvasId, exitCode: done.exitCode });
    } catch (error) {
      // Not running any more (Vercel stopped it): nothing to shut down, and the stop is a no-op.
      if (!(error instanceof SandboxError && error.code === "not_running")) {
        log.warn("runner_stop_failed", { canvasId, error });
      }
    }
    try {
      const stopped = await sandboxes.stop(at);
      log.info("sandbox_stopped", {
        canvasId,
        why,
        stopped: stopped.stopped,
        snapshotBytes: stopped.snapshotBytes,
        ms: clock.now() - began,
      });
    } catch (error) {
      // Left running: a wake's `up()` finds it running and shuts it down before it starts, and
      // reconcile stops a session no awake row holds.
      log.warn("sandbox_stop_failed", { canvasId, why, error });
    }
  }
  // While the row is still held, so a wake after it keeps the token it makes.
  await revokeRunnerTokens(db, canvasId);
  const asleep = await moveSandbox(db, {
    canvasId,
    from: ["stopping"],
    to: "asleep",
    now: new Date(clock.now()),
    by,
    ...(options.failure ? { changes: { failure: options.failure } } : {}),
  });
  if (!asleep) return true;
  await captureSlept(deps, canvasId, why, awakeMs);
  if (options.wake) await startWake(deps, canvasId, options.wake);
  // A sandbox put down as failed waits for the person's next message: the pending rule would
  // wake it straight back into whatever failed, over and over.
  else if (!options.failure) await wakeIfPending(deps, canvasId);
  return true;
}

/** The pending rule: an asleep canvas whose feed holds work no runner took is woken for it. */
export async function wakeIfPending(deps: JobDeps, canvasId: string): Promise<void> {
  if (await hasPendingEvents(deps.db, canvasId)) await startWake(deps, canvasId, "pending");
}

/** `sandbox slept`, about the canvas's owner under its workspace. Never fails the stop. */
export async function captureSlept(
  deps: JobDeps,
  canvasId: string,
  why: SleepWhy,
  awakeMs: number,
): Promise<void> {
  const canvas = await getCanvas(deps.db, canvasId).catch(() => null);
  if (!canvas) return;
  deps.analytics.capture(
    "sandbox slept",
    { canvas_id: canvasId, why, awake_ms: Math.max(0, awakeMs) },
    { distinctId: canvas.ownerId, workspaceId: canvas.workspaceId },
  );
}
