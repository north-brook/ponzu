import {
  appendThreadItem,
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

export type PullRequestDeps = Pick<Deps, "db" | "github" | "clock" | "log">;

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
 * newer one from the branch, that one. A pull request whose branch is in a fork is never the
 * design's, whatever its branch is called.
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
    const ours = read.pullRequest?.head.repositoryId === target.repo.repository.id;
    return { read: { ...read, pullRequest: ours ? read.pullRequest : null }, readAt };
  };
  const first = await ask(number);
  const { newest } = first.read;
  if (newest !== null && newest > (first.read.pullRequest?.number ?? 0)) return ask(newest);
  return first;
}

/**
 * Record what a read found on the design's row, and in its thread the first time the pull
 * request is seen open, merged or closed. Answers the design as it now stands, or null when a
 * read that began later was recorded first.
 */
export async function recordRead(
  { db, log }: Pick<Deps, "db" | "log">,
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
  await appendThreadItem(db, {
    id: noticeId(number, state),
    designId,
    kind: "notice",
    payload: { type: "pull_request", number, url, title, state },
  });
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
 * gone, Scratch, or not on GitHub. With `headSha` (a push), it reads again while GitHub still
 * shows the pull request at an older commit; with `untilMergeable`, while GitHub still works
 * out whether an open one can merge. Each read is recorded as it comes.
 */
export async function refreshPullRequest(
  deps: PullRequestDeps,
  designId: string,
  {
    number = null,
    headSha,
    untilMergeable = false,
  }: { number?: number | null; headSha?: string; untilMergeable?: boolean } = {},
): Promise<void> {
  const context = await getPullRequestContext(deps.db, designId);
  if (!context) return;
  const target = targetOf(context);
  if (target instanceof ApiError) return;
  for (let attempt = 0; ; attempt++) {
    const { read, readAt } = await readPullRequest(deps, target, number ?? target.number);
    const { pullRequest } = read;
    if (pullRequest) await recordRead(deps, designId, pullRequest, readAt);
    const open = pullRequest?.state === "open" || pullRequest?.state === "draft";
    const behind = open && headSha !== undefined && pullRequest.head.sha !== headSha;
    const working = open && untilMergeable && pullRequest.mergeable === null;
    const wait = CATCH_UP_MS[attempt];
    if (!(behind || working) || wait === undefined) return;
    await deps.clock.sleep(wait);
  }
}
