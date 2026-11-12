import { ApiError, type CanvasHeadRow, type PullRequestTab } from "@ponzu/client";
import type {
  CanvasSummary,
  CheckRun,
  GithubAuthor,
  PrFile,
  PullRequestDetail,
  PullRequestSummary,
} from "../cloud/model.ts";
import type { NextAction } from "../cloud/pull-request.ts";

/*
 * The API's pull request (`PullRequestTab`, apps/api/src/pull-requests/view.ts) as the UI's
 * model, in one place: the tab's detail, the chrome's mark from the canvas's head, and the
 * action button. Every title, body and name is GitHub's, and untrusted: the tab draws them
 * through Prose.
 */

type Pull = NonNullable<PullRequestTab["pullRequest"]>;
type ApiCheck = Pull["checks"]["items"][number];
type Who = Pull["author"];

const CHECK_STATE: Record<ApiCheck["state"], CheckRun["state"]> = {
  pending: "queued",
  running: "running",
  passed: "passing",
  failed: "failing",
  cancelled: "failing",
  skipped: "skipped",
  neutral: "skipped",
};

const FILE_STATUS: Record<Pull["files"]["items"][number]["change"], PrFile["status"]> = {
  added: "added",
  deleted: "removed",
  renamed: "renamed",
  modified: "modified",
  copied: "modified",
  changed: "modified",
};

/**
 * Someone on GitHub; a deleted account is GitHub's "ghost". The Ponzu App's own bot, as the API
 * marks it, is the agent; any other bot is itself.
 */
function authorOf(who: Who): GithubAuthor {
  if (!who) return { login: "ghost", name: null, avatarUrl: null, agent: false };
  return { login: who.login, name: null, avatarUrl: who.avatarUrl, agent: who.ponzu };
}

/** The tab's pull request, from the API's. Each file's diff is asked for when its card opens. */
export function toPullRequestDetail(pr: Pull): PullRequestDetail {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: bodyForTab(pr.body),
    head: pr.head.ref,
    headSha: pr.head.sha,
    base: pr.base.ref,
    state: pr.state,
    endedAt: pr.mergedAt ?? pr.closedAt,
    additions: pr.files.additions,
    deletions: pr.files.deletions,
    checks: pr.checks.items.map((check, i) => ({
      // A check is named by its app, not uniquely: two may share a name.
      id: `${check.app ?? "status"}:${check.name}:${i}`,
      name: check.name,
      state: CHECK_STATE[check.state],
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      description: null,
      url: check.url,
    })),
    checksComplete: pr.checks.complete,
    comments: pr.conversation.map((comment) => ({
      id: comment.id,
      author: authorOf(comment.author),
      body: comment.body,
      at: comment.at,
      path: comment.path,
      line: comment.line,
      url: comment.url,
    })),
    // A dismissed review no longer stands.
    reviews: pr.reviews.flatMap((review) =>
      review.state === "dismissed"
        ? []
        : [
            {
              id: review.id,
              author: authorOf(review.author),
              state: review.state,
              at: review.at ?? pr.updatedAt,
            },
          ],
    ),
    // Where a renamed file was comes with its diff, when its card opens.
    files: pr.files.items.map((file) => ({
      path: file.path,
      previousPath: null,
      status: FILE_STATUS[file.change],
      additions: file.additions,
      deletions: file.deletions,
      diff: null,
    })),
    filesTotal: pr.files.total,
  };
}

/**
 * A description as the tab shows it: what Ponzu wrote for GitHub's readers taken out. The
 * canvas's picture is HTML for GitHub's page (the tab draws HTML as text, and the canvas is open
 * beside it anyway), the way back to Ponzu leads where the tab already is, and the markers around
 * the agent's summary are for rewriting it. What anyone else wrote stays as written.
 */
