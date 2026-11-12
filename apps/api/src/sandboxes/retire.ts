import {
  deleteSandboxRow,
  getDesign,
  moveSandbox,
  revokeRunnerTokens,
  SANDBOX_STATES,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { sandboxName } from "./orchestrate.ts";

/*
 * A design that is settled or deleted needs no sandbox (docs/cloud.md, "Settle"). The retire
 * holds the row as `stopping` (`waking_by = 'retire:<job>'`) whatever it was doing, which meters
 * what was awake and turns away any wake that held it; revokes its runner tokens, so the runner
 * hears at its next call that it is done; stops the session if one runs, and deletes the sandbox
 * at Vercel; and only then deletes the row. A design reopened meanwhile finds its row `stopping`
 * and its wake waits or retries, so a late delete can never hit its new sandbox. A settled
 * design's retire holds the row only while the design is still settled, so a retire that comes
 * late (a sweep that listed it before a reopen) leaves the reopened design be. A retire that
 * dies leaves the row held: the sweep's retire step runs it again.
 */

type RetireDeps = Pick<Deps, "db" | "clock" | "log" | "sandboxes" | "config">;

/**
 * Hold the design's row for a retire. Answers who holds it, or null when it has no row.
 * `whileSettled` holds it only while the design is settled; one reopened (or deleted) since
 * answers "reopened" and is not touched: a deleted design's retire runs with its delete.
 */
export async function holdForRetire(deps: RetireDeps, designId: string): Promise<string | null>;
export async function holdForRetire(
  deps: RetireDeps,
  designId: string,
  options: { whileSettled: true },
): Promise<string | null | "reopened">;
export async function holdForRetire(
  deps: RetireDeps,
  designId: string,
  { whileSettled = false }: { whileSettled?: boolean } = {},
): Promise<string | null | "reopened"> {
  const by = `retire:${crypto.randomUUID()}`;
  const held = await moveSandbox(deps.db, {
    designId,
    from: SANDBOX_STATES,
    to: "stopping",
    now: new Date(deps.clock.now()),
    hold: by,
    whileSettled,
  });
  if (!held && whileSettled && (await getDesign(deps.db, designId))?.status !== "settled") {
    return "reopened";
  }
  await revokeRunnerTokens(deps.db, designId);
  return held ? by : null;
}

/**
 * Stop and delete the design's sandbox at Vercel, then the row `by` holds (a deleted design's
 * went with it). Missing is success at every step.
 */
export async function finishRetire(
  deps: RetireDeps,
  designId: string,
  by: string | null,
): Promise<void> {
  const name = sandboxName(deps, designId);
  const seen = await deps.sandboxes.status(name);
  if (seen?.status === "running" && seen.sessionId) {
    await deps.sandboxes.stop({ name, sessionId: seen.sessionId });
  }
  await deps.sandboxes.remove(name);
  if (by) await deleteSandboxRow(deps.db, { designId, by });
  deps.log.info("sandbox_retired", { designId });
}

/** Retire a settled design's sandbox: hold, stop, delete, then the row. Not once it is reopened. */
export async function retire(deps: RetireDeps, designId: string): Promise<void> {
  const by = await holdForRetire(deps, designId, { whileSettled: true });
  if (by === "reopened") {
    deps.log.info("sandbox_retire_skipped", { designId });
    return;
  }
  await finishRetire(deps, designId, by);
}
