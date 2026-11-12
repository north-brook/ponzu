import {
  deleteSandboxRow,
  getCanvas,
  getSandbox,
  moveSandbox,
  revokeRunnerTokens,
  SANDBOX_STATES,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { sandboxName } from "./orchestrate.ts";

/*
 * A canvas that is settled or deleted needs no sandbox (docs/cloud.md, "Settle"). The retire
 * holds the row as `stopping` (`waking_by = 'retire:<job>'`) whatever it was doing, which meters
 * what was awake and turns away any wake that held it; revokes its runner tokens, so the runner
 * hears at its next call that it is done; stops the session if one runs, and deletes the sandbox
 * at Vercel; and only then deletes the row. A canvas reopened meanwhile finds its row `stopping`
 * and its wake waits or retries, so a late delete can never hit its new sandbox. A settled
 * canvas's retire holds the row only while the canvas is still settled, so a retire that comes
 * late (a sweep that listed it before a reopen) leaves the reopened canvas be. A retire that
 * dies leaves the row held: the sweep's retire step runs it again.
 */

type RetireDeps = Pick<Deps, "db" | "clock" | "log" | "sandboxes" | "config">;

/**
 * Hold the canvas's row for a retire. Answers who holds it, or null when it has no row.
 * `whileSettled` holds it only while the canvas is settled, and never from another retire inside
 * its lease; a canvas reopened (or deleted) since, or one another retire holds, answers "skip"
 * and is not touched: a deleted canvas's retire runs with its delete, and the other retire, or
 * the sweep after its lease, finishes this one.
 */
export async function holdForRetire(deps: RetireDeps, canvasId: string): Promise<string | null>;
export async function holdForRetire(
  deps: RetireDeps,
  canvasId: string,
  options: { whileSettled: true },
): Promise<string | null | "skip">;
export async function holdForRetire(
  deps: RetireDeps,
  canvasId: string,
  { whileSettled = false }: { whileSettled?: boolean } = {},
): Promise<string | null | "skip"> {
  const by = `retire:${crypto.randomUUID()}`;
  const held = await moveSandbox(deps.db, {
    canvasId,
    from: SANDBOX_STATES,
    to: "stopping",
    now: new Date(deps.clock.now()),
    hold: by,
    whileSettled,
    unlessRetiring: whileSettled,
  });
  if (!held && whileSettled) {
    const reopened = (await getCanvas(deps.db, canvasId))?.status !== "settled";
    const retiring = (await getSandbox(deps.db, canvasId))?.wakingBy?.startsWith("retire:");
    if (reopened || retiring) return "skip";
  }
  await revokeRunnerTokens(deps.db, canvasId);
  return held ? by : null;
}

/**
 * Stop and delete the canvas's sandbox at Vercel, then the row `by` holds (a deleted canvas's
 * went with it). Missing is success at every step.
 */
export async function finishRetire(
  deps: RetireDeps,
  canvasId: string,
  by: string | null,
): Promise<void> {
  const name = sandboxName(deps, canvasId);
  const seen = await deps.sandboxes.status(name);
  if (seen?.status === "running" && seen.sessionId) {
    await deps.sandboxes.stop({ name, sessionId: seen.sessionId });
  }
  // Only while the row is still this retire's (or gone with its canvas): a retire that lost it
  // must not delete a sandbox someone made since.
  const row = by ? await getSandbox(deps.db, canvasId) : null;
  if (row && row.wakingBy !== by) {
    deps.log.warn("sandbox_retire_skipped", { canvasId, heldBy: row.wakingBy });
    return;
  }
  await deps.sandboxes.remove(name);
  if (by) await deleteSandboxRow(deps.db, { canvasId, by });
  deps.log.info("sandbox_retired", { canvasId });
}

/** Retire a settled canvas's sandbox: hold, stop, delete, then the row. Not once it is reopened. */
export async function retire(deps: RetireDeps, canvasId: string): Promise<void> {
  const by = await holdForRetire(deps, canvasId, { whileSettled: true });
  if (by === "skip") {
    deps.log.info("sandbox_retire_skipped", { canvasId });
    return;
  }
  await finishRetire(deps, canvasId, by);
}