export function bodyForTab(body: string): string {
  return body
    .replace(/<!-- ponzu:picture -->[\s\S]*?<!-- \/ponzu:picture -->/g, "")
    .replace(/<!-- \/?ponzu:summary -->/g, "")
    .replace(/^Designed in Ponzu: \[[^\n]*\]\(https:\/\/ponzu\.design\/[^\s)]*\)[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type HeadPr = Pick<
  CanvasHeadRow,
  "prNumber" | "prState" | "prChecks" | "prMergeable" | "prAutoMerge"
>;

/** The chrome's mark, from the canvas's head: what the sidebar and the chrome watch live. */
export function prSummary(head: HeadPr | undefined): PullRequestSummary | null {
  if (!head || head.prNumber === null || head.prState === null) return null;
  return {
    number: head.prNumber,
    state: head.prState,
    checks: head.prChecks,
    mergeable: head.prMergeable,
    autoMerge: head.prAutoMerge,
  };
}

/**
 * The pull request as the sidebar's row has it, before the canvas's head has come: the same
 * columns, with what the last read of GitHub said of whether it can merge, where that read is of
 * the same pull request as it stands.
 */
export function rowPullRequest(
  summary: CanvasSummary | null,
  tab: PullRequestTab | null,
): PullRequestSummary | null {
  const pr = summary?.pullRequest;
  if (!pr) return null;
  const read = tab && agrees(tab, pr) ? tab.pullRequest : null;
  return { ...pr, mergeable: read?.mergeable ?? null, autoMerge: Boolean(read?.autoMerge) };
}

/** Whether a read of GitHub says what the row or the head says now of the same pull request. */
export function agrees(tab: PullRequestTab, pr: PullRequestSummary | null): boolean {
  const read = tab.pullRequest;
  if (!read || !pr) return !read && !pr;
  return read.number === pr.number && read.state === pr.state && read.checks.state === pr.checks;
}

/**
 * The read whose action the chrome offers: the last one, unless it is only the answer kept from
 * an earlier opening and the row or the head now says otherwise (merged, closed or pushed to
 * since). Merge isn't offered on a pull request already merged before the read on opening says.
 */
export function offeredTab(
  pull: { tab: PullRequestTab | null; confirmed: boolean },
  pr: PullRequestSummary | null,
): PullRequestTab | null {
  return pull.tab && (pull.confirmed || agrees(pull.tab, pr)) ? pull.tab : null;
}

/** The chrome's button for the API's next action: none for `none`, and auto-merge once on. */
export function chromeAction(tab: PullRequestTab): NextAction | null {
  switch (tab.nextAction) {
    case "none":
      return null;
    case "auto_merge":
      return tab.pullRequest?.autoMerge ? "auto_merge_on" : "auto_merge";
    default:
      return tab.nextAction;
  }
}

/** What the repo's rules still want before a merge, for the confirmation to merge anyway. */
export function rulesWant(pr: Pull): string {
  if (pr.reviewDecision === "changes_requested") return "A reviewer asked for changes.";
  if (pr.reviewDecision === "review_required") return "The repo's rules want an approving review.";
  const required = pr.checks.items.filter((check) => check.required);
  if (required.some((check) => check.state === "failed" || check.state === "cancelled")) {
    return "A check the repo's rules require failed.";
  }
  if (required.some((check) => check.state === "pending" || check.state === "running")) {
    return "Checks the repo's rules require haven't finished.";
  }
  return "The repo's rules don't allow merging it yet.";
}

/** The pull request codes whose messages the API writes for people, naming the branch. */
const SAID_BY_THE_API = new Set([
  "no_pull_request",
  "pull_request_closed",
  "pull_request_draft",
  "head_moved",
  "mergeability_unknown",
  "merge_conflicts",
  "review_required",
  "changes_requested",
  "checks_failing",
  "checks_pending",
  "branch_behind",
  "branch_protected",
  "branch_up_to_date",
  "auto_merge_not_allowed",
  "already_mergeable",
  "no_changes",
  "branch_not_pushed",
  "no_repository",
  "forbidden",
]);

/** Why an action on the pull request didn't happen, in a sentence a person can act on. */
export function prActionError(error: unknown): string {
  if (!(error instanceof ApiError)) return "That didn't work. Try again.";
  if (SAID_BY_THE_API.has(error.code)) return error.message;
  switch (error.code) {
    case "github_reauth_required":
      return "GitHub needs you to sign in to Ponzu again before it acts for you.";
    case "github_refused":
      return "GitHub turned that down. Look at the pull request on GitHub to see why.";
    case "network":
      return "Ponzu can't be reached. Check your connection and try again.";
    case "upstream_unavailable":
      return "GitHub isn't answering right now. Try again in a moment.";
    default:
      return "That didn't work. Try again.";
  }
}
