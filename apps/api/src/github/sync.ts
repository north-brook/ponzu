import {
  deleteMembershipsExcept,
  ensureWorkspaceAdmin,
  type GithubAccess,
  getUser,
  getUserByGithubId,
  getWorkspaceByInstallation,
  listWorkspaceMembers,
  markRepoAccessStale,
  removeMembership,
  type User,
  upsertMembership,
  type Workspace,
} from "@ponzu/db";
import { recordReposReachedBy } from "../auth/repo-access.ts";
import { keepAllowances } from "../billing/allowances.ts";
import type { Github, GithubUserInstallation } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { reconcileInstallation } from "./installations.ts";
import { githubUserToken } from "./user-token.ts";

/*
 * Keeping Ponzu's picture of one person's GitHub true. A person's workspaces are the
 * installations of the App their own GitHub token reaches (`GET /user/installations`), and in
 * each, the repos it shows them (`GET /user/installations/{id}/repositories`), kept in
 * `repo_access` with what they may do there, which every access question reads; Ponzu adds only
 * a role. See "Identity and access" in docs/cloud.md.
 *
 * It runs after each sign-in, when an app asks (it came back to focus), and when a webhook
 * says the person's access changed. It is safe to run twice at once and to run again after it
 * failed partway: every step is an upsert or a reconciliation against what GitHub says now,
 * and memberships are dropped only once every installation the person reaches is accounted for.
 *
 * It asks GitHub as the person, which counts against their own rate limit. The installation
 * itself is read as the App (`reconcileInstallation`) only when Ponzu's copy of it is older
 * than `RECONCILE_AFTER_MS` or disagrees with what the person's token shows: those reads come
 * out of the installation's budget, which its git and permission checks share.
 */

type SyncDeps = Pick<Deps, "db" | "clock" | "vault" | "github" | "log" | "analytics">;

/** How old Ponzu's copy of an installation may be before a person's sync reads it again. */
const RECONCILE_AFTER_MS = 10 * 60_000;
/** How many people a webhook about a whole workspace syncs at a time. */
const RESYNC_BATCH = 10;

/**
 * Bring the database in line with what `userId`'s GitHub token reaches, and answer the
 * workspaces they are now a member of. Throws `github_reauth_required` when GitHub no longer
 * takes their token.
 *
 * They are made a member of each installation's workspace, with the repos in it they reach,
 * and their membership of any workspace they no longer reach is dropped, except their own
 * account's. A role is decided when someone joins; a role an admin set in Ponzu is never
 * changed here, except that an owner of the account is always an admin.
 */
export async function syncGithub(deps: SyncDeps, userId: string): Promise<Workspace[]> {
  const { db, github, log } = deps;
  const user = await getUser(db, userId);
  if (!user) return [];
  const token = await githubUserToken(deps, userId);
  const installations = await github.listInstallations(token);

  const results = await Promise.allSettled(
    installations.items.map((installation) =>
      joinInstallation(deps, { user, token, installation }),
    ),
  );
  const failed = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ installationId: installations.items[index]!.id, error: result.reason }]
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

  if (!installations.complete) {
    log.warn("github_installations_cut_short", { userId, listed: installations.items.length });
    return workspaces;
  }
  const left = await deleteMembershipsExcept(db, {
    userId,
    workspaceIds: workspaces.map((workspace) => workspace.id),
  });
  for (const workspaceId of left) {
    await ensureWorkspaceAdmin(db, workspaceId);
    await keepAllowances(deps, workspaceId, [userId]);
  }
  return workspaces;
}

/**
 * One installation the person's token lists: its workspace as Ponzu has it (read again as the
 * App when that copy is behind), their membership of it, and the repos of it they reach.
 * Null when the installation turns out to be gone, or suspended before Ponzu ever saw it.
 */
