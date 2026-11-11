import type { PullRequestContext, User } from "@ponzu/db";
import type { GithubPullRequest, PersonResult } from "../deps/github-pull-requests.ts";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { ApiError } from "../http/errors.ts";
import {
  type PullRequestDeps,
  type PullRequestTarget,
  type Read,
  readPullRequest,
  recordRead,
  refreshPullRequest,
  targetOf,
} from "./sync.ts";
import { type PullRequestTab, toTab } from "./view.ts";

/*
 * What a person does to a design's pull request: mark it ready, merge it, set auto-merge, close
 * it, or bring its branch up to date. Each is done as them, with their GitHub user token
 * (docs/cloud.md, "Pull requests"): GitHub then holds the merge to the rules of the repo as
 * they apply to that person, and its history names them.
 *
 * Each reads the pull request first, refuses what it can name before asking GitHub, and says
 * why GitHub refused with a code a client can show. Each ends by reading it again, and that is
 * what it answers: GitHub's word on what happened, recorded on the design.
 */

export type PullRequestAction =
  | { kind: "ready" }
  /** `headSha` is the commit the person looked at: the merge is refused if the branch moved. */
  | { kind: "merge"; headSha?: string }
  | { kind: "auto_merge"; enabled: boolean }
  | { kind: "close" }
  | { kind: "update_branch"; headSha?: string };

type ActDeps = PullRequestDeps & Pick<Deps, "vault" | "background">;

/** The waits for GitHub to work out whether a pull request can merge, before giving up. */
const MERGEABLE_WAITS_MS = [1_000, 2_000];
/** Merge states in which nothing is left for auto-merge to wait on. */
const MERGEABLE_NOW = ["clean", "unstable", "has_hooks"];

export async function actOnPullRequest(
  deps: ActDeps,
  context: PullRequestContext,
  user: User,
  action: PullRequestAction,
): Promise<PullRequestTab> {
  const target = targetOf(context);
  if (target instanceof ApiError) throw target;
  const read = await act(deps, target, user, action);
  return toTab(target, read.read);
}

async function act(
  deps: ActDeps,
  target: PullRequestTarget,
  user: User,
  action: PullRequestAction,
): Promise<Read> {
  const { github } = deps;
  let current = await readAndRecord(deps, target);
  const pr = current.read.pullRequest;
  if (!pr) throw new ApiError(409, "no_pull_request", "This design has no pull request yet.");
  const personToken = () => githubUserToken(deps, user.id);
  const { fullName } = target.repo.repository;
  const { number } = pr;

  switch (action.kind) {
    case "ready": {
      if (pr.state === "open") return current;
      if (pr.state !== "draft") throw closed(pr);
      expectDone(await github.markReady(await personToken(), pr.id), pr);
      break;
    }

    case "merge": {
      if (pr.state === "merged") return current;
      if (pr.state === "closed") throw closed(pr);
      if (pr.state === "draft") throw draft();
      current = await untilMergeable(deps, target, current);
      const ready = current.read.pullRequest!;
      if (action.headSha && action.headSha !== ready.head.sha) throw headMoved();
      if (ready.mergeable === false) throw conflicts(ready);
      const method = current.read.mergeMethods[0];
      if (!method) throw refused();
      const result = await github.mergePullRequest(await personToken(), {
        fullName,
        number,
        method,
        sha: ready.head.sha,
      });
      if (result === "not_mergeable") {
        // GitHub does not say why, but the pull request as it is now does.
        throw blockedBy((await readAndRecord(deps, target)).read.pullRequest ?? ready);
      }
      expectDone(result, ready);
      break;
    }

    case "auto_merge": {
      if (pr.state === "merged" || pr.state === "closed") throw closed(pr);
      if (!action.enabled) {
        if (!pr.autoMerge) return current;
        expectDone(await github.disableAutoMerge(await personToken(), pr.id), pr);
        break;
      }
      if (pr.autoMerge) return current;
      if (pr.state === "draft") throw draft();
      if (!current.read.autoMergeAllowed) {
        throw new ApiError(
          409,
          "auto_merge_not_allowed",
          `${fullName} does not allow auto-merge. It can be turned on in the repo's settings.`,
        );
      }
      if (pr.mergeable === false) throw conflicts(pr);
      if (MERGEABLE_NOW.includes(pr.mergeState)) {
        throw new ApiError(409, "already_mergeable", "Nothing is left to wait for: merge it now.");
      }
      const method = current.read.mergeMethods[0];
      if (!method) throw refused();
      expectDone(await github.enableAutoMerge(await personToken(), pr.id, method), pr);
      break;
    }

    case "close": {
      if (pr.state === "closed") return current;
      if (pr.state === "merged") throw closed(pr);
      expectDone(await github.closePullRequest(await personToken(), { fullName, number }), pr);
      break;
    }

    case "update_branch": {
      if (pr.state === "merged" || pr.state === "closed") throw closed(pr);
      const behind = (current.read.branch?.behindBy ?? 0) > 0 || pr.mergeState === "behind";
      if (!behind) {
        throw new ApiError(
          409,
          "branch_up_to_date",
          `${pr.head.ref} already has everything in ${pr.base.ref}.`,
        );
      }
      if (action.headSha && action.headSha !== pr.head.sha) throw headMoved();
      const result = await github.updatePullRequestBranch(await personToken(), {
        fullName,
        number,
        sha: pr.head.sha,
      });
      if (result === "refused" && pr.mergeable === false) throw conflicts(pr);
      expectDone(result, pr);
      // GitHub makes the merge commit a moment later, and then works out mergeability again.
      deps.background(
        "pull_request_refresh",
        refreshPullRequest(deps, target.designId, { number, untilMergeable: true }),
      );
      break;
    }
  }
  return readAndRecord(deps, target, number);
}

