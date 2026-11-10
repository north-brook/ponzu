import {
  deleteMembershipsExcept,
  getUser,
  getUserByGithubId,
  listUserWorkspaces,
  type MemberRole,
  type User,
  upsertMembership,
  type Workspace,
  workspaceHasAdmin,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { reconcileInstallation } from "./installations.ts";
import { githubUserToken } from "./user-token.ts";

/*
 * Keeping Ponzu's picture of one person's GitHub true. A person's workspaces are the
 * installations of the App their own GitHub token reaches (`GET /user/installations`); Ponzu
 * adds only a role. See "Identity and access" in docs/cloud.md.
 *
 * It runs after each sign-in, when an app asks (it came back from GitHub), and when a webhook
 * says the person's access changed. It is safe to run twice at once and to run again after it
 * failed partway: every step is an upsert or a reconciliation against what GitHub says now,
 * and memberships are dropped only once every installation the person reaches is accounted for.
 */

type SyncDeps = Pick<Deps, "db" | "clock" | "vault" | "github" | "log">;

/**
 * Bring the database in line with what `userId`'s GitHub token reaches, and answer the
 * workspaces they are now a member of. Throws `github_reauth_required` when GitHub no longer
 * takes their token.
 *
 * Each installation they reach is reconciled as the App (its workspace and every repo it can
 * see, not only the ones this person can), they are made a member of each, and their
 * membership of any workspace they no longer reach is dropped. A role is decided only when
 * someone joins (`defaultRole`); one an admin set in Ponzu is never changed here.
 */
export async function syncGithub(deps: SyncDeps, userId: string): Promise<Workspace[]> {
  const { db, github, log } = deps;
  const user = await getUser(db, userId);
  if (!user) return [];
  const token = await githubUserToken(deps, userId);
  const [installations, memberOf] = await Promise.all([
    github.listInstallations(token),
    listUserWorkspaces(db, userId),
  ]);
  const member = new Set(memberOf.map((workspace) => workspace.id));

  const results = await Promise.allSettled(
    installations.map(async ({ id }) => {
      const workspace = await reconcileInstallation(deps, id);
      if (!workspace) return null;
      // The role is used only for someone new; for an existing member it is ignored.
      const role = member.has(workspace.id)
        ? "member"
        : await defaultRole(deps, { user, token, workspace });
      await upsertMembership(db, { workspaceId: workspace.id, userId, role });
      return workspace;
    }),
  );

  const failed = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ installationId: installations[index]!.id, error: result.reason }]
      : [],
  );
  if (failed.length > 0) {
    for (const failure of failed) log.warn("github_installation_sync_failed", failure);
    // Without every installation's workspace, there is no telling which memberships are stale.
    throw failed[0]!.error;
  }

  const workspaces = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  await deleteMembershipsExcept(db, {
    userId,
    workspaceIds: workspaces.map((workspace) => workspace.id),
  });
  return workspaces;
}

/**
 * The role someone joining a workspace starts with. Admin: whoever installed the App, the
 * owner of a personal account, an organization's owners, and the first person into a
 * workspace that has no admin, so that none is ever without one. Everyone else is a member.
 */
async function defaultRole(
  { db, github }: SyncDeps,
  { user, token, workspace }: { user: User; token: string; workspace: Workspace },
): Promise<MemberRole> {
  if (workspace.installedByUserId === user.id) return "admin";
  if (workspace.githubAccountId === user.githubUserId) return "admin";
  if (workspace.kind === "org") {
    if ((await github.getOrgRole(token, workspace.githubLogin)) === "admin") return "admin";
  }
  return (await workspaceHasAdmin(db, workspace.id)) ? "member" : "admin";
}

/**
 * Sync the person behind a GitHub account, if they have signed in to Ponzu: what a webhook
 * does when it says someone's access changed. Someone whose GitHub token is dead is left
 * alone; they will sync when they sign in again.
 */
export async function resyncGithubUser(deps: SyncDeps, githubUserId: number): Promise<void> {
  const user = await getUserByGithubId(deps.db, githubUserId);
  if (!user) return;
  try {
    await syncGithub(deps, user.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "github_reauth_required") {
      deps.log.info("github_sync_skipped", { userId: user.id, reason: error.code });
      return;
    }
    throw error;
  }
}
