import { getWorkspace, grantAllowances } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { billingPeriod } from "./period.ts";

/*
 * A member's free allowance is granted once a period and never taken back (docs/cloud.md,
 * "Billing"). Plan and usage grants it to every member it sees; this grants it to people about
 * to leave a workspace, or who just left, so that leaving mid-period does not take it away.
 */

/** Grant each of `userIds` this period's allowance in the workspace, if they lack it. */
export async function keepAllowances(
  deps: Pick<Deps, "db" | "clock">,
  workspaceId: string,
  userIds: string[],
): Promise<void> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace) return;
  const now = new Date(deps.clock.now());
  const { start } = billingPeriod(workspace.billingPeriodAnchor, now);
  await grantAllowances(deps.db, { workspaceId, periodStart: start, now, userIds });
}
