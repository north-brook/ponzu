import { ApiError, type PullRequestTab } from "@ponzu/client";
import {
  agentAsk,
  type CheckRun,
  chromeAction,
  type GithubAuthor,
  type NextAction,
  type PrReview,
  prActionError,
} from "@ponzu/client/model";
import type { PullRequestAction } from "@ponzu/client/query";
import { sendFailed } from "./chat/lines";
import { PR } from "./copy";

/*
 * The pull request sheet's rules (components/pr-sheet.tsx, iPhone design §11): what its status
 * card says, what its one button at the foot offers, and what pressing it does. Pure, so the
 * Mac's rules and the phone's are tested here without a screen. Which action is next is the
 * API's (`nextAction`, read as the Mac's chrome reads it: `chromeAction`); the phone only ever
 * offers it, never a bypass.
 */

type Pull = NonNullable<PullRequestTab["pullRequest"]>;

/** What the foot holds: the one button, a line in its place, or nothing. */
export type PrFoot =
  | {
      kind: "action";
      action: Exclude<NextAction, "create_pr" | "blocked">;
      label: string;
      /** False for Auto-merge once on (it waits on GitHub) or an ask already made. */
      enabled: boolean;
      /** A quiet line above it: why it waits. */
      note: string | null;
    }
  | { kind: "line"; text: string }
  | null;

/**
 * The foot for a read of the pull request. Merged, closed or none: nothing (the merged icon goes
 * purple instead). Create PR is the Mac's, so the phone shows nothing for it. Held back by the
 * repo's rules with no auto-merge: the line that says it needs the Mac, and nothing to press.
 * On a canvas the person can only look at, the read-only line.
 */
export function prFoot(
  tab: PullRequestTab | null,
  opts: { readOnly: string | null; asked: AskedAgent | null },
): PrFoot {
  const pr = tab?.pullRequest;
  if (!tab || !pr) return null;
  const action = chromeAction(tab);
  if (!action || action === "create_pr") return null;
  if (opts.readOnly) return { kind: "line", text: opts.readOnly };
  if (action === "blocked") return { kind: "line", text: PR.needsMac(rulePast(pr)) };
  const asked = isAsked(opts.asked, action, pr);
  return {
    kind: "action",
    action,
    label: PR.actions[action],
    enabled: action !== "auto_merge_on" && !asked,
    note: action === "auto_merge_on" ? PR.mac.autoMergeOn : asked ? PR.asked : null,
  };
}

/** What the repo's rules want before a merge, as the thing a merge from the Mac goes past. */
export function rulePast(pr: Pull): string {
  if (pr.reviewDecision === "changes_requested") return "a request for changes";
  if (pr.reviewDecision === "review_required") return "the review the repo's rules want";
  const required = pr.checks.items.filter((check) => check.required);
  if (required.some((check) => check.state === "failed" || check.state === "cancelled")) {
    return "a required check that failed";
  }
  if (required.some((check) => check.state === "pending" || check.state === "running")) {
    return "required checks that haven't finished";
  }
  return "the repo's rules";
}

/** The status card's checks row: how many passed, failed or are still going. */
export function checksLine(
  checks: readonly CheckRun[],
  state: Pull["state"],
): { glyph: CheckRun["state"]; text: string } {
  if (!checks.length) {
    return {
      glyph: "queued",
      text: state === "open" || state === "draft" ? PR.mac.noChecks : PR.mac.noChecksRan,
    };
  }
  const failed = checks.filter((c) => c.state === "failing").length;
  if (failed) return { glyph: "failing", text: PR.checksFailed(failed) };
  const going = checks.filter((c) => c.state === "running" || c.state === "queued").length;
  if (going) {
    return { glyph: "running", text: PR.checksRunning(checks.length - going, checks.length) };
  }
  return { glyph: "passing", text: PR.checksPassed(checks.length) };
}

/** Someone on GitHub as the sheet names them: "You", "Claude", or their name (the Mac's tab's). */
export function authorName(author: GithubAuthor, viewerLogin: string | null): string {
  if (author.agent) return "Claude";
  if (viewerLogin && author.login === viewerLogin) return "You";
  return author.name?.trim().split(/\s+/)[0] || author.login;
}

/**
 * The status card's reviews row: a request for changes outranks approvals; one reviewer by name,
 * more as "and n others". Null with no reviews, and the row is left out.
 */
