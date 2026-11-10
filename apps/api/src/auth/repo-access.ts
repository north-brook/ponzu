import { listDesignRepoAccess, type RepoPermission, recordRepoAccess, type User } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { UpstreamError } from "../http/errors.ts";

/*
 * What a person may do in a repo, as GitHub says it (docs/cloud.md, "Identity and access").
 * Answers are kept in `repo_access`, so every function instance shares them and the live
 * queries can join them. One is taken as it is for a minute, and GitHub is asked again after
 * that; while GitHub cannot answer, the last answer stands for ten.
 */

/** How long an answer is taken as it is. Someone whose access is taken away loses it within this. */
export const REPO_ACCESS_FRESH_MS = 60_000;
/** How long an answer stands in for GitHub while GitHub fails. */
export const REPO_ACCESS_FALLBACK_MS = 10 * 60_000;

type RepoAccessDeps = Pick<Deps, "db" | "github" | "clock">;

/**
 * What `user` may do in `repo`, asked as the App. `known` is the answer kept for them, which
 * `getDesignAccess` reads with the design.
 */
export async function repoPermission(
  deps: RepoAccessDeps,
  {
    user,
    repo,
    installationId,
    known,
  }: {
    user: User;
    repo: { id: string; githubRepoId: number; fullName: string };
    installationId: number;
    known: { permission: RepoPermission; checkedAt: Date } | null;
  },
): Promise<RepoPermission> {
  const now = deps.clock.now();
  const age = known ? now - known.checkedAt.getTime() : Number.POSITIVE_INFINITY;
  if (known && age < REPO_ACCESS_FRESH_MS) return known.permission;
  let permission: RepoPermission;
  try {
    permission = await deps.github.getRepoPermission({
      installationId,
      repository: { id: repo.githubRepoId, fullName: repo.fullName },
      user: { id: user.githubUserId, login: user.githubLogin },
    });
  } catch (error) {
    // GitHub down or out of rate limit for this installation: not a reason to shut everyone out.
    if (known && age < REPO_ACCESS_FALLBACK_MS && error instanceof UpstreamError) {
      return known.permission;
    }
    throw error;
  }
  await recordRepoAccess(deps.db, [
    { userId: user.id, repoId: repo.id, permission, checkedAt: new Date(now) },
  ]);
  return permission;
}

/**
 * Bring what `repo_access` says about `user` up to the last minute, for every repo of the
 * workspace that holds a design: what the design list and `workspace.designs` join on.
 *
 * It asks with the person's own token, which lists every repo of the installation they can
 * reach in one call, on their own rate limit; asking as the App would be one call per repo, on
 * the installation's, for every person with the list open. When GitHub fails it keeps answers
 * younger than the fallback and throws if any is older, since a list cannot be shown without
 * trusting them.
 */
export async function refreshWorkspaceRepoAccess(
  deps: RepoAccessDeps & Pick<Deps, "vault" | "log">,
  { user, workspace }: { user: User; workspace: { id: string; installationId: number | null } },
): Promise<void> {
  const repos = await listDesignRepoAccess(deps.db, { workspaceId: workspace.id, userId: user.id });
  const now = deps.clock.now();
  const ages = repos.map(({ checkedAt }) => (checkedAt ? now - checkedAt.getTime() : null));
  if (ages.every((age) => age !== null && age < REPO_ACCESS_FRESH_MS)) return;
  let reachable: Map<number, RepoPermission>;
  try {
    reachable = await reachableRepos(deps, user, workspace.installationId);
  } catch (error) {
    // A repo never asked about is not in the list at all, so only the answers kept matter.
    const recent = ages.every((age) => age === null || age < REPO_ACCESS_FALLBACK_MS);
    if (recent && error instanceof UpstreamError) return;
    throw error;
  }
  await recordRepoAccess(
    deps.db,
    repos.map(({ repoId, githubRepoId }) => ({
      userId: user.id,
      repoId,
      permission: reachable.get(githubRepoId) ?? "none",
      checkedAt: new Date(now),
    })),
  );
}

/** The repos of an installation a person can reach, by GitHub id, with what they may do there. */
async function reachableRepos(
  deps: RepoAccessDeps & Pick<Deps, "vault" | "log">,
  user: User,
  installationId: number | null,
): Promise<Map<number, RepoPermission>> {
  if (installationId === null) return new Map();
  const token = await githubUserToken(deps, user.id);
  try {
    const repositories = await deps.github.listInstallationRepositories(token, installationId);
    // The list says only whether they can push; for what a design needs, that is the difference.
    return new Map(repositories.map(({ id, canPush }) => [id, canPush ? "write" : "read"]));
  } catch (error) {
    // They cannot reach the installation at all.
    if (error instanceof UpstreamError && error.status === 404) return new Map();
    throw error;
  }
}
