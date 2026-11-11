import { PR_CHECKS, PR_STATES } from "@ponzu/db";
import { z } from "zod";
import type { GithubPullRequestRead } from "../deps/github-pull-requests.ts";
import type { PullRequestTarget } from "./sync.ts";

/*
 * What the pull request tab shows, as the API answers it: a small shape of its own, so that
 * nothing of GitHub's reaches a client unless it is listed here.
 *
 * UNTRUSTED: every title, body, name and remark here is what someone on GitHub wrote (anyone
 * who can comment, any app that posts a check), as GitHub's markdown, which may hold raw HTML;
 * a description holds Ponzu's own `<picture>`. A client renders it with raw HTML off and
 * remote images neither loaded nor followed, and opens only the links given here, all of which
 * are http(s).
 */

const Who = z.object({ login: z.string(), avatarUrl: z.string().nullable(), bot: z.boolean() });
const MergeMethod = z.enum(["squash", "merge", "rebase"]);

/** The one thing the chrome's action button offers (docs/cloud.md, "Pull requests"). */
export const NEXT_ACTIONS = [
  "create_pr",
  "ready",
  "auto_merge",
  "fix_checks",
  "resolve",
  "update_branch",
  "merge",
  "blocked",
  "none",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const PullRequestView = z.object({
  number: z.number(),
  url: z.string(),
  /** Untrusted. */
  title: z.string(),
  /** Untrusted markdown. */
  body: z.string(),
  state: z.enum(PR_STATES),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  author: Who.nullable(),
  mergedBy: Who.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  mergedAt: z.date().nullable(),
  closedAt: z.date().nullable(),
  /** False when it conflicts with its base; null while GitHub works it out. */
  mergeable: z.boolean().nullable(),
  mergeState: z.enum([
    "clean",
    "unstable",
    "has_hooks",
    "behind",
    "blocked",
    "dirty",
    "draft",
    "unknown",
  ]),
  reviewDecision: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  autoMerge: z.object({ method: MergeMethod, enabledBy: Who.nullable() }).nullable(),
  checks: z.object({
    state: z.enum(PR_CHECKS),
    items: z.array(
      z.object({
        name: z.string(),
        app: z.string().nullable(),
        /** Whether the repo's rules want it to pass before the pull request merges. */
        required: z.boolean(),
        state: z.enum([
          "pending",
          "running",
          "passed",
          "failed",
          "cancelled",
          "skipped",
          "neutral",
        ]),
        url: z.string().nullable(),
        startedAt: z.date().nullable(),
        completedAt: z.date().nullable(),
      }),
    ),
    /** False when there were more than the first hundred. */
    complete: z.boolean(),
  }),
  reviews: z.array(
    z.object({
      id: z.string(),
      author: Who.nullable(),
      state: z.enum(["approved", "changes_requested", "dismissed"]),
      at: z.date().nullable(),
      url: z.string(),
    }),
  ),
  /** Comments, reviews' words and line comments, oldest first. Read-only in Ponzu. */
  conversation: z.array(
    z.object({
      id: z.string(),
      author: Who.nullable(),
      /** Untrusted markdown. */
      body: z.string(),
      at: z.date(),
      url: z.string(),
      path: z.string().nullable(),
      line: z.number().nullable(),
    }),
  ),
  files: z.object({
    total: z.number(),
    additions: z.number(),
    deletions: z.number(),
    /** The first hundred; `total` says how many there are. */
    items: z.array(
      z.object({
        path: z.string(),
        change: z.enum(["added", "modified", "deleted", "renamed", "copied", "changed"]),
        additions: z.number(),
        deletions: z.number(),
      }),
    ),
  }),
  /** The last hundred, oldest first. */
  commits: z.object({
    total: z.number(),
    items: z.array(
      z.object({
        sha: z.string(),
        message: z.string(),
        at: z.date(),
        author: z.string().nullable(),
      }),
    ),
  }),
});

export const PullRequestTabView = z.object({
  /** The design's branch on GitHub; `exists` is false until something is pushed to it. */
  branch: z.object({
    name: z.string(),
    base: z.string(),
    exists: z.boolean(),
    /** Its commits that the base lacks, and the base's that it lacks. */
    aheadBy: z.number(),
    behindBy: z.number(),
  }),
  /** The design's newest pull request; null before one is opened. */
  pullRequest: PullRequestView.nullable(),
  /** How Merge merges: the first of squash, merge and rebase the repo allows. */
  mergeMethod: MergeMethod.nullable(),
  autoMergeAllowed: z.boolean(),
  nextAction: z.enum(NEXT_ACTIONS),
});

export type PullRequestTab = z.input<typeof PullRequestTabView>;

/** The tab as a read found it. */
export function toTab(target: PullRequestTarget, read: GithubPullRequestRead): PullRequestTab {
  const { pullRequest, branch } = read;
  return {
    branch: {
      name: target.branch,
      base: target.defaultBranch,
      exists: branch !== null,
      aheadBy: branch?.aheadBy ?? 0,
      behindBy: branch?.behindBy ?? 0,
    },
    pullRequest: pullRequest && {
      ...pullRequest,
      head: { ref: pullRequest.head.ref, sha: pullRequest.head.sha },
    },
    mergeMethod: read.mergeMethods[0] ?? null,
    autoMergeAllowed: read.autoMergeAllowed,
    nextAction: nextAction(read),
  };
}

/**
 * What the action button offers (the spec's PR states): open one when the branch has changes and
 * no open pull request (or commits since its merged one); then ready a draft, resolve conflicts,
 * fix failing checks, wait on running ones with auto-merge where the repo allows it, and update a
 * branch the repo's rules hold back for being behind. What the rules still want (a review, a
 * required check) is waited for with auto-merge where the repo allows it, and is otherwise
 * `blocked`, never `merge`: Merge never asks GitHub to set the rules aside.
 */
export function nextAction({
  pullRequest,
  branch,
  autoMergeAllowed,
}: GithubPullRequestRead): NextAction {
  if (!pullRequest || pullRequest.state === "closed") {
    return branch && branch.aheadBy > 0 ? "create_pr" : "none";
  }
  if (pullRequest.state === "merged") {
    const workedOnSince = branch && branch.sha !== pullRequest.head.sha && branch.aheadBy > 0;
    return workedOnSince ? "create_pr" : "none";
  }
  if (pullRequest.state === "draft") return "ready";
  if (pullRequest.mergeable === false) return "resolve";
  if (pullRequest.checks.state === "failing") return "fix_checks";
  if (pullRequest.checks.state === "running" && autoMergeAllowed) return "auto_merge";
  if (pullRequest.mergeState === "behind") return "update_branch";
  if (pullRequest.mergeState === "blocked") return autoMergeAllowed ? "auto_merge" : "blocked";
  return "merge";
}
