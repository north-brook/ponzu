import {
  getRepoAccess,
  listWorkspaceRepoAccess,
  READABLE_PERMISSIONS,
  type RepoPermission,
  recordNoRepoAccess,
  recordReachableRepos,
  recordRepoAccess,
  type User,
  type Workspace,
  type WorkspaceRepoAccess,
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
 *   workspace, and a reader does it for one when any of its answers is more than a minute old.
 * - `repoPermission`: one question as the App about one repo, when there is no fresh answer.
 *
 * Both give the same answer for the same repo: a public repo is `read` to anyone GitHub gives
 * no more. While the App is not installed on a workspace, or is suspended, Ponzu can reach
 * none of its repos for anyone, and the answer is `none`.
 *
 * Every question of "may this person see or steer this repo" reads that table: `requireDesign`
 * (through `repoPermission`), the workspace's repo list, its designs list and the live query
 * over it, and the reviews that reach a design's agent. Each also requires the person's
 * membership of the workspace. Webhooks keep it true between syncs: an access event syncs the
 * person it names, and one that names nobody makes the answers it concerns stale.
 *
 * Ours, not a library's: who may reach what is Ponzu's model, kept in its own database.
 */

/** How long an answer is taken as it is. Someone whose access is taken away loses it within this. */
export const REPO_ACCESS_FRESH_MS = 60_000;
/** How long an answer stands in for GitHub while GitHub fails. Never longer. */
export const REPO_ACCESS_FALLBACK_MS = 10 * 60_000;
/**
 * The most repos one cut-short list has asked about one at a time, as the App. A list is cut
 * short only past 2,000 repos, so this is rarely reached; past it, the rest are asked next time.
 */
const UNLISTED_ASKED_AT_MOST = 20;

type RepoAccessDeps = Pick<Deps, "db" | "github" | "clock">;

/**
 * Someone GitHub may give access to a repo, by their GitHub id (never by a stored login alone:
 * a login can change hands). `id` is their Ponzu id, or null for someone who never signed in,
 * whose answer is not kept.
 */
export type RepoAsker = Pick<User, "githubUserId" | "githubLogin"> & { id: string | null };

/** The App on a workspace, as far as access needs it. */
export type AppInstallation = Pick<Workspace, "installationId" | "suspendedAt">;

/** The installation to ask GitHub through, or null when Ponzu can reach none of its repos. */
const reachable = ({ installationId, suspendedAt }: AppInstallation) =>
  suspendedAt === null ? installationId : null;

/**
 * What `user` may do in `repo`, a repo of a workspace with the App `installation`. A fresh
 * answer from `repo_access` is taken as it is; otherwise GitHub is asked as the App, and the
 * answer kept. While GitHub fails, an answer younger than `REPO_ACCESS_FALLBACK_MS` stands in;
 * past that the failure is thrown. Without the App, or while it is suspended, it is `none`.
 *
 * `known` is the kept answer when the caller read it already (`getDesignAccess` reads it with
 * the design); left out, it is read here.
 */
export async function repoPermission(
  deps: RepoAccessDeps,
  {
    user,
    repo,
    installation,
    known,
  }: {
    user: RepoAsker;
    repo: { id: string; githubRepoId: number; fullName: string };
    installation: AppInstallation;
    known?: { permission: RepoPermission; checkedAt: Date } | null;
  },
): Promise<RepoPermission> {
  const installationId = reachable(installation);
  if (installationId === null) return "none";
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

const canRead = (permission: RepoPermission | null) =>
  permission !== null && (READABLE_PERMISSIONS as readonly string[]).includes(permission);

/**
 * Ask GitHub, with the person's own token, which repos of an installation they reach, and keep
 * the answer for every repo of its workspace: `write` or `read` for those listed and, when
 * GitHub listed them all, `read` for the rest that are public and `none` for the rest that are
 * private. One call however many repos, on their own rate limit. A person who cannot reach the
 * installation at all is given nothing of their own there.
 *
 * A list GitHub cut short says nothing of the repos it left out, so of those whose answer some
 * reader acts on (one that lets them read, or a repo with a design) the oldest are asked about
 * one at a time as the App: no list goes on showing a repo nobody asked about since.
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
    user: User;
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
  const recorded = await recordReachableRepos(deps.db, {
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
  if (!listed.complete) {
    deps.log.warn("github_repositories_cut_short", { workspaceId, listed: listed.items.length });
    const left = (await listWorkspaceRepoAccess(deps.db, { workspaceId, userId: user.id }))
      .filter(
        (repo) =>
          (repo.checkedAt === null || repo.checkedAt < checkedAt) &&
          (repo.hasDesign || canRead(repo.permission)),
      )
      .sort(byDesignThenOldest)
      .slice(0, UNLISTED_ASKED_AT_MOST);
    await Promise.all(
      left.map(({ repoId, githubRepoId, fullName }) =>
        repoPermission(deps, {
          user,
          repo: { id: repoId, githubRepoId, fullName },
          installation: { installationId, suspendedAt: null },
        }),
      ),
    );
  }
  return recorded;
}

/** Repos with a design first, then the answers asked longest ago, never-asked first of all. */
function byDesignThenOldest(a: WorkspaceRepoAccess, b: WorkspaceRepoAccess) {
  return (
    Number(b.hasDesign) - Number(a.hasDesign) ||
    (a.checkedAt?.getTime() ?? -1) - (b.checkedAt?.getTime() ?? -1)
  );
}

/**
 * Bring what `repo_access` says about `user` up to the last minute for every repo of the
 * workspace: what its repo list, its design list and `workspace.designs` join on, before any is
 * answered or a live query renewed. Nothing is asked when every answer is fresh.
 *
 * When GitHub fails it keeps answers younger than the fallback and throws if any is older,
 * since a list cannot be shown without trusting them.
 */
export async function refreshWorkspaceRepoAccess(
  deps: RepoAccessDeps & Pick<Deps, "vault" | "log">,
  {
    user,
    workspace,
  }: { user: User; workspace: Pick<Workspace, "id" | "installationId" | "suspendedAt"> },
): Promise<void> {
  const repos = await listWorkspaceRepoAccess(deps.db, {
    workspaceId: workspace.id,
    userId: user.id,
  });
  const now = deps.clock.now();
  const ages = repos.map(({ checkedAt }) => (checkedAt ? now - checkedAt.getTime() : null));
  if (ages.every((age) => age !== null && age < REPO_ACCESS_FRESH_MS)) return;
  const installationId = reachable(workspace);
  if (installationId === null) {
    // Without the App nobody reaches its repos through Ponzu, as `repoPermission` says too.
    await recordNoRepoAccess(deps.db, {
      workspaceId: workspace.id,
      userId: user.id,
      checkedAt: new Date(now),
    });
    return;
  }
  try {
    await recordReposReachedBy(deps, { user, workspaceId: workspace.id, installationId });
  } catch (error) {
    // A repo never asked about is not in any list at all, so only the answers kept matter.
    const recent = ages.every((age) => age === null || age < REPO_ACCESS_FALLBACK_MS);
    if (recent && error instanceof UpstreamError) return;
    throw error;
  }
}