async function readAndRecord(
  deps: PullRequestDeps,
  target: PullRequestTarget,
  number?: number,
): Promise<Read> {
  const read = await readPullRequest(deps, target, number);
  const { pullRequest } = read.read;
  if (pullRequest) await recordRead(deps, target.designId, pullRequest, read.readAt);
  return read;
}

/** Read again while GitHub is still working out whether it can merge, for a few seconds. */
async function untilMergeable(
  deps: PullRequestDeps,
  target: PullRequestTarget,
  current: Read,
): Promise<Read> {
  for (const wait of MERGEABLE_WAITS_MS) {
    if (current.read.pullRequest?.mergeable !== null) return current;
    await deps.clock.sleep(wait);
    current = await readAndRecord(deps, target, current.read.pullRequest!.number);
  }
  if (current.read.pullRequest?.mergeable === null) {
    throw new ApiError(
      409,
      "mergeability_unknown",
      "GitHub is still checking whether this can merge. Try again in a moment.",
    );
  }
  return current;
}

/** Throws what GitHub's answer means, unless it did what was asked. */
function expectDone(result: PersonResult, pr: GithubPullRequest): void {
  switch (result) {
    case "done":
      return;
    case "head_moved":
      throw headMoved();
    case "forbidden":
      throw new ApiError(
        403,
        "forbidden",
        `GitHub does not let you do this to #${pr.number} in its repo.`,
      );
    case "not_mergeable":
      throw blockedBy(pr);
    case "refused":
      throw refused();
  }
}

/** Why GitHub will not merge it now, as far as the pull request says. */
function blockedBy(pr: GithubPullRequest): ApiError {
  if (pr.mergeable === false) return conflicts(pr);
  if (pr.reviewDecision === "changes_requested") {
    return new ApiError(409, "changes_requested", "A reviewer asked for changes.");
  }
  if (pr.reviewDecision === "review_required") {
    return new ApiError(409, "review_required", "The repo's rules want an approving review first.");
  }
  if (pr.checks.state === "failing") {
    return new ApiError(409, "checks_failing", "A required check failed.");
  }
  if (pr.checks.state === "running") {
    return new ApiError(409, "checks_pending", "Required checks have not finished yet.");
  }
  if (pr.mergeState === "behind") {
    return new ApiError(
      409,
      "branch_behind",
      `The repo's rules want ${pr.head.ref} up to date with ${pr.base.ref} first.`,
    );
  }
  return new ApiError(
    409,
    "branch_protected",
    `The repo's rules do not allow merging #${pr.number} now.`,
  );
}

const closed = (pr: GithubPullRequest) =>
  new ApiError(409, "pull_request_closed", `#${pr.number} is ${pr.state}.`);

const draft = () =>
  new ApiError(409, "pull_request_draft", "This pull request is a draft. Mark it ready first.");

const conflicts = (pr: GithubPullRequest) =>
  new ApiError(409, "merge_conflicts", `${pr.head.ref} conflicts with ${pr.base.ref}.`);

const headMoved = () =>
  new ApiError(409, "head_moved", "The branch has new commits since you looked. Look again first.");

const refused = () =>
  new ApiError(
    422,
    "github_refused",
    "GitHub would not do this. The pull request on GitHub says why.",
  );