async function joinInstallation(
  deps: SyncDeps,
  {
    user,
    token,
    installation,
  }: { user: User; token: string; installation: GithubUserInstallation },
): Promise<Workspace | null> {
  const { db, clock, github } = deps;
  const known = await getWorkspaceByInstallation(db, installation.id);
  const reconciled = !known || isBehind(known, installation, clock.now());
  const workspace = reconciled ? await reconcileInstallation(deps, installation.id) : known;
  if (!workspace) return null;

  const githubAccess = await accessOf(github, { user, token, installation });
  await upsertMembership(db, {
    workspaceId: workspace.id,
    userId: user.id,
    githubAccess,
    role: githubAccess === "owner" || workspace.installedByUserId === user.id ? "admin" : "member",
  });

  // GitHub lists none of a suspended installation's repos; theirs stay as last seen.
  if (!workspace.suspendedAt) {
    // What they may do in each repo of it, kept where every access question reads it.
    const record = () =>
      recordReposReachedBy(deps, {
        user,
        workspaceId: workspace.id,
        installationId: installation.id,
        token,
      });
    const { missing } = await record();
    // They reach a repo Ponzu has not recorded: its copy of the installation is behind.
    if (missing.length > 0 && !reconciled) {
      if (!(await reconcileInstallation(deps, installation.id))) return null;
      await record();
    }
  }

  await ensureWorkspaceAdmin(db, workspace.id);
  return workspace;
}

/** Whether Ponzu's copy of an installation is too old, or says other than the person's token. */
function isBehind(workspace: Workspace, installation: GithubUserInstallation, now: number) {
  return (
    workspace.reconciledAt === null ||
    now - workspace.reconciledAt.getTime() >= RECONCILE_AFTER_MS ||
    (workspace.suspendedAt === null) !== (installation.suspendedAt === null)
  );
}

/**
 * How the person reaches an installation's account: they are it, they own the organization,
 * they are in it, or (GitHub shows them no membership of it) only some repos are shared with
 * them. The account's login is taken from the token's own listing, so a rename does not hide
 * an owner.
 */
async function accessOf(
  github: Github,
  {
    user,
    token,
    installation,
  }: { user: User; token: string; installation: GithubUserInstallation },
): Promise<GithubAccess> {
  const { account } = installation;
  if (account.id === user.githubUserId) return "owner";
  if (account.type !== "Organization") return "collaborator";
  const role = await github.getOrgRole(token, account.login);
  return role === "admin" ? "owner" : role === "member" ? "member" : "collaborator";
}

/**
 * Sync the person behind a GitHub account, if they have signed in to Ponzu: what a webhook
 * does when it says someone's access changed.
 *
 * When their GitHub token is dead, Ponzu cannot ask what they still reach, and they sync
 * when they sign in again. Until then, a webhook that says they lost access to an
 * installation (`lostAccessTo`) is taken at its word: they leave that workspace now.
 */
export async function resyncGithubUser(
  deps: SyncDeps,
  githubUserId: number,
  { lostAccessTo }: { lostAccessTo?: number } = {},
): Promise<void> {
  const user = await getUserByGithubId(deps.db, githubUserId);
  if (user) await resync(deps, user.id, { lostAccessTo });
}

/**
 * Sync everyone in an installation's workspace: what a webhook does when access changed for
 * people it does not name (a team gained or lost a repo). Someone who gained access and is not
 * a member yet joins at their own next sync.
 */
export async function resyncWorkspaceMembers(deps: SyncDeps, installationId: number) {
  const workspace = await getWorkspaceByInstallation(deps.db, installationId);
  if (!workspace) return;
  // At once, for everyone: until each person's sync below lands, nothing kept about the
  // workspace's repos is taken as fresh.
  await markRepoAccessStale(deps.db, { workspaceId: workspace.id });
  const members = await listWorkspaceMembers(deps.db, workspace.id);
  for (let start = 0; start < members.length; start += RESYNC_BATCH) {
    const batch = members.slice(start, start + RESYNC_BATCH);
    const results = await Promise.allSettled(batch.map(({ userId }) => resync(deps, userId)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

async function resync(
  deps: SyncDeps,
  userId: string,
  { lostAccessTo }: { lostAccessTo?: number } = {},
): Promise<void> {
  try {
    await syncGithub(deps, userId);
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "github_reauth_required")) throw error;
    deps.log.info("github_sync_skipped", { userId, reason: error.code });
    // Their access changed and their token cannot say how: what is kept about them is asked
    // of GitHub, as the App, before it is trusted again.
    await markRepoAccessStale(deps.db, { userId });
    if (lostAccessTo === undefined) return;
    const workspaceId = await removeMembership(deps.db, { installationId: lostAccessTo, userId });
    if (workspaceId) {
      await ensureWorkspaceAdmin(deps.db, workspaceId);
      await keepAllowances(deps, workspaceId, [userId]);
    }
  }
}
