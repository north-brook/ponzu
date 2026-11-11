import {
  appendThreadItemOnce,
  type Design,
  getPullRequestContext,
  type PullRequestContext,
  recordPullRequestRead,
} from "@ponzu/db";
import type {
  GithubPullRequest,
  GithubPullRequestRead,
  PullRequestRepo,
} from "../deps/github-pull-requests.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * Keeping a design's row in step with its pull request on GitHub. Every path that learns
 * something about one (the tab being opened, an action taken, a webhook) reads GitHub as the
 * App and hands what it read to `recordRead`, the one place the row and the thread hear of it:
 * a merge settles the design there whichever path saw it first.
 */

export type PullRequestDeps = Pick<Deps, "db" | "github" | "clock" | "log" | "analytics">;

/** A design whose branch GitHub can be asked about, as the App. */
export interface PullRequestTarget {
  designId: string;
  repo: PullRequestRepo;
  branch: string;
  defaultBranch: string;
  /** The pull request the row last recorded. */
  number: number | null;
}

/** What asking GitHub about a design's pull request takes, or why it cannot be asked. */
export function targetOf(context: PullRequestContext): PullRequestTarget | ApiError {
  const { design, repo, installationId, suspendedAt } = context;
  if (!repo) {
    return new ApiError(
      409,
      "no_repository",
      "A Scratch design has no repo to open a pull request in.",
    );
  }
  if (installationId === null || suspendedAt !== null) {
    return new ApiError(403, "forbidden", "Ponzu cannot reach this repository on GitHub now.");
  }
  if (!design.branch) {
    return new ApiError(409, "branch_not_pushed", "Nothing has been pushed for this design yet.");
  }
  return {
    designId: design.id,
    repo: { installationId, repository: { id: repo.githubRepoId, fullName: repo.fullName } },
    branch: design.branch,
    defaultBranch: repo.defaultBranch,
    number: design.prNumber,
  };
}

/** What a read found, and when it began. */
export interface Read {
  read: GithubPullRequestRead;
  readAt: Date;
}

/**
 * Read the design's branch and its pull request: the one `number` names, or, when GitHub has a
 * newer one from the branch, that one. Only a pull request from the design's branch in its own
 * repo (never a fork's of the same name) into the default branch is the design's: one someone
 * pointed at another base merges nothing into the default branch, so it neither shows here nor
 * settles the design.
 */
export async function readPullRequest(
  { github, clock }: Pick<Deps, "github" | "clock">,
  target: PullRequestTarget,
  number: number | null = target.number,
): Promise<Read> {
  const ask = async (asked: number | null): Promise<Read> => {
    const readAt = new Date(clock.now());
    const read = await github.readPullRequest(target.repo, {
      branch: target.branch,
      defaultBranch: target.defaultBranch,
      number: asked,
    });
    const pr = read.pullRequest;
    const ours =
      pr?.head.repositoryId === target.repo.repository.id &&
      pr.head.ref === target.branch &&
      pr.base.ref === target.defaultBranch;
    return { read: { ...read, pullRequest: ours ? pr : null }, readAt };
  };
  const first = await ask(number);
  const { newest } = first.read;
  if (newest !== null && newest > (first.read.pullRequest?.number ?? 0)) return ask(newest);
  return first;
}

/** Whether a pull request is still open (a draft is). */
export function isOpen(pullRequest: GithubPullRequest | null): pullRequest is GithubPullRequest {
  return pullRequest?.state === "open" || pullRequest?.state === "draft";
}

/**
 * Whether a read shows an open pull request at an older commit than its branch: GitHub's pull
 * request lags a push by a second or so, and until it catches up its checks and mergeability
 * are those of a commit nobody is looking at any more.
 */
export function lagsBranch({ pullRequest, branch }: GithubPullRequestRead): boolean {
  return isOpen(pullRequest) && branch !== null && pullRequest.head.sha !== branch.sha;
}

/**
 * Record what a read found (`recordRead`), unless it lags the branch: the push that moved the
 * branch makes a webhook, and its read records the pull request at the new commit. `lagging`
 * records it all the same, for the last read there will be.
 */
export async function recordCurrent(
  deps: Pick<Deps, "db" | "log" | "analytics">,
  designId: string,
  { read, readAt }: Read,
  { lagging = false } = {},
): Promise<void> {
  if (!read.pullRequest || (lagsBranch(read) && !lagging)) return;
  await recordRead(deps, designId, read.pullRequest, readAt);
}

/**
 * Record what a read found on the design's row, and in its thread the first time the pull
 * request is seen open, merged or closed. Answers the design as it now stands, or null when it
 * was not applied: a read that began later was recorded first, or the row already says this.
 */
export async function recordRead(
  { db, log, analytics }: Pick<Deps, "db" | "log" | "analytics">,
  designId: string,
  pullRequest: GithubPullRequest,
  readAt: Date,
): Promise<Design | null> {
  const { number, state, url, title } = pullRequest;
  const design = await recordPullRequestRead(db, {
    designId,
    number,
    state,
    checks: pullRequest.checks.state,
    mergeable: pullRequest.mergeable,
    autoMerge: pullRequest.autoMerge !== null,
    updatedAt: pullRequest.updatedAt,
    readAt,
  });
  if (!design) return null;
  const firstSeen = await appendThreadItemOnce(db, {
    id: noticeId(number, state),
    designId,
    kind: "notice",
    payload: { type: "pull_request", number, url, title, state },
  });
  // The notice is written once for each moment, whichever of a route and a webhook sees it
  // first, so the moment is captured once with it: by the person who did it, through Ponzu.
  if (firstSeen) {
    const event =
      state === "merged"
        ? "pull request merged"
        : state === "closed"
          ? "pull request closed"
          : "pull request created";
    analytics.capture(event, { design_id: designId, number }, { workspaceId: design.workspaceId });
  }
  log.info("pull_request_recorded", { designId, number, state });
  return design;
}

/**
 * The id of the notice for a pull request reaching a state, the same every time, so that a
 * route and a webhook that both see it write one notice. A runner's ids are `ti_` and sixteen
 * letters and digits, so no runner can take this one first.
 */
export function noticeId(number: number, state: GithubPullRequest["state"]): string {
  const moment = state === "draft" || state === "open" ? "opened" : state;
  return `ti_pr-${number}-${moment}`;
}

/** The waits between reads while GitHub catches up: about ten seconds in all. */
const CATCH_UP_MS = [1_000, 2_000, 3_000, 4_000];

/**
 * Read a design's pull request from GitHub and record it. Nothing happens for a design that is
 * gone, Scratch, or not on GitHub. While an open one lags its branch, or GitHub is still working
 * out whether it can merge (as it does for seconds after a push or a change of base), it is read
 * again; a read that lags is not recorded unless it is the last.
 */
export async function refreshPullRequest(
  deps: PullRequestDeps,
  designId: string,
  { number = null }: { number?: number | null } = {},
): Promise<void> {
  const context = await getPullRequestContext(deps.db, designId);
  if (!context) return;
  const target = targetOf(context);
  if (target instanceof ApiError) return;
  let asked = number ?? target.number;
  for (let attempt = 0; ; attempt++) {
    const found = await readPullRequest(deps, target, asked);
    const { pullRequest } = found.read;
    const wait = CATCH_UP_MS[attempt];
    await recordCurrent(deps, designId, found, { lagging: wait === undefined });
    const working = isOpen(pullRequest) && pullRequest.mergeable === null;
    if (!(lagsBranch(found.read) || working) || wait === undefined) return;
    asked = pullRequest?.number ?? asked;
    await deps.clock.sleep(wait);
  }
}
