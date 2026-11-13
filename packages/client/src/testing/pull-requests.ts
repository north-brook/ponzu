import type { PullRequestFile, PullRequestTab } from "../api.ts";
import { ApiError } from "../errors.ts";

/*
 * A canvas's branch and pull request, in memory, as the API answers about them
 * (apps/api/src/pull-requests): the tab, its `nextAction`, and the actions with the refusals
 * they name before GitHub hears of them. GitHub's side is played by hand: `push` commits to the
 * branch, `setChecks`, `review`, `comment`, `conflict` and `protect` change what GitHub says.
 */

type Tab = PullRequestTab;
type Pull = NonNullable<Tab["pullRequest"]>;
type Check = Pull["checks"]["items"][number];
type Who = NonNullable<Pull["author"]>;
type FileChange = Pull["files"]["items"][number]["change"];

export interface FakeCheckInput {
  name: string;
  state: Check["state"];
  /** The repo's rules want it to pass. */
  required?: boolean;
}

export interface FakeFileInput {
  path: string;
  change?: FileChange;
  additions?: number;
  deletions?: number;
  /** The unified diff; null for a binary file. */
  patch?: string | null;
  /** Where a renamed file was. */
  previousPath?: string | null;
}

interface FakePull {
  number: number;
  title: string;
  body: string;
  state: Pull["state"];
  headSha: string;
  author: Who;
  mergedBy: Who | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  autoMerge: boolean;
  checks: Check[];
  reviews: Pull["reviews"];
  conversation: Pull["conversation"];
}

/** What a merge or an opening tells the canvas: a notice for its thread, a settling. */
export interface PullRequestEvents {
  notice(number: number, url: string, title: string, state: Pull["state"]): void;
  merged(): void;
  changed(): void;
}

/** The merge states in which nothing is left for the repo's rules to want. */
const MERGEABLE_NOW: Pull["mergeState"][] = ["clean", "unstable", "has_hooks"];
let pullNumbers = 400;

export class FakePullRequests {
  /** Its commits, newest last, as shas; empty until something is pushed. */
  private commits: string[] = [];
  private baseMoved = 0;
  private files: Required<FakeFileInput>[] = [];
  private pull: FakePull | null = null;
  private conflicting = false;
  /** What the repo's rules want before a merge. */
  rules = { review: false, upToDate: false };
  /** Commits only the canvas's sandbox holds, as its runner said, and why their push failed. */
  private unpushed: FakeFileInput[][] = [];
  private pushError: string | null = null;
  /** How many times Create PR asked the sandbox to push. */
  pushesAsked = 0;
  autoMergeAllowed = true;
  /** The agent's kept words on what the branch changes (`describe`). */
  private summary: string | null = null;

  constructor(
    private readonly repo: string,
    private readonly branch: string,
    private readonly now: () => string,
    private readonly events: PullRequestEvents,
  ) {}

  /* ---------------------------------------------------------------- */
  /* GitHub, played by hand                                            */
  /* ---------------------------------------------------------------- */

  /**
   * A commit the agent made that only its sandbox holds: GitHub lacks it until `landPush`. With
   * `error`, the runner's last push of it failed, saying so.
   */
  commitUnpushed(files: FakeFileInput[] = [{ path: "src/app.tsx" }], error: string | null = null) {
    this.unpushed.push(files);
    this.pushError = error;
    this.events.changed();
  }

  /** The runner's push of what only the sandbox held reached GitHub. */
  landPush(): void {
    const commits = this.unpushed.splice(0);
    this.pushError = null;
    for (const files of commits) this.push(files);
  }

  /** The runner's push failed, and it said why. */
  failPush(error: string): void {
    this.pushError = error;
    this.events.changed();
  }

  /** The agent keeps its words on what the branch changes, as `describe_pull_request` does. */
  describe(summary: string): void {
    this.summary = summary;
    const pull = this.pull;
    if (pull && (pull.state === "open" || pull.state === "draft")) pull.body = summary;
    this.events.changed();
  }

  /** Commits to the branch, as the agent's pushes do, changing these files. */
  push(files: FakeFileInput[] = [{ path: "src/app.tsx" }]): string {
    const sha = (this.commits.length + 1).toString(16).padStart(40, "a");
    this.commits.push(sha);
    for (const file of files) {
      const changed: Required<FakeFileInput> = {
        change: "modified",
        additions: 1,
        deletions: 0,
        patch: `@@ -1 +1,${1 + (file.additions ?? 1)} @@\n context\n+${file.path}`,
        previousPath: null,
        ...file,
      };
      this.files = [...this.files.filter((f) => f.path !== file.path), changed];
    }
    if (this.pull && this.pull.state !== "merged") {
      this.pull.headSha = sha;
      this.pull.checks = this.pull.checks.map((check) => ({ ...check, state: "pending" }));
    }
    this.events.changed();
    return sha;
  }

