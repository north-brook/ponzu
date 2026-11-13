import {
  getRepoAccess,
  getRepoVisibility,
  getWorkspace,
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
import { ApiError, UpstreamError } from "../http/errors.ts";

/*
 * What a person may do in a repo, as GitHub says it (docs/cloud.md, "Identity and access").
 * There is one place the answer lives, `repo_access`, and two ways GitHub's answers reach it:
 *
 * - `recordReposReachedBy`: one call on the person's own token lists every repo of an
 *   installation GitHub has given them, with whether they can push. Their sync does it for
 *   every workspace, and a reader does it for one when any of its answers is more than a
 *   minute old.
 * - `repoPermission`: one question as the App about one repo, when there is no fresh answer.
 *
 * A `read` in `repo_access` is one GitHub GAVE the person: they own the repo, they are one of
 * its collaborators (directly, as an outside collaborator, or through a team), or they are a
 * member or owner of the organization that owns it. The read anyone has of a public repo is
 * not one: for someone whose only tie to a public repo is that it is public, its canvases do
 * not exist. GitHub's question as the App cannot tell the two apart (it answers `read` on a
 * public repo for anybody), so a `read` from it is settled by the person's own list, which
 * can. Something Ponzu cannot tell is `none`. While the App is not installed on a workspace, or
 * is suspended, Ponzu can reach none of its repos for anyone, and the answer is `none`.
 *
 * Every question of "may this person see or steer this repo" reads that table: `requireCanvas`
 * (through `repoPermission`), the workspace's repo list, its canvases list and the live query
 * over it, and the reviews that reach a canvas's agent. Each also requires the person's
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

/**
 * `vault` and `log` are for asking as the person (their GitHub token is in the vault), which a
 * `read` from GitHub's question as the App needs.
 */
type RepoAccessDeps = Pick<Deps, "db" | "github" | "clock" | "vault" | "log">;

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
 * GitHub's question as the App answers `read` on a public repo for anybody, so a `read` from it
 * says nothing of whether GitHub gave the person the repo. It is settled by the person's own
 * list of the workspace's repos (`recordReposReachedBy`, which also keeps the answer), and is
 * `none` when that cannot be asked: for someone who never signed in (whose answer only ever
 * decides whether they can push), or whose GitHub token GitHub no longer takes.
 *
 * `known` is the kept answer when the caller read it already (`getCanvasAccess` reads it with
 * the canvas); left out, it is read here. `unlisted` is for a repo a cut-short list of the
 * person's left out, which their list cannot settle: a `read` then stands for someone GitHub
 * gives every public repo of the account (`readsPublic`), and otherwise only on a repo GitHub
 * confirms is private now (`givenRead`).
 */
export async function repoPermission(
  deps: RepoAccessDeps,
  {
    user,
    repo,
    installation,
    known,
    unlisted,
  }: {
    user: RepoAsker;
    repo: { id: string; githubRepoId: number; fullName: string };
    installation: AppInstallation;
    known?: { permission: RepoPermission; checkedAt: Date } | null;
    unlisted?: { readsPublic: boolean; private: boolean };
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
  // GitHub down or out of rate limit for this installation: not a reason to shut everyone out.
  const standIn = (error: unknown) => {
    if (kept && age < REPO_ACCESS_FALLBACK_MS && error instanceof UpstreamError) {
      return kept.permission;
    }
    throw error;
  };
  let permission: RepoPermission;
  try {
    permission = await deps.github.getRepoPermission({
      installationId,
      repository: { id: repo.githubRepoId, fullName: repo.fullName },
      user: { id: user.githubUserId, login: user.githubLogin },
    });
  } catch (error) {
    return standIn(error);
  }
  if (permission === "read") {
    if (unlisted) {
      // One of many asked about for a cut-short list: a GitHub failure here is no, not a reason
      // to fail the whole list.
      const given = await givenRead(deps, { ...unlisted, installationId, repo }).catch((error) => {
        deps.log.warn("repo_visibility_unread", { repo: repo.fullName, error: String(error) });
        return false;
      });
      permission = given ? "read" : "none";
    } else if (user.id === null) {
      return "none";
    } else {
      try {
        return await settleRead(deps, {
          user: { ...user, id: user.id },
          repo,
          installationId,
          asked: now,
        });
      } catch (error) {
        return standIn(error);
      }
    }
  }
  if (user.id !== null) {
    await recordRepoAccess(deps.db, [
      { userId: user.id, repoId: repo.id, permission, checkedAt: new Date(now) },
    ]);
  }
  return permission;
}

/**
 * Whether a `read` GitHub's question as the App gave is one GitHub gave the person: their own
 * list of the workspace's repos says, and keeps what it says for every repo of it. When their
 * GitHub token is dead, or their list was cut short before this repo, it is `keepRead`'s to
 * say. `none` too when the repo has left Ponzu.
 */
async function settleRead(
  deps: RepoAccessDeps,
  {
    user,
    repo,
    installationId,
    asked,
  }: {
    user: RepoAsker & { id: string };
    repo: { id: string; githubRepoId: number; fullName: string };
    installationId: number;
    /** When GitHub was asked as the App. */
    asked: number;
  },
): Promise<RepoPermission> {
  const visibility = await getRepoVisibility(deps.db, repo.id);
  if (visibility === null) return "none";
  let reached: Awaited<ReturnType<typeof recordReposReachedBy>>;
  try {
    reached = await recordReposReachedBy(deps, {
      user,
      workspaceId: visibility.workspaceId,
      installationId,
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "github_reauth_required")) throw error;
    // With their token dead, whether they are in the account cannot be asked: no.
    return keepRead(deps, {
      userId: user.id,
      repo,
      installationId,
      private: visibility.private,
      readsPublic: false,
      asked,
    });
  }
  const listed = await getRepoAccess(deps.db, { userId: user.id, repoId: repo.id });
  // A list cut short that left this repo out, and did not get to asking about it, says nothing
  // of it: the answer kept from before is not trusted, whatever it says. Whether they are in the
  // account was asked with that list, and still counts.
  if (!listed || listed.checkedAt.getTime() < asked) {
    return keepRead(deps, {
      userId: user.id,
      repo,
      installationId,
      private: visibility.private,
      readsPublic: reached.readsPublic,
      asked,
    });
  }
  return listed.permission;
}

/**
 * A `read` GitHub's question as the App gave, when the person's own list could not settle it:
 * it stands (and is kept) when `givenRead` says GitHub gave it them, and is `none` otherwise.
 */
async function keepRead(
  deps: RepoAccessDeps,
  {
    userId,
    repo,
    installationId,
    private: isPrivate,
    readsPublic,
    asked,
  }: {
    userId: string;
    repo: { id: string; githubRepoId: number; fullName: string };
    installationId: number;
    private: boolean;
    readsPublic: boolean;
    asked: number;
  },
): Promise<RepoPermission> {
  const permission = (await givenRead(deps, {
    readsPublic,
    private: isPrivate,
    installationId,
    repo,
  }))
    ? "read"
    : "none";
  await recordRepoAccess(deps.db, [
    { userId, repoId: repo.id, permission, checkedAt: new Date(asked) },
  ]);
  return permission;
}

/**
 * Whether a `read` GitHub's question as the App gave is one GitHub gave the person, from what
 * is known without their list: for someone GitHub gives every public repo of the account
 * (`readsPublic`), yes; otherwise only on a repo that is private now, where nobody else is
 * answered `read`. Ponzu's copy may say private for a repo made public a moment ago, whose
 * notice has not reached it (and then GitHub answers `read` for anybody), so a repo kept as
 * private is asked about once more, as the App; an answer that cannot be had is no.
 */
async function givenRead(
  deps: RepoAccessDeps,
  {
    readsPublic,
    private: isPrivate,
    installationId,
    repo,
  }: {
    readsPublic: boolean;
    private: boolean;
    installationId: number;
    repo: { githubRepoId: number; fullName: string };
  },
): Promise<boolean> {
  if (readsPublic) return true;
  if (!isPrivate) return false;
  return privateNow(deps, { installationId, repo });
}

/**
 * Whether GitHub says, now, that a repo is private: asked as the App, with the token its
 * permission question uses (that repo alone, metadata only), by the repo's id. A repo the
 * installation no longer reaches is no. A GitHub failure throws, so a caller's fallback decides:
 * `repoPermission` keeps an answer younger than ten minutes, as it does when its own question
 * fails, and a cut-short list's question about one repo among many answers no.
 */
async function privateNow(
  deps: RepoAccessDeps,
  { installationId, repo }: { installationId: number; repo: { githubRepoId: number } },
): Promise<boolean> {
  return (
    (await deps.github.isRepoPrivate({ installationId, repositoryId: repo.githubRepoId })) === true
  );
}

/** Whether a permission lets its holder steer a canvas: send messages, answer, merge. */
export const canWrite = (permission: RepoPermission) =>
  permission === "admin" || permission === "write";

const canRead = (permission: RepoPermission | null) =>
  permission !== null && (READABLE_PERMISSIONS as readonly string[]).includes(permission);

/**
 * Ask GitHub, with the person's own token, which repos of an installation it has given them,
 * and keep the answer for every repo of its workspace: `write` or `read` for those listed and,
 * when GitHub listed them all, `none` for the rest, except that the public ones are `read` for a
 * member or owner of the organization the workspace is (`readsPublic`). One call however many
 * repos, on their own rate limit, and for an organization one more for their membership of it
 * (`GET /user/memberships/orgs/{org}`: an active membership, public or private; a pending
 * invitation is none). A person who cannot reach the installation at all is given nothing of
 * their own there.
 *
 * A public repo GitHub has not given them is left out of the list: anyone may read it on
 * GitHub, but its canvases are only for the people GitHub gave it to (docs/cloud.md, "Identity
 * and access").
 *
 * A list GitHub cut short says nothing of the repos it left out, so of those whose answer some
 * reader acts on (one that lets them read, or a repo with a canvas) the oldest are asked about
 * one at a time as the App: no list goes on showing a repo nobody asked about since.
 *
 * Answers the listed GitHub ids Ponzu has no repo for, which mean its copy of the installation
 * is behind (`syncGithub` reads it again and calls this once more).
 */
export async function recordReposReachedBy(
  deps: RepoAccessDeps,
  {
    user,
    workspaceId,
    installationId,
    token,
    readsPublic: known,
  }: {
    user: RepoAsker & { id: string };
    workspaceId: string;
    installationId: number;
    /** Their GitHub token, when the caller holds it already. */
    token?: string;
    /**
     * Whether they are the personal account or in the organization the workspace is, when the
     * caller has just asked GitHub (`syncGithub`); left out, GitHub is asked here.
     */
    readsPublic?: boolean;
  },
): Promise<{ missing: number[]; readsPublic: boolean }> {
  const checkedAt = new Date(deps.clock.now());
  const userToken = token ?? (await githubUserToken(deps, user.id));
  let listed: Awaited<ReturnType<Deps["github"]["listInstallationRepositories"]>>;
  let reaches = true;
  try {
    listed = await deps.github.listInstallationRepositories(userToken, installationId);
  } catch (error) {
    // They cannot reach the installation at all.
    if (!(error instanceof UpstreamError && error.status === 404)) throw error;
    listed = { items: [], complete: true };
    reaches = false;
  }
  const readsPublic =
    reaches && (known ?? (await inAccount(deps, { user, workspaceId, token: userToken })));
  const recorded = await recordReachableRepos(deps.db, {
    workspaceId,
    userId: user.id,
    // The list says only whether they can push; for what a canvas needs, that is the difference.
    repos: listed.items.map(({ id, canPush }) => ({
      githubRepoId: id,
      permission: canPush ? "write" : "read",
    })),
    complete: listed.complete,
    readsPublic,
    checkedAt,
  });
  if (!listed.complete) {
    deps.log.warn("github_repositories_cut_short", { workspaceId, listed: listed.items.length });
    const left = (await listWorkspaceRepoAccess(deps.db, { workspaceId, userId: user.id }))
      .filter(
        (repo) =>
          (repo.checkedAt === null || repo.checkedAt < checkedAt) &&
          (repo.hasCanvas || canRead(repo.permission)),
      )
      .sort(byCanvasThenOldest)
      .slice(0, UNLISTED_ASKED_AT_MOST);
    await Promise.all(
      left.map(({ repoId, githubRepoId, fullName, private: isPrivate }) =>
        repoPermission(deps, {
          user,
          repo: { id: repoId, githubRepoId, fullName },
          installation: { installationId, suspendedAt: null },
          unlisted: { readsPublic, private: isPrivate },
        }),
      ),
    );
  }
  return { ...recorded, readsPublic };
}

/**
 * Whether GitHub gives the person every public repo of the workspace's account: it is their own
 * personal account, or they are an active member or owner of the organization (asked on their
 * own token, which sees a private membership too). Anything else, a pending invitation or an
 * organization that does not let the App see its members included, is no.
 */
async function inAccount(
  deps: RepoAccessDeps,
  { user, workspaceId, token }: { user: RepoAsker; workspaceId: string; token: string },
): Promise<boolean> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace) return false;
  if (workspace.githubAccountId === user.githubUserId) return true;
  if (workspace.kind !== "org") return false;
  return (await deps.github.getOrgRole(token, workspace.githubLogin)) !== null;
}

/** Repos with a canvas first, then the answers asked longest ago, never-asked first of all. */
function byCanvasThenOldest(a: WorkspaceRepoAccess, b: WorkspaceRepoAccess) {
  return (
    Number(b.hasCanvas) - Number(a.hasCanvas) ||
    (a.checkedAt?.getTime() ?? -1) - (b.checkedAt?.getTime() ?? -1)
  );
}

/**
 * Bring what `repo_access` says about `user` up to the last minute for every repo of the
 * workspace: what its repo list, its canvas list and `workspace.canvases` join on, before any is
 * answered or a live query renewed. Nothing is asked when every answer is fresh.
 *
 * When GitHub fails it keeps answers younger than the fallback and throws if any is older,
 * since a list cannot be shown without trusting them.
 */
export async function refreshWorkspaceRepoAccess(
  deps: RepoAccessDeps,
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
