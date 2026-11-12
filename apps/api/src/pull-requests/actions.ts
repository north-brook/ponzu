import type { PullRequestContext, User } from "@ponzu/db";
import type {
  GithubCheck,
  GithubPullRequest,
  MergeRefusal,
  PersonResult,
} from "../deps/github-pull-requests.ts";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { ApiError } from "../http/errors.ts";
import { refreshLater } from "./refresh.ts";
import {
  lagsBranch,
  type PullRequestDeps,
  type PullRequestTarget,
  type Read,
  readPullRequest,
  recordCurrent,
  refreshPullRequest,
  targetOf,
} from "./sync.ts";
import { type PullRequestTab, toTab } from "./view.ts";

/*
 * What a person does to a canvas's pull request: mark it ready, merge it, set auto-merge, close
 * it, or bring its branch up to date. Each is done as them, with their GitHub user token
 * (docs/cloud.md, "Pull requests"): GitHub then holds them to the rules of the repo as they
 * apply to that person, and its history names them.
 *
 * Each reads the pull request first, refuses what it can name before asking GitHub, and says
 * why GitHub refused with a code a client can show. Each ends by reading it again, and that is
 * what it answers: GitHub's word on what happened, recorded on the canvas.
 */

export type PullRequestAction =
  | { kind: "ready" }
  /**
   * `headSha` is the commit the person looked at: the merge is refused if the branch moved.
   * Merge waits for what the repo's rules still want (a review, a required check) unless
   * `bypass` says the person chose to merge without it, which GitHub allows only to those its
   * rules let bypass them.
   */
  | { kind: "merge"; headSha: string; bypass: boolean }
  | { kind: "auto_merge"; enabled: boolean }
  | { kind: "close" }
  | { kind: "update_branch"; headSha: string };

type ActDeps = PullRequestDeps & Pick<Deps, "vault" | "background" | "config">;

/** The waits for GitHub to work out whether a pull request can merge, before giving up. */
const MERGEABLE_WAITS_MS = [1_000, 2_000];
/** The waits for GitHub's reads to show a merge it has just said it did. */
const MERGED_WAITS_MS = [1_000, 2_000];
/** When a merge GitHub's reads did not show yet is read again, whatever its webhook does. */
const MERGE_CHECKED_AFTER_MS = 60_000;
/** Merge states in which nothing is left for the repo's rules to want. */
const MERGEABLE_NOW = ["clean", "unstable", "has_hooks"];

export async function actOnPullRequest(
  deps: ActDeps,
  context: PullRequestContext,
  user: User,
  action: PullRequestAction,
): Promise<PullRequestTab> {
  return (await actAndSay(deps, context, user, action)).tab;
}

/**
 * `actOnPullRequest`, saying too whether this call is what did it (`did`): false when there was
 * nothing to do (already ready, already merged, auto-merge already on), as when someone else did
 * it a moment before. The agent's routes say so in its thread only when it did.
 */
export async function actAndSay(
  deps: ActDeps,
  context: PullRequestContext,
  user: User,
  action: PullRequestAction,
): Promise<{ tab: PullRequestTab; did: boolean }> {
  const target = targetOf(context);
  if (target instanceof ApiError) throw target;
  const done = { did: false };
  const read = await act(deps, target, user, action, done);
  return { tab: toTab(target, read.read, deps.config.githubApp.slug), did: done.did };
}

