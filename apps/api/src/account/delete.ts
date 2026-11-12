import {
  anonymiseUser,
  deleteCanvas,
  deleteUser,
  listUserWorkspaces,
  planAccountDeletion,
  type User,
} from "@ponzu/db";
import { keepAllowances } from "../billing/allowances.ts";
import type { ClaudeDeps } from "../claude/accounts.ts";
import { disconnectClaude } from "../claude/accounts.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { forgetCheckpoints } from "../runner/checkpoint.ts";
import { finishRetire, holdForRetire } from "../sandboxes/retire.ts";

/*
 * Deleting a person's account (docs/cloud.md, "Deleting an account"). In this order, each step
 * safe to repeat, so a request that fails partway can be sent again until it is done:
 *
 *   refused while they are the only admin of a workspace others are in
 *   their Claude credential destroyed, with every sandbox that held it
 *   every sandbox of a canvas they own retired
 *   their canvases that are theirs alone deleted: Scratch, and those in a workspace nobody
 *     else is in
 *   their name taken out of what stays (thread items, the history of ops)
 *   this period's free allowance granted in each workspace they are in, so it stays counted
 *   their row deleted, and with it their sessions (ended at once), GitHub token, memberships,
 *     repo access, Claude account, devices and sign-ins; refused, as the first step, if
 *     another admin's deletion has meanwhile left them the only one
 *   their WorkOS user deleted, in the background: their next sign-in is someone new
 *
 * Canvases they own in a workspace others are in stay with it, owned by nobody: their boards,
 * thread and pull request are work others share, in a repo others reach.
 */

export type DeleteAccountDeps = ClaudeDeps & Pick<Deps, "workos" | "archives" | "analytics">;

export async function deleteAccount(deps: DeleteAccountDeps, user: User): Promise<void> {
  const { db, log } = deps;
  const plan = await planAccountDeletion(db, user.id);
  if (plan.soleAdminOf.length > 0) throw soleAdmin(plan.soleAdminOf);

  await disconnectClaude(deps, user.id);
  // Held first, which meters what was awake while the canvas's row still says whose it is.
  const retiring: { canvasId: string; by: string | null }[] = [];
  for (const canvasId of [...plan.kept, ...plan.deleted]) {
    retiring.push({ canvasId, by: await holdForRetire(deps, canvasId) });
  }
  const forgotten: (() => Promise<void>)[] = [];
  for (const canvasId of plan.deleted) {
    forgotten.push(await forgetCheckpoints(deps, canvasId));
    await deleteCanvas(db, canvasId);
  }
  await anonymiseUser(db, user.id);
  // Leaving mid-period does not take back the free credits they brought.
  for (const workspace of await listUserWorkspaces(db, user.id)) {
    await keepAllowances(deps, workspace.id, [user.id]);
  }
  // Checked again as the row goes: another admin may have deleted themselves meanwhile.
  const deleted = await deleteUser(db, user.id);
  if (deleted.status === "sole_admin") {
    throw soleAdmin((await planAccountDeletion(db, user.id)).soleAdminOf);
  }
  const workosUserId = deleted.status === "deleted" ? deleted.workosUserId : null;
  log.info("account_deleted", {
    userId: user.id,
    deletedCanvases: plan.deleted.length,
    keptCanvases: plan.kept.length,
  });
  deps.analytics.capture(
    "account deleted",
    { deleted_canvases: plan.deleted.length, kept_canvases: plan.kept.length },
    { distinctId: user.id },
  );

  for (const { canvasId, by } of retiring) {
    deps.background("account_deleted", finishRetire(deps, canvasId, by));
  }
  // The transcripts and work in progress of the canvases that went with them.
  for (const forget of forgotten) deps.background("account_deleted", forget());
  if (workosUserId) deps.background("account_deleted", deps.workos.deleteUser(workosUserId));
}

/** The refusal while the person is the only admin of a workspace others are in. */
function soleAdmin(workspaces: { id: string; name: string }[]): ApiError {
  return new ApiError(409, "sole_admin", "Make someone else an admin first.", {
    details: { workspaces },
  });
}
