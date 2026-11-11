import { gateMessage } from "./gate.ts";
import type { PullRequestSummary, SteerGate } from "./model.ts";

/** The one thing the chrome's dark button offers, from the pull request's state. */
export type NextAction =
  | "create_pr"
  | "ready"
  | "resolve"
  | "fix_checks"
  | "auto_merge"
  | "auto_merge_on"
  | "merge";

/**
 * The next best action. A draft is made ready before anything else; conflicts are resolved
 * before failing checks are fixed, since resolving them reruns the checks; running checks offer
 * auto-merge; anything else that is open can be merged. A merged pull request offers nothing,
 * and one closed unmerged is as good as none.
 */
export function nextAction(
  pr: PullRequestSummary | null,
  branchHasChanges: boolean,
): NextAction | null {
  if (!pr || pr.state === "closed") return branchHasChanges ? "create_pr" : null;
  if (pr.state === "merged") return null;
  if (pr.state === "draft") return "ready";
  if (pr.mergeable === false) return "resolve";
  if (pr.checks === "failing") return "fix_checks";
  if (pr.checks === "running") return pr.autoMerge ? "auto_merge_on" : "auto_merge";
  return "merge";
}

/** The actions Ponzu hands to the agent, which wait while it can't run. The rest are GitHub's. */
const AGENT_ACTIONS: ReadonlySet<NextAction> = new Set(["create_pr", "fix_checks", "resolve"]);

/**
 * Why the next action can't be taken now, for its tip, or null when it can. Every action steers
 * the design, so it needs write access; the agent's actions also wait while its Claude can't run.
 */
export function actionBlock(
  action: NextAction,
  gate: SteerGate | null,
  meId: string,
): string | null {
  if (!gate) return null;
  if (gate.kind === "read_only") {
    return gate.repo ? `Needs write access to ${gate.repo.owner}/${gate.repo.name}` : null;
  }
  return AGENT_ACTIONS.has(action) ? gateMessage(gate, meId) : null;
}

/** The pull request icon's state: which glyph, and which color when the mark is active. */
export type PullRequestIconState = "open" | "draft" | "conflict" | "merged" | "closed";

export function pullRequestIcon(pr: PullRequestSummary): PullRequestIconState {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.state === "draft") return "draft";
  return pr.mergeable === false ? "conflict" : "open";
}

/** The mark after the number: a draft's hollow dot, or how the checks stand. */
export type ChecksGlyph = "draft" | "running" | "failing" | "passing";

export function checksGlyph(pr: PullRequestSummary): ChecksGlyph | null {
  if (pr.state === "merged" || pr.state === "closed") return null;
  if (pr.state === "draft") return "draft";
  return pr.checks === "none" ? null : pr.checks;
}