async function act(
  deps: ActDeps,
  target: PullRequestTarget,
  user: User,
  action: PullRequestAction,
  done: { did: boolean },
): Promise<Read> {
  const { github } = deps;
  let current = await readAndRecord(deps, target);
  const pr = current.read.pullRequest;
  if (!pr) throw new ApiError(409, "no_pull_request", "This canvas has no pull request yet.");
  const personToken = () => githubUserToken(deps, user.id);
  const { fullName } = target.repo.repository;
  const { number } = pr;

  switch (action.kind) {
    case "ready": {
      if (pr.state === "open") return current;
      if (pr.state !== "draft") throw closed(pr);
      expectDone(await github.markReady(await personToken(), pr.id), pr);
      done.did = true;
      break;
    }

    case "merge": {
      if (pr.state === "merged") return current;
      if (pr.state === "closed") throw closed(pr);
      if (pr.state === "draft") throw draft();
      current = await untilMergeable(deps, target, current);
      const ready = current.read.pullRequest!;
      if (action.headSha !== ready.head.sha || lagsBranch(current.read)) throw headMoved();
      if (ready.mergeable === false) throw conflicts(ready);
      if (!action.bypass && !MERGEABLE_NOW.includes(ready.mergeState)) throw blockedBy(ready);
      const method = current.read.mergeMethods[0];
      if (!method) throw refused();
      const result = await github.mergePullRequest(await personToken(), {
        fullName,
        number,
        method,
        sha: ready.head.sha,
      });
      if (result === "done") {
        done.did = true;
        const merged = await untilMerged(deps, target, number);
        // The branch is done with once merged, as GitHub's own button leaves it to be deleted:
        // only while it is still where it merged, so nothing pushed since is lost.
        if (
          merged.read.pullRequest?.state === "merged" &&
          merged.read.branch?.sha === ready.head.sha
        ) {
          deps.background(
            "pull_request_branch_delete",
            deleteMergedBranch(deps, await personToken(), fullName, ready.head.ref),
          );
        }
        return merged;
      }
      // Someone else (a person pressing Merge, the agent, auto-merge) merged it first: what
      // GitHub has now is the answer, and this call did nothing.
      const now = await readAndRecord(deps, target, number);
      if (now.read.pullRequest?.state === "merged") return now;
      if (result === "not_mergeable") {
        // GitHub does not say why, but the pull request as it is now does.
        throw blockedBy(now.read.pullRequest ?? ready);
      }
      if (isRefusal(result)) throw refusalError(result, ready);
      expectDone(result, ready);
      break;
    }

    case "auto_merge": {
      if (pr.state === "merged" || pr.state === "closed") throw closed(pr);
      if (!action.enabled) {
        if (!pr.autoMerge) return current;
        expectDone(await github.disableAutoMerge(await personToken(), pr.id), pr);
        done.did = true;
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
      done.did = true;
      break;
    }

    case "close": {
      if (pr.state === "closed") return current;
      if (pr.state === "merged") throw closed(pr);
      expectDone(await github.closePullRequest(await personToken(), { fullName, number }), pr);
      done.did = true;
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
      if (action.headSha !== pr.head.sha || lagsBranch(current.read)) throw headMoved();
      const result = await github.updatePullRequestBranch(await personToken(), {
        fullName,
        number,
        sha: pr.head.sha,
      });
      if (result === "refused" && pr.mergeable === false) throw conflicts(pr);
      expectDone(result, pr);
      done.did = true;
      // GitHub makes the merge commit a moment later, and then works out mergeability again.
      deps.background(
        "pull_request_refresh",
        refreshPullRequest(deps, target.canvasId, { number }),
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
  await recordCurrent(deps, target.canvasId, read);
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
  if (current.read.pullRequest?.mergeable === null) throw mergeabilityUnknown();
  return current;
}

/**
 * Read a pull request GitHub has just merged until its reads show it merged, which settles the
 * canvas, for a few seconds. If they still do not, it is read again in a minute by a job, so the
 * canvas settles even if GitHub's webhook for the merge never comes.
 */
async function untilMerged(
  deps: PullRequestDeps,
  target: PullRequestTarget,
  number: number,
): Promise<Read> {
  let current = await readAndRecord(deps, target, number);
  for (const wait of MERGED_WAITS_MS) {
    if (current.read.pullRequest?.state === "merged") return current;
    await deps.clock.sleep(wait);
    current = await readAndRecord(deps, target, number);
  }
  if (current.read.pullRequest?.state !== "merged") {
    await refreshLater(deps, { canvasId: target.canvasId, number }, MERGE_CHECKED_AFTER_MS);
  }
  return current;
}

/** Deletes a merged canvas's branch; a refusal (protected, or no right to) leaves it be. */
async function deleteMergedBranch(
  deps: ActDeps,
  userToken: string,
  fullName: string,
  branch: string,
): Promise<void> {
  const result = await deps.github.deleteBranch(userToken, { fullName, branch });
  if (result !== "done") deps.log.info("pull_request_branch_kept", { fullName, branch, result });
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
    case "refused":
      throw refused();
  }
}

/**
 * What holds an open pull request back from merging now, in the words and code Merge would
 * refuse with; null when Merge would ask GitHub (clean, unstable or with hooks). A draft is held
 * back by being one.
 */
export function mergeHold(pr: Holdable): { code: string; message: string } | null {
  if (pr.state === "draft") {
    const error = draft();
    return { code: error.code, message: error.message };
  }
  if (pr.state !== "open") return null;
  if (pr.mergeable !== false && MERGEABLE_NOW.includes(pr.mergeState)) return null;
  const error = pr.mergeable === null ? mergeabilityUnknown() : blockedBy(pr);
  return { code: error.code, message: error.message };
}

/** What saying why a pull request is held back reads of it: GitHub's, or the tab's. */
type Holdable = Pick<
  GithubPullRequest,
  "number" | "state" | "mergeable" | "mergeState" | "reviewDecision"
> & {
  head: { ref: string };
  base: { ref: string };
  checks: { items: Pick<GithubCheck, "required" | "state">[] };
};

/** Why the repo's rules do not let it merge now, as far as the pull request says. */
function blockedBy(pr: Holdable): ApiError {
  if (pr.mergeable === false) return conflicts(pr);
  if (pr.mergeState === "behind") return refusalError("branch_behind", pr);
  if (pr.reviewDecision === "changes_requested") return refusalError("changes_requested", pr);
  if (pr.reviewDecision === "review_required") return refusalError("review_required", pr);
  // Only the checks the rules require hold a merge back; any other may fail.
  const required = pr.checks.items.filter((check) => check.required);
  if (required.some((check) => check.state === "failed" || check.state === "cancelled")) {
    return refusalError("checks_failing", pr);
  }
  if (required.some((check) => check.state === "pending" || check.state === "running")) {
    return refusalError("checks_pending", pr);
  }
  if (pr.mergeState === "unknown") return mergeabilityUnknown();
  return new ApiError(
    409,
    "branch_protected",
    `The repo's rules do not allow merging #${pr.number} now.`,
  );
}

const REFUSALS = [
  "review_required",
  "changes_requested",
  "checks_pending",
  "checks_failing",
  "branch_behind",
  "merge_conflicts",
] as const;

function isRefusal(result: PersonResult | MergeRefusal): result is (typeof REFUSALS)[number] {
  return (REFUSALS as readonly string[]).includes(result);
}

/** What GitHub's reason for not merging means for the person. */
function refusalError(refusal: (typeof REFUSALS)[number], pr: Holdable): ApiError {
  switch (refusal) {
    case "review_required":
      return new ApiError(409, refusal, "The repo's rules want an approving review first.");
    case "changes_requested":
      return new ApiError(409, refusal, "A reviewer asked for changes.");
    case "checks_failing":
      return new ApiError(409, refusal, "A check the repo's rules require failed.");
    case "checks_pending":
      return new ApiError(409, refusal, "Checks the repo's rules require have not finished yet.");
    case "branch_behind":
      return new ApiError(
        409,
        refusal,
        `The repo's rules want ${pr.head.ref} up to date with ${pr.base.ref} first.`,
      );
    case "merge_conflicts":
      return conflicts(pr);
  }
}

const closed = (pr: GithubPullRequest) =>
  new ApiError(409, "pull_request_closed", `#${pr.number} is ${pr.state}.`);

const draft = () =>
  new ApiError(409, "pull_request_draft", "This pull request is a draft. Mark it ready first.");

const conflicts = (pr: Holdable) =>
  new ApiError(409, "merge_conflicts", `${pr.head.ref} conflicts with ${pr.base.ref}.`);

const headMoved = () =>
  new ApiError(409, "head_moved", "The branch has new commits since you looked. Look again first.");

const mergeabilityUnknown = () =>
  new ApiError(
    409,
    "mergeability_unknown",
    "GitHub is still checking whether this can merge. Try again in a moment.",
  );

const refused = () =>
  new ApiError(
    422,
    "github_refused",
    "GitHub would not do this. The pull request on GitHub says why.",
  );
