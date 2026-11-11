import { anonymiseUser, deleteDesign, deleteUser, planAccountDeletion, type User } from "@ponzu/db";
import type { ClaudeDeps } from "../claude/accounts.ts";
import { disconnectClaude } from "../claude/accounts.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { destroySandboxes, retireSandboxes } from "../sandboxes/retire.ts";

/*
 * Deleting a person's account (docs/cloud.md, "Deleting an account"). In this order, each step
 * safe to repeat, so a request that fails partway can be sent again until it is done:
 *
 *   refused while they are the only admin of an organization others are in
 *   their Claude credential destroyed, with every sandbox that held it
 *   every sandbox of a design they own retired
 *   their designs that are theirs alone deleted: Scratch, and those in their own account
 *   their name taken out of what stays (thread items, the history of ops)
 *   their row deleted, and with it their sessions (ended at once), GitHub token, memberships,
 *     repo access, Claude account, devices and sign-ins
 *   their WorkOS user deleted, in the background: their next sign-in is someone new
 *
 * Designs they own in an organization's workspace stay with it, owned by nobody: their
 * canvas, thread and pull request are the team's work, in the team's repo.
 */

export type DeleteAccountDeps = ClaudeDeps & Pick<Deps, "workos">;

export async function deleteAccount(deps: DeleteAccountDeps, user: User): Promise<void> {
  const { db, log } = deps;
  const plan = await planAccountDeletion(db, user.id);
  if (plan.soleAdminOf.length > 0) {
    throw new ApiError(
      409,
      "sole_admin",
      "You are the only admin of a team others are in. Make someone else an admin first.",
      { details: { workspaces: plan.soleAdminOf } },
    );
  }

  await disconnectClaude(deps, user.id);
  const machines: string[] = [];
  for (const designId of [...plan.kept, ...plan.deleted]) {
    machines.push(...(await retireSandboxes(deps, designId)));
  }
  for (const designId of plan.deleted) await deleteDesign(db, designId);
  await anonymiseUser(db, user.id);
  const workosUserId = await deleteUser(db, user.id);
  log.info("account_deleted", {
    userId: user.id,
    deletedDesigns: plan.deleted.length,
    keptDesigns: plan.kept.length,
  });

  deps.background("account_deleted", destroySandboxes(deps, machines));
  if (workosUserId) deps.background("account_deleted", deps.workos.deleteUser(workosUserId));
}
