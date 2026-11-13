import { grantAllowances, listWorkspacesToGate, recordOnce, setBillingGate } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import type { JobDeps } from "../jobs/run.ts";
import type { BillingNotice } from "../notifications/kinds.ts";
import { notify } from "../notifications/notify.ts";
import { resumeBlocked } from "../sandboxes/wake.ts";
import { BILLING_BLOCKERS, type BillingGate } from "./gate.ts";
import { type GateReading, readBillingGate } from "./reading.ts";
import { ungranted } from "./usage.ts";

/*
 * The cached billing gate (docs/cloud.md, "Billing"). The routes, the wake and the runner's claim
 * never work the gate out themselves: they read `workspaces.billing_gate`, which this keeps. It
 * is worked out again by the minute's sweep (every workspace with a sandbox up or just put to
 * sleep, and every workspace held back, at most `GATES_PER_RUN` a run) and right after something
 * that can open it: a cap change, and later a card, a paid invoice and a period close.
 *
 * While PONZU_BILLING is off none of this runs: nothing is read, written or told. In observe the
 * gate is worked out and stored, so `billing_gate_would_refuse` can be read in the logs, but
 * nobody is pinged, since nothing is refused and nobody could add a card. Only when it is on are
 * the admins pinged, once a period each, through `notify` with billing's own words.
 */

/** Workspaces whose gate the sweep works out again in one run, at most. */
export const GATES_PER_RUN = 50;
/** How far back the sweep looks for a sandbox that moved (a sleep metered its stretch). */
export const MOVED_WITHIN_MS = 2 * 60_000;

/** What `refreshBillingGate` may use: a job's deps, and somewhere to run wakes past a request. */
export type RefreshDeps = JobDeps & Partial<Pick<Deps, "background">>;

/**
 * Work the workspace's gate out again and store it. On a change it is logged; when the gate opens
 * again, the canvases it held back are woken (`resumeBillingBlocked`). With billing on, admins are
 * pinged once a period for each notice the numbers now call for. Null while billing is off (it
 * reads and writes nothing then) and when there is no workspace.
 */
export async function refreshBillingGate(
  deps: RefreshDeps,
  workspaceId: string,
): Promise<{ before: BillingGate; after: BillingGate } | null> {
  if (deps.features.billing === "off") return null;
  const reading = await readBillingGate(deps, workspaceId);
  if (!reading) return null;
  const now = new Date(deps.clock.now());
  // As Plan and usage does: someone who is a member this period is counted for it from now on.
  const missing = ungranted(reading.read);
  if (missing.length > 0) {
    await grantAllowances(deps.db, {
      workspaceId,
      periodStart: reading.period.start,
      now,
      userIds: missing,
    });
  }
  const stored = await setBillingGate(deps.db, { workspaceId, gate: reading.gate, at: now });
  if (!stored) return null;
  const { before, after } = stored;
  if (before !== after) deps.log.info("billing_gate_changed", { workspaceId, before, after });
  if (deps.features.billing === "on") await tellAdmins(deps, reading);
  if (after === "ok" && before !== "ok") await resumeBillingBlocked(deps, workspaceId);
  return { before, after };
}

/** The notices the numbers call for now, each sent once a period. */
async function tellAdmins(deps: RefreshDeps, reading: GateReading): Promise<void> {
  const notices: { notice: BillingNotice; amountCents: number | null }[] = [];
  if (reading.gate === "free_used") notices.push({ notice: "free_used", amountCents: null });
  if (reading.gate === "cap_reached") {
    notices.push({ notice: "cap_reached", amountCents: reading.capCents });
  } else if (reading.gate === "ok" && reading.capWarning) {
    notices.push({ notice: "cap_warning", amountCents: reading.capCents });
  }
  const periodStart = reading.period.start.toISOString();
  for (const { notice, amountCents } of notices) {
    // The notifications' own dedupe key keeps it to one row a person; this keeps it to one job.
    const first = await recordOnce(deps.db, {
      kind: "billing.notice",
      key: `${notice}:${reading.workspace.id}:${periodStart}`,
    });
    if (!first) continue;
    await notify(deps, {
      kind: "billing",
      workspaceId: reading.workspace.id,
      periodStart,
      notice,
      amountCents,
    });
    deps.analytics.capture(
      "billing notice",
      { kind: notice },
      { distinctId: null, workspaceId: reading.workspace.id },
    );
  }
}

/**
 * The gate opened again (a card, a higher cap, a paid invoice, a new period): lift billing's
 * blockers in the workspace and wake the canvases that have something waiting, up to
 * `RESUME_AT_ONCE` at once and the rest through the cron (`resumeBlocked`). A runner already awake
 * takes up what its claim held back at its next claim, within a minute.
 */
export async function resumeBillingBlocked(deps: RefreshDeps, workspaceId: string) {
  const pending: Promise<unknown>[] = [];
  const background = deps.background ?? ((_name, work) => void pending.push(work));
  const resumed = await resumeBlocked(
    { ...deps, background },
    { workspaceId, blockers: BILLING_BLOCKERS },
  );
  await Promise.all(pending);
  return resumed;
}

/**
 * The sweep's pass: work out again the gate of each workspace that may have moved, at most
 * `GATES_PER_RUN`, those worked out longest ago first. Answers how many were. One workspace's
 * failure is logged and leaves the others.
 */
export async function refreshBillingGates(deps: RefreshDeps, now: Date): Promise<number> {
  if (deps.features.billing === "off") return 0;
  const ids = await listWorkspacesToGate(deps.db, {
    since: new Date(now.getTime() - MOVED_WITHIN_MS),
    limit: GATES_PER_RUN,
  });
  let refreshed = 0;
  for (const workspaceId of ids) {
    try {
      if (await refreshBillingGate(deps, workspaceId)) refreshed++;
    } catch (error) {
      deps.log.warn("sweep_failed", { step: "billing_gate", workspaceId, error });
      deps.analytics.exception(error, { sweep_step: "billing_gate" });
    }
  }
  return refreshed;
}