  setChecks(checks: FakeCheckInput[]): void {
    this.open$().checks = checks.map((check) => ({
      name: check.name,
      app: "GitHub Actions",
      required: check.required ?? false,
      state: check.state,
      url: `https://ci.example/${encodeURIComponent(check.name)}`,
      startedAt: this.now(),
      completedAt: check.state === "pending" || check.state === "running" ? null : this.now(),
    }));
    this.events.changed();
  }

  review(login: string, state: "approved" | "changes_requested"): void {
    const pull = this.open$();
    const at = this.now();
    pull.reviews = [
      ...pull.reviews.filter((r) => r.author?.login !== login),
      { id: `rv_${pull.reviews.length + 1}`, author: who(login), state, at, url: this.url() },
    ];
    this.events.changed();
  }

  comment(login: string, body: string, where: { path?: string; line?: number } = {}): void {
    const pull = this.open$();
    pull.conversation = [
      ...pull.conversation,
      {
        id: `ic_${pull.conversation.length + 1}`,
        author: who(login),
        body,
        at: this.now(),
        url: this.url(),
        path: where.path ?? null,
        line: where.line ?? null,
      },
    ];
    this.events.changed();
  }

  /** The base moved under the branch: it is behind, and maybe conflicts with it. */
  baseChanged({ conflicts = false } = {}): void {
    this.baseMoved++;
    this.conflicting = conflicts;
    this.events.changed();
  }

  protect(rules: Partial<FakePullRequests["rules"]>): void {
    this.rules = { ...this.rules, ...rules };
    this.events.changed();
  }

  /* ---------------------------------------------------------------- */
  /* What the API answers                                              */
  /* ---------------------------------------------------------------- */

  /** The canvas's row's columns, as a read records them. */
  get row() {
    const pull = this.pull;
    return {
      prNumber: pull?.number ?? null,
      prState: pull?.state ?? null,
      prChecks: pull ? rollup(pull.checks) : ("none" as const),
      prMergeable: pull ? this.mergeable() : null,
      prAutoMerge: pull?.autoMerge ?? false,
    };
  }

  /** The pull request's number, title and state, as search indexes it; null before one opens. */
  get titled(): { number: number; title: string; state: Pull["state"] } | null {
    const pull = this.pull;
    return pull ? { number: pull.number, title: pull.title, state: pull.state } : null;
  }

  tab(): Tab {
    const exists = this.commits.length > 0;
    const pull = this.pull;
    const open = pull?.state === "open" || pull?.state === "draft";
    return {
      branch: {
        name: this.branch,
        base: "main",
        exists,
        aheadBy: this.aheadBy(),
        behindBy: this.baseMoved,
        unpushed: this.unpushed.length,
        pushError: this.pushError,
      },
      pullRequest: pull && this.view(pull),
      // As the API answers it: the kept words, while no pull request is open.
      summary: open || !this.summary?.trim() ? null : this.summary,
      mergeMethod: "squash",
      autoMergeAllowed: this.autoMergeAllowed,
      nextAction: this.nextAction(),
    };
  }

  file(path: string): PullRequestFile {
    const file = this.files.find((f) => f.path === path);
    if (!this.pull || !file) {
      throw new ApiError(404, "not_found", "The pull request changes no such file.");
    }
    return {
      path: file.path,
      previousPath: file.previousPath,
      change: file.change,
      additions: file.additions,
      deletions: file.deletions,
      diff: file.patch === null ? { kind: "binary" } : { kind: "text", patch: file.patch },
    };
  }

  /**
   * A draft by `author`, titled with the canvas's name. Commits only the sandbox holds are asked
   * for first; with nothing on GitHub to open it from yet, the answer says the push is under way.
   */
  open(author: string, title: string): { tab: Tab; opened: boolean; pushing?: boolean } {
    if (this.pull && this.pull.state !== "closed" && this.nextAction() !== "create_pr") {
      return { tab: this.tab(), opened: false };
    }
    if (this.unpushed.length) {
      // A new try: what the last push said is moot until the runner says how this one went.
      this.pushesAsked++;
      this.pushError = null;
    }
    if (this.unpushed.length && !this.aheadBy()) {
      return { tab: this.tab(), opened: false, pushing: true };
    }
    if (!this.commits.length) {
      throw new ApiError(
        409,
        "branch_not_pushed",
        `Nothing has been pushed to ${this.branch} yet.`,
      );
    }
    if (!this.aheadBy()) {
      throw new ApiError(
        409,
        "no_changes",
        `${this.branch} has no commits that main does not have.`,
      );
    }
    const at = this.now();
    this.pull = {
      number: ++pullNumbers,
      title,
      body: this.summary ?? "",
      state: "draft",
      headSha: this.commits.at(-1)!,
      author: who(author),
      mergedBy: null,
      createdAt: at,
      updatedAt: at,
      mergedAt: null,
      closedAt: null,
      autoMerge: false,
      checks: [],
      reviews: [],
      conversation: [],
    };
    this.say("draft");
    return { tab: this.tab(), opened: true };
  }

