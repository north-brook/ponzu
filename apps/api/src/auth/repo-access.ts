import {
  getRepoAccess,
  listDesignRepoAccess,
  type RepoPermission,
  recordReachableRepos,
  recordRepoAccess,
  type User,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { UpstreamError } from "../http/errors.ts";

/*
 * What a person may do in a repo, as GitHub says it (docs/cloud.md, "Identity and access").
 * There is one place the answer lives, `repo_access`, and two ways GitHub's answers reach it:
 *
 * - `recordReposReachedBy`: one call on the person's own token lists every repo of an
 *   installation they reach, with whether they can push. Their sync does it for every
 *   workspace, and a list does it for one when its answers are more than a minute old.
 * - `repoPermission`: one question as the App about one repo, when there is no fresh answer.
 *
 * Every question of "may this person see or steer this repo" reads that table: `requireDesign`
 * (through `repoPermission`), the workspace's repo list, its designs list and the live query
 * over it, and the reviews that reach a design's agent. Each also requires the person's
 * membership of the workspace. Webhooks keep it true between syncs: an access event syncs the
 * person it names, and one that names nobody makes the answers it concerns stale.
 */

/** How long an answer is taken as it is. Someone whose access is taken away loses it within this. */
export const REPO_ACCESS_FRESH_MS = 60_000;
/** How long an answer stands in for GitHub while GitHub fails. Never longer. */
export const REPO_ACCESS_FALLBACK_MS = 10 * 60_000;

type RepoAccessDeps = Pick<Deps, "db" | "github" | "clock">;

/**
 * Someone GitHub may give access to a repo, by their GitHub id (never by a stored login alone:
 * a login can change hands). `id` is their Ponzu id, or null for someone who never signed in,
 * whose answer is not kept.
 */
export type RepoAsker = Pick<User, "githubUserId" | "githubLogin"> & { id: string | null };

/**
 * What `user` may do in `repo`. A fresh answer from `repo_access` is taken as it is; otherwise
 * GitHub is asked as the App, and the answer kept. While GitHub fails, an answer younger than
 * `REPO_ACCESS_FALLBACK_MS` stands in; past that the failure is thrown.
 *
 * `known` is the kept answer when the caller read it already (`getDesignAccess` reads it with
 * the design); left out, it is read here.
 */
export async function repoPermission(
  deps: RepoAccessDeps,
  {
    user,
    repo,
    installationId,
    known,
  }: {
    user: RepoAsker;
    repo: { id: string; githubRepoId: number; fullName: string };
    installationId: number;
    known?: { permission: RepoPermission; checkedAt: Date } | null;
  },
): Promise<RepoPermission> {
  const kept =
    known !== undefined
      ? known
      : user.id === null
        ? null
        : await getRepoAccess(deps.db, { userId: user.id, repoId: repo.id });
  const now = deps.clock.now();
  const age = kept ? now - kept.checkedAt.getTime() : Number.POSITIVE_INFINITY;
  if (kept && age < REPO_ACCESS_FRESH_MS) return kept.permission;
  let permission: RepoPermission;
  try {
    permission = await deps.github.getRepoPermission({
      installationId,
      repository: { id: repo.githubRepoId, fullName: repo.fullName },
      user: { id: user.githubUserId, login: user.githubLogin },
    });
  } catch (error) {
    // GitHub down or out of rate limit for this installation: not a reason to shut everyone out.
    if (kept && age < REPO_ACCESS_FALLBACK_MS && error instanceof UpstreamError) {
      return kept.permission;
    }
    throw error;
  }
  if (user.id !== null) {
    await recordRepoAccess(deps.db, [
      { userId: user.id, repoId: repo.id, permission, checkedAt: new Date(now) },
    ]);
  }
  return permission;
}

/** Whether a permission lets its holder steer a design: send messages, answer, merge. */
export const canWrite = (permission: RepoPermission) =>
  permission === "admin" || permission === "write";

/**
 * Ask GitHub, with the person's own token, which repos of an installation they reach, and keep
 * the answer for every repo of its workspace: `write` or `read` for those listed, `none` for the
 * rest when GitHub listed them all. One call however many repos, on their own rate limit. A
 * person who cannot reach the installation at all reaches none of it.
 *
 * Answers the listed GitHub ids Ponzu has no repo for, which mean its copy of the installation
 * is behind (`syncGithub` reads it again and calls this once more).
 */
export async function recordReposReachedBy(
  deps: RepoAccessDeps & Pick<Deps, "vault" | "log">,
  {
    user,
    workspaceId,
    installationId,
    token,
  }: {
    user: Pick<User, "id">;
    workspaceId: string;
    installationId: number;
    /** Their GitHub token, when the caller holds it already. */
    token?: string;
  },
): Promise<{ missing: number[] }> {
  const checkedAt = new Date(deps.clock.now());
  const userToken = token ?? (await githubUserToken(deps, user.id));
  let listed: Awaited<ReturnType<Deps["github"]["listInstallationRepositories"]>>;
  try {
    listed = await deps.github.listInstallationRepositories(userToken, installationId);
  } catch (error) {
    // They cannot reach the installation at all.
    if (!(error instanceof UpstreamError && error.status === 404)) throw error;
    listed = { items: [], complete: true };
  }
  return recordReachableRepos(deps.db, {
    workspaceId,
    userId: user.id,
    // The list says only whether they can push; for what a design needs, that is the difference.
    repos: listed.items.map(({ id, canPush }) => ({
      githubRepoId: id,
      permission: canPush ? "write" : "read",
    })),
    complete: listed.complete,
    checkedAt,
  });
}

/**
 * Bring what `repo_access` says about `user` up to the last minute, for every repo of the
 * workspace that holds a design: what the design list and `workspace.designs` join on, before
 * either is answered or a live query renewed. Nothing is asked when every answer is fresh.
 *
 * When GitHub fails it keeps answers younger than the fallback and throws if any is older,
 * since a list cannot be shown without trusting them.
 */
export async function refreshWorkspaceRepoAccess(
  deps: RepoAccessDeps & Pick<Deps, "vault" | "log">,
  { user, workspace }: { user: User; workspace: { id: string; installationId: number | null } },
): Promise<void> {
  const repos = await listDesignRepoAccess(deps.db, { workspaceId: workspace.id, userId: user.id });
  const now = deps.clock.now();
  const ages = repos.map(({ checkedAt }) => (checkedAt ? now - checkedAt.getTime() : null));
  if (ages.every((age) => age !== null && age < REPO_ACCESS_FRESH_MS)) return;
  if (workspace.installationId === null) {
    // Without the App nobody reaches its repos through Ponzu, as `requireDesign` says too.
    await recordReachableRepos(deps.db, {
      workspaceId: workspace.id,
      userId: user.id,
      repos: [],
      complete: true,
      checkedAt: new Date(now),
    });
    return;
  }
  try {
    await recordReposReachedBy(deps, {
      user,
      workspaceId: workspace.id,
      installationId: workspace.installationId,
    });
  } catch (error) {
    // A repo never asked about is not in the list at all, so only the answers kept matter.
    const recent = ages.every((age) => age === null || age < REPO_ACCESS_FALLBACK_MS);
    if (recent && error instanceof UpstreamError) return;
    throw error;
  }
}
