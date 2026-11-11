import {
  appendEvent,
  type BranchDesign,
  findDesignByBranch,
  getUserByGithubId,
  type Json,
  type PrState,
  recordPullRequest,
} from "@ponzu/db";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";

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

/** What the pull request is now, from its object in any `pull_request` event. */
export function pullRequestState(pr: { state: string; draft: boolean; merged?: boolean | null }) {
  const state: PrState = pr.merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : pr.draft
        ? "draft"
        : "open";
  return state;
}

/**
 * Record a pull request's state on the design that owns its branch. A merge settles the
 * design. Older news than what is recorded changes nothing (see `recordPullRequest`).
 */
export async function recordPullRequestEvent(
  { db, log }: Pick<Deps, "db" | "log">,
  {
    githubRepoId,
    pullRequest,
  }: {
    githubRepoId: number;
    pullRequest: PullRequestRef & {
      state: string;
      draft: boolean;
      merged?: boolean | null;
      updatedAt: Date;
    };
  },
): Promise<void> {
  if (pullRequest.head.repo?.id !== githubRepoId) return;
  const state = pullRequestState(pullRequest);
  const designId = await recordPullRequest(db, {
    githubRepoId,
    branch: pullRequest.head.ref,
    number: pullRequest.number,
    state,
    updatedAt: pullRequest.updatedAt,
  });
  if (designId) log.info("pull_request_recorded", { designId, state });
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