  ready(): Tab {
    const pull = this.current();
    if (pull.state === "draft") {
      pull.state = "open";
      this.touched();
    } else if (pull.state !== "open") throw closed(pull);
    return this.tab();
  }

  merge(login: string, headSha: string, bypass: boolean): Tab {
    const pull = this.current();
    if (pull.state === "merged") return this.tab();
    if (pull.state === "closed") throw closed(pull);
    if (pull.state === "draft") throw draft();
    if (headSha !== pull.headSha) throw headMoved();
    if (this.conflicting) throw this.conflicts();
    if (!bypass && !MERGEABLE_NOW.includes(this.mergeState())) throw this.blockedBy();
    pull.state = "merged";
    pull.autoMerge = false;
    pull.mergedBy = who(login);
    pull.mergedAt = this.now();
    this.baseMoved = 0;
    this.say("merged");
    this.events.merged();
    return this.tab();
  }

  autoMerge(on: boolean): Tab {
    const pull = this.current();
    if (pull.state === "merged" || pull.state === "closed") throw closed(pull);
    if (on && !pull.autoMerge) {
      if (pull.state === "draft") throw draft();
      if (!this.autoMergeAllowed) {
        throw new ApiError(
          409,
          "auto_merge_not_allowed",
          `${this.repo} does not allow auto-merge.`,
        );
      }
      if (this.conflicting) throw this.conflicts();
      if (MERGEABLE_NOW.includes(this.mergeState())) {
        throw new ApiError(409, "already_mergeable", "Nothing is left to wait for: merge it now.");
      }
    }
    pull.autoMerge = on;
    this.touched();
    return this.tab();
  }

  close(number?: number): Tab {
    const pull = this.current();
    if (number !== undefined && number !== pull.number) {
      throw new ApiError(
        409,
        "pull_request_changed",
        `This canvas's pull request is #${pull.number} now, not #${number}. Look again first.`,
      );
    }
    if (pull.state === "merged") throw closed(pull);
    if (pull.state !== "closed") {
      pull.state = "closed";
      pull.closedAt = this.now();
      this.say("closed");
    }
    return this.tab();
  }

  updateBranch(headSha: string): Tab {
    const pull = this.current();
    if (pull.state === "merged" || pull.state === "closed") throw closed(pull);
    if (!this.baseMoved) {
      throw new ApiError(
        409,
        "branch_up_to_date",
        `${this.branch} already has everything in main.`,
      );
    }
    if (headSha !== pull.headSha) throw headMoved();
    if (this.conflicting) throw this.conflicts();
    this.baseMoved = 0;
    this.push([]);
    return this.tab();
  }

  /* ---------------------------------------------------------------- */
  /* The API's rules                                                   */
  /* ---------------------------------------------------------------- */

  /** As `nextAction` in apps/api/src/pull-requests/view.ts. */
  private nextAction(): Tab["nextAction"] {
    const pull = this.pull;
    const unpushed = this.unpushed.length > 0;
    if (!pull || pull.state === "closed") {
      return this.aheadBy() > 0 || unpushed ? "create_pr" : "none";
    }
    if (pull.state === "merged") {
      const since = this.commits.at(-1) !== pull.headSha && this.aheadBy() > 0;
      return since || unpushed ? "create_pr" : "none";
    }
    if (pull.state === "draft") return "ready";
    if (this.conflicting) return "resolve";
    const checks = rollup(pull.checks);
    if (checks === "failing") return "fix_checks";
    if (checks === "running" && this.autoMergeAllowed) return "auto_merge";
    const state = this.mergeState();
    if (state === "behind") return "update_branch";
    if (state === "blocked") return this.autoMergeAllowed ? "auto_merge" : "blocked";
    return "merge";
  }

  private mergeState(): Pull["mergeState"] {
    const pull = this.pull!;
    if (pull.state === "draft") return "draft";
    if (this.conflicting) return "dirty";
    if (this.rules.upToDate && this.baseMoved) return "behind";
    const required = pull.checks.filter((check) => check.required);
    const unmet = required.some((check) => check.state !== "passed" && check.state !== "skipped");
    if (unmet || (this.rules.review && this.reviewDecision() !== "approved")) return "blocked";
    return rollup(pull.checks) === "failing" ? "unstable" : "clean";
  }

