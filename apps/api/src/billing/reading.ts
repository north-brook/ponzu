import {
  getWorkspace,
  readWorkspaceUsage,
  type Workspace,
  type WorkspaceUsageRead,
} from "@ponzu/db";
import type { JobDeps } from "../jobs/run.ts";
import { capWarning } from "./credits.ts";
import { type BillingGate, billingGate, GRACE_MS } from "./gate.ts";
import { type BillingPeriod, billingPeriod } from "./period.ts";
import { workspaceUsage } from "./usage.ts";

/*
 * A workspace's billing gate worked out from its numbers now (docs/cloud.md, "Billing"), by the
 * same arithmetic as Plan and usage. Reading only: `refreshBillingGate` (refresh.ts) stores it,
 * and a 402 (enforce.ts) shows its numbers.
 */

/** What the gate was worked out from, and what it came to. */
export interface GateReading {
  gate: BillingGate;
  workspace: Workspace;
  period: BillingPeriod;
  usedCredits: number;
  freeCredits: number;
  billedCents: number;
  capCents: number;
  hasCard: boolean;
  /** Billed has reached the warning share of the cap (only with a card). */
  capWarning: boolean;
}

/**
 * Work the workspace's gate out from its numbers now, reading only (`readWorkspaceUsage` and the
 * workspace's row). `read` is handed back, so a caller can grant the allowances it lacks.
 */
export async function readBillingGate(
  deps: Pick<JobDeps, "db" | "clock">,
  workspaceId: string,
): Promise<(GateReading & { read: WorkspaceUsageRead }) | null> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace) return null;
  const now = new Date(deps.clock.now());
  const period = billingPeriod(workspace.billingPeriodAnchor, now);
  const read = await readWorkspaceUsage(deps.db, {
    workspaceId,
    // Nobody's view: only the totals are used, never which canvases someone may read.
    viewerId: "",
    start: period.start,
    end: period.end,
    now,
  });
  if (!read) return null;
  return { ...gateOf(workspace, period, read, now), read };
}

/** The gate from a period's read, by the same arithmetic as Plan and usage. */
export function gateOf(
  workspace: Workspace,
  period: BillingPeriod,
  read: WorkspaceUsageRead,
  now: Date,
): GateReading {
  const usage = workspaceUsage(read, period, {
    user: { id: "", name: null, githubLogin: "", avatarUrl: null },
    member: { role: "member", githubAccess: "member" },
  });
  const { current } = read;
  const { usedCredits: used, freeCredits: free, billedCents } = usage;
  const capCents = read.monthlyCapCents ?? current.defaultCapCents;
  const hasCard = workspace.stripePaymentMethodId !== null;
  return {
    gate: billingGate({
      usedCredits: used,
      freeCredits: free,
      billedCents,
      capCents,
      hasCard,
      pastDueSince: workspace.pastDueAt,
      now,
      graceMs: GRACE_MS,
    }),
    workspace,
    period,
    usedCredits: used,
    freeCredits: free,
    billedCents,
    capCents,
    hasCard,
    capWarning: hasCard && capWarning(billedCents, capCents, current.capWarningFraction),
  };
}
