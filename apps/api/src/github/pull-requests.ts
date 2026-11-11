import {
  appendEvent,
  type BranchDesign,
  findDesignByBranch,
  getUserByGithubId,
  type Json,
  listDesignsWithOpenPullRequests,
} from "@ponzu/db";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import { type PullRequestDeps, refreshPullRequest } from "../pull-requests/sync.ts";

/*
 * What GitHub says about a design's pull request. A design owns one branch of its repo
 * (`pz/<topic>`), and a pull request, check or review belongs to it when it is about that
 * branch, in that repo. One from a fork never is, whatever its branch is called.
 */

/** A pull request as a webhook names it. */
export interface PullRequestRef {
  number: number;
  /** The branch it merges from, and the repo that branch is in (null once a fork is deleted). */
  head: { ref: string; repo: { id: number } | null };
}

/**
 * Read again, as the App, the pull requests a delivery is about, for each design that owns one's
 * branch, and record them (`refreshPullRequest`). A delivery says what was true when it was
 * sent, and GitHub sends them late and out of order, so what is recorded is GitHub's word now,
 * never the payload's. With `untilMergeable`, each is read again for a few seconds while GitHub
 * works out whether it can merge, as it does after a push or a change of its base.
 */
export async function refreshDesigns(
  deps: PullRequestDeps,
  {
    githubRepoId,
    pullRequests,
    untilMergeable = false,
  }: { githubRepoId: number; pullRequests: PullRequestRef[]; untilMergeable?: boolean },
): Promise<void> {
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  for (const [branch, pullRequest] of branches) {
    const design = await findDesignByBranch(deps.db, { githubRepoId, branch });
    if (!design) continue;
    await refreshPullRequest(deps, design.id, { number: pullRequest.number, untilMergeable });
  }
}

/**
 * A push. To a design's branch: its pull request is read again until GitHub shows it at the
 * pushed commit and knows whether it can merge. To the branch pull requests merge into: every
 * open one of the repo's designs is read again, since the push may have given it conflicts.
 */
export async function refreshAfterPush(
  deps: PullRequestDeps,
  {
    githubRepoId,
    branch,
    after,
    defaultBranch,
  }: { githubRepoId: number; branch: string; after: string | null; defaultBranch: string },
): Promise<void> {
  if (branch === defaultBranch) {
    for (const designId of await listDesignsWithOpenPullRequests(deps.db, githubRepoId)) {
      await refreshPullRequest(deps, designId, { untilMergeable: true });
    }
    return;
  }
  const design = await findDesignByBranch(deps.db, { githubRepoId, branch });
  if (!design) return;
  await refreshPullRequest(deps, design.id, {
    ...(after ? { headSha: after } : {}),
    untilMergeable: true,
  });
}

/** Someone on GitHub who wrote something a design's agent would read, by their GitHub id. */
export interface GithubAuthor {
  githubUserId: number;
  login: string;
}

/**
 * Tell the agent of each design these pull requests belong to: an event with priority `next`,
 * taken up after its current step (docs/cloud.md, "Events"). A settled design hears nothing.
 *
 * With an `author` (a review), a design hears it only when GitHub says the author can push to
 * its repo, asked through `repoPermission` like every other access question: anyone can review
 * a pull request on a public repo, and the agent reads what they wrote. The event names them
 * as a Ponzu person when they are one.
 */
export async function tellDesigns(
  deps: Pick<Deps, "db" | "github" | "clock" | "log">,
  {
    githubRepoId,
    pullRequests,
    kind,
    payload,
    author,
  }: {
    githubRepoId: number;
    pullRequests: PullRequestRef[];
    kind: "check" | "review";
    payload: (pullRequest: PullRequestRef) => Json;
    author?: GithubAuthor;
  },
): Promise<void> {
  const { db, log } = deps;
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  const person = author ? await getUserByGithubId(db, author.githubUserId) : null;
  for (const [branch, pullRequest] of branches) {
    const design = await findDesignByBranch(db, { githubRepoId, branch });
    if (design?.status !== "active") continue;
    if (author && !(await canPushTo(deps, design, author, person?.id ?? null))) {
      log.info("design_event_dropped", { designId: design.id, kind, reason: "no_write_access" });
      continue;
    }
    await appendEvent(db, {
      designId: design.id,
      kind,
      priority: "next",
      payload: payload(pullRequest),
      userId: person?.id ?? null,
    });
    log.info("design_event_appended", { designId: design.id, kind });
  }
}

/** Whether GitHub says `author` can push to the design's repo. */
async function canPushTo(
  deps: Pick<Deps, "db" | "github" | "clock">,
  design: BranchDesign,
  author: GithubAuthor,
  userId: string | null,
): Promise<boolean> {
  // Without the App, or while it is suspended, nobody can: there is nobody to ask.
  const permission = await repoPermission(deps, {
    user: { id: userId, githubUserId: author.githubUserId, githubLogin: author.login },
    repo: design.repo,
    installation: design,
  });
  return canWrite(permission);
}