export function reviewsLine(
  reviews: readonly PrReview[],
  viewerLogin: string | null,
): { review: PrReview; text: string } | null {
  const changes = reviews.filter((r) => r.state === "changes_requested");
  const shown = changes.length ? changes : reviews.filter((r) => r.state === "approved");
  // Newest first: the one named is the latest to say so.
  const newest = shown.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const first = newest[0];
  if (!first) return null;
  const name = authorName(first.author, viewerLogin);
  const others = newest.length - 1;
  const who = others === 0 ? name : `${name} and ${others === 1 ? "1 other" : `${others} others`}`;
  return {
    review: first,
    text: `${who} ${first.state === "approved" ? "approved" : "requested changes"}`,
  };
}

/** Fix checks or Resolve, asked of the agent for this commit: not asked again until it moves. */
export interface AskedAgent {
  action: "fix_checks" | "resolve";
  headSha: string;
}

function isAsked(asked: AskedAgent | null, action: NextAction, pr: Pull): boolean {
  return Boolean(asked && asked.action === action && asked.headSha === pr.head.sha);
}

/** Why an action didn't happen, in one line above the button. */
export function actionFailed(error: unknown): string {
  // A billing wall says only its neutral first sentence (program §5.6), as the chat does.
  if (error instanceof ApiError && error.status === 402) return sendFailed(error);
  return prActionError(error);
}

/** What a press came to. */
export type PrRun = "done" | "failed" | "none";

export interface PrActionsState {
  /** The action on its way, from the press (the confirmation included) to the answer. */
  busy: NextAction | null;
  /** Why the last one didn't happen: GitHub's reason, in one line. */
  failed: string | null;
  asked: AskedAgent | null;
}

/**
 * What pressing the foot's button does, for one canvas. The person's actions go through the API
 * as them, with the commit they looked at; Fix checks and Resolve are asked of the agent as their
 * message in the thread, once for a commit. Merge asks first (`confirm`, a native action sheet),
 * and goes out with the commit the question was asked about: a push meanwhile is refused by the
 * API (`head_moved`), not merged. One press at a time: a second while one is on its way,
 * the confirmation still up included, does nothing, so a double tap merges once.
 */
export class PrActions {
  private state: PrActionsState = { busy: null, failed: null, asked: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      /** Does it through the API; the answer is the whole tab. */
      act(request: PullRequestAction): Promise<PullRequestTab>;
      /** Says it to the agent, as the person's message in the thread. */
      tell(text: string): Promise<void>;
      /** Asks the person before a merge; true to go ahead. */
      confirm(question: string): Promise<boolean>;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PrActionsState => this.state;

  /**
   * Presses `action` on the pull request `tab` shows. Resolves once it is done (`done`), didn't
   * happen (`failed`, its reason in `failed`), or nothing went (`none`: a press while another is
   * on its way, Cancel, an ask already made, or an action the phone never offers).
   */
  async run(action: NextAction, tab: PullRequestTab): Promise<PrRun> {
    const pr = tab.pullRequest;
    if (this.state.busy || !pr) return "none";
    switch (action) {
      case "ready":
        return this.act(action, { kind: "ready" });
      case "auto_merge":
        return this.act(action, { kind: "auto_merge", on: true });
      case "update_branch":
        return this.act(action, { kind: "update_branch", headSha: pr.head.sha });
      case "merge": {
        const headSha = pr.head.sha;
        this.set({ busy: action, failed: null });
        let go = false;
        try {
          go = await this.deps.confirm(PR.confirm(pr.number, pr.base.ref));
        } catch {
          go = false;
        }
        if (!go) {
          this.set({ busy: null });
          return "none";
        }
        return this.act(action, { kind: "merge", headSha }, true);
      }
      case "fix_checks":
      case "resolve": {
        if (isAsked(this.state.asked, action, pr)) return "none";
        this.set({ busy: action, failed: null });
        try {
          await this.deps.tell(agentAsk(action, tab));
          this.set({ busy: null, asked: { action, headSha: pr.head.sha } });
          return "done";
        } catch (error) {
          this.set({ busy: null, failed: actionFailed(error) });
          return "failed";
        }
      }
      // Create PR is the Mac's; a merge past the rules is never offered here; Auto-merge on waits.
      case "create_pr":
      case "blocked":
      case "auto_merge_on":
        return "none";
    }
  }

  private async act(action: NextAction, request: PullRequestAction, held = false): Promise<PrRun> {
    if (!held) this.set({ busy: action, failed: null });
    try {
      await this.deps.act(request);
      this.set({ busy: null });
      return "done";
    } catch (error) {
      this.set({ busy: null, failed: actionFailed(error) });
      return "failed";
    }
  }

  private set(change: Partial<PrActionsState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
