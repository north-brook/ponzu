import { adjustCredits, type Db, getWorkspace } from "@ponzu/db";
import { type BillingPeriod, billingPeriod } from "./period.ts";

/*
 * Support's credit adjustments (docs/cloud.md, "Billing"), as `scripts/credit.ts` makes them: a
 * whole number of credits added to (or, negative, taken from) a workspace's free credits for the
 * period running now, with a note saying why. It is a ledger row (`adjustment`) and nothing else:
 * Plan and usage counts it in the free credits from the next read.
 */

export interface Adjusted {
  id: string;
  period: BillingPeriod;
}

/** Adjust the workspace's free credits this period. Throws for no such workspace. */
export async function adjustWorkspaceCredits(
  db: Db,
  {
    workspaceId,
    credits,
    note,
    now,
  }: { workspaceId: string; credits: number; note: string; now: Date },
): Promise<Adjusted> {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) throw new Error(`There is no workspace ${workspaceId}.`);
  const period = billingPeriod(workspace.billingPeriodAnchor, now);
  const id = await adjustCredits(db, {
    workspaceId: workspace.id,
    periodStart: period.start,
    credits,
    note,
  });
  return { id, period };
}
