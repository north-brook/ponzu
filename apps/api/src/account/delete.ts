import {
  anonymiseUser,
  deleteUser,
  listUserWorkspaces,
  planAccountDeletion,
  type User,
} from "@ponzu/db";
import { keepAllowances } from "../billing/allowances.ts";
import { deleteCanvasAndFiles } from "../canvases/files.ts";
import type { ClaudeDeps } from "../claude/accounts.ts";
import { disconnectClaude } from "../claude/accounts.ts";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { ApiError, UpstreamError } from "../http/errors.ts";
import { type RunNowDeps, runNow } from "../jobs/run.ts";
import { forgetCheckpoints } from "../runner/checkpoint.ts";
import { finishRetire, holdForRetire } from "../sandboxes/retire.ts";
import { accountForgetJob } from "./forget.ts";

/*
 * Deleting a person's account (docs/cloud.md, "Deleting an account"). In this order, each step
 * safe to repeat, so a request that fails partway can be sent again until it is done:
 *
 *   refused while they are the only admin of a workspace others are in
 *   their Claude credential destroyed, with every sandbox that held it
 *   every sandbox of a canvas they own retired
 *   their canvases that are theirs alone deleted: Scratch, and those in a workspace nobody
 *     else is in, each with its files (the same purge as deleting one canvas)
 *   their name taken out of what stays (thread items, the history of ops)
 *   this period's free allowance granted in each workspace they are in, so it stays counted
 *   their grant of the GitHub App revoked at GitHub, best effort: Ponzu leaves their GitHub
 *     authorizations, and a failure is logged and does not stop the rest
 *   their row deleted, and with it their sessions (ended at once), GitHub token, memberships,
 *     repo access, Claude account, devices and sign-ins; refused, as the first step, if
 *     another admin's deletion has meanwhile left them the only one
 *   a job recorded that forgets them outside Ponzu, tried again until it is done: their WorkOS
 *     user deleted (their next sign-in is someone new), then their PostHog person, events and
 *     recordings (account/forget.ts)
 *
 * Canvases they own in a workspace others are in stay with it, owned by nobody: their boards,
 * thread and pull request are work others share, in a repo others reach.
 */

export type DeleteAccountDeps = ClaudeDeps & RunNowDeps & Pick<Deps, "archives">;

/** How long revoking the GitHub grant may hold up the deletion, reading the token included. */
export const GITHUB_GRANT_REVOKE_MS = 10_000;

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
    // The row, and the job that deletes its files, in one statement; the job runs at once.
    await deleteCanvasAndFiles(deps, canvasId);
  }
  await anonymiseUser(db, user.id);
  // Leaving mid-period does not take back the free credits they brought.
  for (const workspace of await listUserWorkspaces(db, user.id)) {
    await keepAllowances(deps, workspace.id, [user.id]);
  }
  // While their token is still stored: the row's deletion takes it with it.
  await revokeGithubGrant(deps, user.id);
  // Checked again as the row goes: another admin may have deleted themselves meanwhile.
  const deleted = await deleteUser(db, user.id);
  if (deleted.status === "sole_admin") {
    throw soleAdmin((await planAccountDeletion(db, user.id)).soleAdminOf);
  }
  const workosUserId = deleted.status === "deleted" ? deleted.workosUserId : null;
  // Recorded before anything else is said about them, so only a failed insert can lose it.
  await runNow(deps, accountForgetJob({ userId: user.id, workosUserId }));
  log.info("account_deleted", {
    userId: user.id,
    deletedCanvases: plan.deleted.length,
    keptCanvases: plan.kept.length,
  });
  // About no one: PostHog is about to forget them, and deletes only what it had before it was
  // asked, so an event under their id now would make their person again.
  deps.analytics.capture(
    "account deleted",
    { deleted_canvases: plan.deleted.length, kept_canvases: plan.kept.length },
    { distinctId: null },
  );

  for (const { canvasId, by } of retiring) {
    deps.background("account_deleted", finishRetire(deps, canvasId, by));
  }
  // The transcripts and work in progress of the canvases that went with them.
  for (const forget of forgotten) deps.background("account_deleted", forget());
}

/**
 * Revoke the person's grant of the GitHub App, which ends every token of theirs and takes
 * Ponzu off their GitHub authorizations, with a live token of theirs (refreshed if it has run
 * out). Best effort and bounded: a person with no token has nothing to revoke, and a failure
 * or a GitHub slower than `GITHUB_GRANT_REVOKE_MS` is logged, ids and status only, and the
 * deletion goes on. They can still revoke it themselves in GitHub's settings.
 */
async function revokeGithubGrant(deps: DeleteAccountDeps, userId: string): Promise<void> {
  const { clock, github, log } = deps;
  const signal = clock.timeout(GITHUB_GRANT_REVOKE_MS);
  const gaveUp = new Promise<"timeout">((resolve) =>
    signal.addEventListener("abort", () => resolve("timeout"), { once: true }),
  );
  const revoke = async (): Promise<"revoked" | "no_token"> => {
    let token: string;
    try {
      token = await githubUserToken(deps, userId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "github_reauth_required") return "no_token";
      throw error;
    }
    await github.deleteAuthorization(token);
    return "revoked";
  };
  try {
    const outcome = await Promise.race([revoke(), gaveUp]);
    if (outcome === "revoked") log.info("github_grant_revoked", { userId });
    else if (outcome === "no_token") log.info("github_grant_revoke_skipped", { userId });
    else log.warn("github_grant_revoke_failed", { userId, reason: "timeout" });
  } catch (error) {
    // Never the error itself: what GitHub said back is no business of the logs.
    const status = error instanceof UpstreamError ? error.status : undefined;
    log.warn("github_grant_revoke_failed", { userId, status: status ?? null });
  }
}

/** The refusal while the person is the only admin of a workspace others are in. */
function soleAdmin(workspaces: { id: string; name: string }[]): ApiError {
  return new ApiError(409, "sole_admin", "Make someone else an admin first.", {
    details: { workspaces },
  });
}