  private reviewDecision(): Pull["reviewDecision"] {
    const reviews = this.pull?.reviews ?? [];
    if (reviews.some((r) => r.state === "changes_requested")) return "changes_requested";
    if (reviews.some((r) => r.state === "approved")) return "approved";
    return this.rules.review ? "review_required" : null;
  }

  private blockedBy(): ApiError {
    const pull = this.pull!;
    if (this.mergeState() === "behind") {
      return new ApiError(409, "branch_behind", `The repo's rules want ${this.branch} up to date.`);
    }
    const decision = this.reviewDecision();
    if (decision === "changes_requested") {
      return new ApiError(409, "changes_requested", "A reviewer asked for changes.");
    }
    if (decision === "review_required") {
      return new ApiError(
        409,
        "review_required",
        "The repo's rules want an approving review first.",
      );
    }
    const required = pull.checks.filter((check) => check.required);
    if (required.some((check) => check.state === "failed" || check.state === "cancelled")) {
      return new ApiError(409, "checks_failing", "A check the repo's rules require failed.");
    }
    return new ApiError(
      409,
      "checks_pending",
      "Checks the repo's rules require have not finished yet.",
    );
  }

  private view(pull: FakePull): Pull {
    const additions = this.files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = this.files.reduce((sum, f) => sum + f.deletions, 0);
    return {
      number: pull.number,
      url: this.url(),
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: this.branch, sha: pull.headSha },
      base: { ref: "main" },
      author: pull.author,
      mergedBy: pull.mergedBy,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      mergedAt: pull.mergedAt,
      closedAt: pull.closedAt,
      mergeable: this.mergeable(),
      mergeState: this.mergeState(),
      reviewDecision: this.reviewDecision(),
      autoMerge: pull.autoMerge ? { method: "squash", enabledBy: pull.author } : null,
      checks: { state: rollup(pull.checks), items: pull.checks, complete: true },
      reviews: pull.reviews,
      conversation: pull.conversation,
      files: {
        total: this.files.length,
        additions,
        deletions,
        items: this.files.map(({ path, change, additions, deletions }) => ({
          path,
          change,
          additions,
          deletions,
        })),
      },
      commits: {
        total: this.commits.length,
        items: this.commits.map((sha) => ({
          sha,
          message: "Work",
          at: pull.createdAt,
          author: null,
        })),
      },
    };
  }

  private mergeable(): boolean | null {
    const pull = this.pull;
    if (!pull || pull.state === "merged" || pull.state === "closed") return null;
    return !this.conflicting;
  }

  private aheadBy(): number {
    const pull = this.pull;
    if (pull?.state === "merged") {
      return this.commits.length - 1 - this.commits.indexOf(pull.headSha);
    }
    return this.commits.length;
  }

  private current(): FakePull {
    if (!this.pull) {
      throw new ApiError(409, "no_pull_request", "This canvas has no pull request yet.");
    }
    return this.pull;
  }

  /** The pull request a test shapes: one must be open. */
  private open$(): FakePull {
    if (!this.pull) throw new Error("Open the pull request first.");
    return this.pull;
  }

  private conflicts(): ApiError {
    return new ApiError(409, "merge_conflicts", `${this.branch} conflicts with main.`);
  }

  private url(): string {
    return `https://github.com/${this.repo}/pull/${this.pull?.number ?? 0}`;
  }

  private touched(): void {
    if (this.pull) this.pull.updatedAt = this.now();
    this.events.changed();
  }

  /** Each opening, merging and closing is said in the thread once, as the API does. */
  private say(state: Pull["state"]): void {
    const pull = this.pull!;
    this.touched();
    this.events.notice(pull.number, this.url(), pull.title, state);
  }
}

/** Whether checks pass, as GitHub's rollup of check runs and statuses says. */
function rollup(checks: Check[]): Pull["checks"]["state"] {
  if (!checks.length) return "none";
  if (checks.some((c) => c.state === "failed" || c.state === "cancelled")) return "failing";
  if (checks.some((c) => c.state === "pending" || c.state === "running")) return "running";
  return "passing";
}

function who(login: string): Who {
  return { login, avatarUrl: null, bot: false, ponzu: false };
}

const closed = (pull: FakePull) =>
  new ApiError(409, "pull_request_closed", `#${pull.number} is ${pull.state}.`);
const draft = () =>
  new ApiError(409, "pull_request_draft", "This pull request is a draft. Mark it ready first.");
const headMoved = () =>
  new ApiError(409, "head_moved", "The branch has new commits since you looked. Look again first.");
