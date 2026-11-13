import type { Clock } from "@ponzu/sandbox";

/*
 * Branches and pull requests, in memory, behind the fake GitHub: what the API's pull request
 * calls reach. It answers the GraphQL operations the API sends by name, in the shape their
 * queries ask for, and the REST routes it uses, and it follows what the github-app spike
 * recorded of the real one: `mergeable` is unknown for a few seconds after a push or a change
 * to the base, a merge or a branch update names the commit it expects the head to be at, an
 * open pull request from a branch is the only one, and an installation token does only what its
 * permissions say.
 *
 * Tests shape it with `push`, `setChecks`, `review`, `comment`, `protect`, `lagHead` and
 * `conflicting`, and read what happened from `pull` and `actions`.
 */

/** How long after a change GitHub takes to work out whether a pull request can merge. */
export const MERGEABLE_AFTER_MS = 5_000;

export interface FakeFile {
  path: string;
  additions: number;
  deletions: number;
  /** Null for a binary file, as GitHub gives none. */
  patch?: string | null;
}

export interface FakeCheck {
  name: string;
  /** A commit status instead of a check run. */
  status?: boolean;
  state: "queued" | "in_progress" | "success" | "failure" | "skipped";
  /** Its link; `https://ci.example/<name>` when left out. */
  url?: string;
}

export interface FakePull {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  head: string;
  base: string;
  /** The repository the head branch is in: another one for a fork. */
  headRepositoryId: number;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  /** The commits a merge took into the base. */
  mergedShas: string[];
  /** The commit the branch was at when it merged. */
  mergedHead: string | null;
  mergedBy: string | null;
  author: { login: string; bot: boolean };
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  autoMerge: { method: string; enabledBy: string } | null;
  /** When GitHub will have worked out whether it can merge. */
  mergeableAt: number;
  /** The commit GitHub still shows it at, until when, as it does for a moment after a push. */
  shownHead: { sha: string; until: number } | null;
  conflicting: boolean;
  /** Its entry in the base's merge queue (GitHub's `MergeQueueEntryState`), while it has one. */
  queue: { state: "QUEUED" | "AWAITING_CHECKS" | "MERGEABLE" | "UNMERGEABLE" | "LOCKED" } | null;
  reviews: { id: string; login: string; state: string; body: string; at: number }[];
  comments: {
    id: string;
    login: string;
    body: string;
    at: number;
    path?: string;
    line?: number;
    /** For a line comment: its thread was marked resolved. */
    resolved?: boolean;
  }[];
}

export interface FakeRules {
  requiredApprovals?: number;
  requiredChecks?: string[];
  /** The branch must be up to date with its base. */
  strict?: boolean;
  /** Who may merge whatever the rules still want, as an admin or a ruleset's bypass list. */
  bypass?: string[];
}

/** Who a request came from: an installation token with its permissions, or a person. */
export type FakeCaller =
  | {
      kind: "app";
      installationId: number;
      repositoryIds: number[] | null;
      permissions: Record<string, string>;
    }
  | { kind: "user"; id: number; login: string };

/** A repository as the fake GitHub has it, and whether a person may push to it. */
export interface FakeRepoAccess {
  id: number;
  fullName: string;
  installationId: number;
  defaultBranch: string;
  canPush(userId: number): boolean;
}

interface Repo {
  fullName: string;
  branches: Map<string, string[]>;
  pulls: FakePull[];
  settings: {
    squash: boolean;
    merge: boolean;
    rebase: boolean;
    autoMerge: boolean;
    /** The default branch's rules send every merge through a merge queue. */
    mergeQueue: boolean;
    /**
     * Ponzu's App has no `workflows` permission and the default branch has a workflow file the
     * canvas's branch lacks: an update of the branch is refused in GitHub's words for it.
     */
    workflowRefused: boolean;
    /**
     * GitHub refuses the merge queue's fields to Ponzu's App (no "Merge queues" permission): the
     * tab query answers the rest, with an error for each of those.
     */
    mergeQueueUnreadable: boolean;
  };
  /** Branch protection, by the branch protected. */
  rules: Map<string, FakeRules>;
  /** Private repos on a free plan have no drafts. */
  draftsUnsupported: boolean;
}

interface Commit {
  sha: string;
  message: string;
  at: number;
  author: string;
  files: FakeFile[];
}

const READ_PULLS = ["read", "write"];

export class FakePullRequests {
  /** What was done to pull requests, and by whom (`app`, or a person's login). */
  readonly actions: { kind: string; number: number; by: string }[] = [];
  readonly botLogin = "ponzu-test";
  /** How many GraphQL requests it answered. */
  queries = 0;
  /**
   * How many of a pull request's newest review threads GraphQL answers for, as the query's
   * `reviewThreads(last: 100)` caps them, while its reviews can hold line comments of more.
   */
  threadsShown = 100;
  /** How long GraphQL goes on showing a merged pull request open (`hideMerges`). */
  #mergesHiddenMs = 0;

  readonly #clock: Clock;
  readonly #repos = new Map<number, Repo>();
  readonly #commits = new Map<string, Commit>();
  #next = 1;

  /** A person's GitHub id by their login, for the fake GitHub's accounts. */
  readonly #idOf: (login: string) => number | undefined;

  constructor(clock: Clock, idOf: (login: string) => number | undefined = () => undefined) {
    this.#clock = clock;
    this.#idOf = idOf;
  }

  /**
   * A new commit on `branch` changing `files`, the branch made from the default branch first
   * if it is new. Answers its sha. Every open pull request it is the head or base of is worked
   * out again.
   */
  push(
    repo: FakeRepoAccess,
    branch: string,
    {
      files = [{ path: "README.md", additions: 1, deletions: 0 }],
      message = "Change",
    }: { files?: FakeFile[]; message?: string } = {},
  ): string {
    const state = this.#repo(repo);
    const commits = state.branches.get(branch) ?? [...this.#branch(repo, repo.defaultBranch)];
    const sha = this.#sha();
    this.#commits.set(sha, { sha, message, at: this.#clock.now(), author: "maya", files });
    state.branches.set(branch, [...commits, sha]);
    for (const pull of state.pulls) {
      if (pull.state === "open" && (pull.head === branch || pull.base === branch)) {
        pull.mergeableAt = this.#clock.now() + MERGEABLE_AFTER_MS;
        if (pull.head === branch) pull.updatedAt = this.#clock.now();
      }
    }
    return sha;
  }

  /** The commit a branch is at, or undefined when it does not exist. */
  head(repo: FakeRepoAccess, branch: string): string | undefined {
    return this.#repo(repo).branches.get(branch)?.at(-1);
  }

  /** A branch at the default branch's head, with nothing of its own. */
  createBranch(repo: FakeRepoAccess, branch: string): void {
    this.#repo(repo).branches.set(branch, [...this.#branch(repo, repo.defaultBranch)]);
  }

  setChecks(sha: string, checks: FakeCheck[]): void {
    this.#checks.set(sha, checks);
  }

  review(
    pull: FakePull,
    login: string,
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
    body = "",
  ) {
    pull.reviews.push({ id: this.#id("PRR"), login, state, body, at: this.#clock.now() });
  }

  comment(pull: FakePull, login: string, body: string, at?: { path: string; line: number }) {
    const id = this.#id("IC");
    pull.comments.push({ id, login, body, at: this.#clock.now(), ...at });
    return id;
  }

  /** Marks a line comment's thread resolved, as someone does on GitHub. */
  resolve(pull: FakePull, commentId: string): void {
    const comment = pull.comments.find((c) => c.id === commentId);
    if (!comment?.path) throw new Error(`The fake GitHub has no line comment ${commentId}.`);
    comment.resolved = true;
  }

  /**
   * GitHub goes on showing the pull request at the commit it is at now for `ms`, whatever is
   * pushed meanwhile.
   */
  lagHead(repo: FakeRepoAccess, pull: FakePull, ms: number): void {
    const sha = this.head(repo, pull.head)!;
    pull.shownHead = { sha, until: this.#clock.now() + ms };
  }

  #mergedFirstBy: string | null = null;

  /** The next merge asked for finds `login` merged the pull request a moment before it. */
  mergeFirstAs(login: string): void {
    this.#mergedFirstBy = login;
  }

  #mergedBeforeCloseBy: string | null = null;

  /**
   * The next close asked for finds the pull request merged a moment before it, as auto-merge
   * landing does, with `login` the person who turned auto-merge on.
   */
  mergeBeforeCloseAs(login: string): void {
    this.#mergedBeforeCloseBy = login;
  }

  /** GraphQL goes on showing a pull request open for `ms` after it merges, as a replica lags. */
  hideMerges(ms: number): void {
    this.#mergesHiddenMs = ms;
  }

  protect(repo: FakeRepoAccess, branch: string, rules: FakeRules): void {
    this.#repo(repo).rules.set(branch, rules);
  }

  settings(
    repo: FakeRepoAccess,
    settings: Partial<Repo["settings"]> & { draftsUnsupported?: boolean },
  ) {
    const state = this.#repo(repo);
    const { draftsUnsupported, ...rest } = settings;
    Object.assign(state.settings, rest);
    if (draftsUnsupported !== undefined) state.draftsUnsupported = draftsUnsupported;
  }

  /** A pull request someone opened on GitHub, not Ponzu. */
  openAsSomeone(
    repo: FakeRepoAccess,
    input: {
      head: string;
      base?: string;
      login: string;
      draft?: boolean;
      headRepositoryId?: number;
    },
  ): FakePull {
    return this.#open(repo, {
      head: input.head,
      base: input.base ?? repo.defaultBranch,
      title: `From ${input.login}`,
      body: "",
      draft: input.draft ?? false,
      author: { login: input.login, bot: false },
      headRepositoryId: input.headRepositoryId ?? repo.id,
    });
  }

  /** A pull request of the repository, by number. */
  pull(repo: FakeRepoAccess, number: number): FakePull {
    const pull = this.#repo(repo).pulls.find((candidate) => candidate.number === number);
    if (!pull) throw new Error(`The fake GitHub has no pull request #${number}.`);
    return pull;
  }

  /** The newest pull request of the repository, if it has one. */
  latest(repo: FakeRepoAccess): FakePull | undefined {
    return this.#repo(repo).pulls.at(-1);
  }

  /**
   * Answers a request about branches or pull requests, or null when it is not one: GraphQL, and
   * `/repos/{owner}/{name}/pulls…`.
   */
  serve(
    caller: FakeCaller,
    method: string,
    url: URL,
    body: unknown,
    find: (fullName: string) => FakeRepoAccess | undefined,
  ): Response | null {
    if (method === "POST" && url.pathname === "/graphql") {
      const { query, variables } = body as { query: string; variables: Record<string, any> };
      this.queries++;
      return this.#graphql(caller, query, variables, find);
    }
    // Octokit sends the ref escaped, slashes and all, as GitHub takes it.
    const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (method === "DELETE" && ref) {
      const repo = find(ref[1]!);
      if (!repo || !this.#reaches(caller, repo)) return notFound();
      if (caller.kind !== "user" || !repo.canPush(caller.id)) return forbidden();
      const branch = ref[2]!;
      if (!this.#repo(repo).branches.delete(branch)) {
        return Response.json({ message: "Reference does not exist" }, { status: 422 });
      }
      return new Response(null, { status: 204 });
    }
    const route =
      /^\/repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?(\/merge|\/update-branch|\/files)?$/.exec(
        url.pathname,
      );
    if (!route) return null;
    const repo = find(route[1]!);
    if (!repo || !this.#reaches(caller, repo)) return notFound();
    const number = route[2] ? Number(route[2]) : null;
    const pull =
      number === null ? undefined : this.#repo(repo).pulls.find((p) => p.number === number);
    if (number !== null && !pull) return notFound();
    const input = (body ?? {}) as Record<string, any>;

    if (method === "POST" && number === null) return this.#create(caller, repo, input);
    if (!pull) return notFound();
    if (method === "PATCH" && !route[3]) return this.#edit(caller, repo, pull, input);
    if (method === "PUT" && route[3] === "/merge") return this.#merge(caller, repo, pull, input);
    if (method === "PUT" && route[3] === "/update-branch") {
      return this.#updateBranch(caller, repo, pull, input);
    }
    if (method === "GET" && route[3] === "/files") {
      if (!this.#may(caller, "pull_requests", READ_PULLS)) return forbidden();
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("per_page") ?? 30);
      const files = this.#files(repo, pull).slice((page - 1) * size, page * size);
      return Response.json(
        files.map((file) => ({
          filename: file.path,
          status: file.change,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.patch === null ? {} : { patch: file.patch }),
        })),
      );
    }
    return notFound();
  }

  readonly #checks = new Map<string, FakeCheck[]>();

  #repo(repo: FakeRepoAccess): Repo {
    let state = this.#repos.get(repo.id);
    if (!state) {
      const root = this.#sha();
      this.#commits.set(root, { sha: root, message: "Initial", at: 0, author: "maya", files: [] });
      state = {
        fullName: repo.fullName,
        branches: new Map([[repo.defaultBranch, [root]]]),
        pulls: [],
        settings: {
          squash: true,
          merge: true,
          rebase: true,
          autoMerge: false,
          mergeQueue: false,
          workflowRefused: false,
          mergeQueueUnreadable: false,
        },
        rules: new Map(),
        draftsUnsupported: false,
      };
      this.#repos.set(repo.id, state);
    }
    return state;
  }

  #branch(repo: FakeRepoAccess, name: string): string[] {
    return this.#repo(repo).branches.get(name) ?? [];
  }

  #reaches(caller: FakeCaller, repo: FakeRepoAccess): boolean {
    if (caller.kind === "user") return true;
    return (
      caller.installationId === repo.installationId &&
      (caller.repositoryIds === null || caller.repositoryIds.includes(repo.id))
    );
  }

  /** Whether an installation token carries `permission` at one of `levels`. A person may anything. */
  #may(caller: FakeCaller, permission: string, levels: string[]): boolean {
    return caller.kind === "user" || levels.includes(caller.permissions[permission] ?? "");
  }

  /** Commits on `head` that `base` lacks, and the other way about. */
  #compare(repo: FakeRepoAccess, base: string, head: string) {
    const baseCommits = this.#branch(repo, base);
    const headCommits = this.#branch(repo, head);
    return {
      ahead: headCommits.filter((sha) => !baseCommits.includes(sha)),
      behind: baseCommits.filter((sha) => !headCommits.includes(sha)),
    };
  }

  #files(repo: FakeRepoAccess, pull: FakePull) {
    const shas = pull.merged ? pull.mergedShas : this.#compare(repo, pull.base, pull.head).ahead;
    const byPath = new Map<string, FakeFile & { change: string; patch: string | null }>();
    for (const sha of shas ?? []) {
      for (const file of this.#commits.get(sha)?.files ?? []) {
        byPath.set(file.path, {
          ...file,
          change: file.deletions > 0 && file.additions === 0 ? "removed" : "modified",
          patch: file.patch === undefined ? `@@ -1 +1 @@\n+${file.path}` : file.patch,
        });
      }
    }
    return [...byPath.values()];
  }

  #mergeable(pull: FakePull): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
    if (pull.state !== "open") return pull.merged ? "MERGEABLE" : "UNKNOWN";
    if (this.#clock.now() < pull.mergeableAt) return "UNKNOWN";
    return pull.conflicting ? "CONFLICTING" : "MERGEABLE";
  }

  #rollup(sha: string | undefined): { state: string; checks: FakeCheck[] } | null {
    const checks = sha ? (this.#checks.get(sha) ?? []) : [];
    if (checks.length === 0) return null;
    const state = checks.some((check) => check.state === "failure")
      ? "FAILURE"
      : checks.some((check) => check.state === "queued" || check.state === "in_progress")
        ? "PENDING"
        : "SUCCESS";
    return { state, checks };
  }

  #reviewDecision(repo: FakeRepoAccess, pull: FakePull): string | null {
    const rules = this.#repo(repo).rules.get(pull.base);
    if (!rules?.requiredApprovals) return null;
    if (pull.reviews.some((review) => review.state === "CHANGES_REQUESTED")) {
      return "CHANGES_REQUESTED";
    }
    const approvals = pull.reviews.filter((review) => review.state === "APPROVED").length;
    return approvals >= rules.requiredApprovals ? "APPROVED" : "REVIEW_REQUIRED";
  }

  /**
   * What the rules of the pull request's base still want before it merges: the merge state it
   * makes, and GitHub's words for it when a merge is refused.
   */
  #wanted(
    repo: FakeRepoAccess,
    pull: FakePull,
  ): { state: "BEHIND" | "BLOCKED"; message: string } | null {
    const rules = this.#repo(repo).rules.get(pull.base) ?? {};
    const blocked = (message: string) => ({ state: "BLOCKED" as const, message });
    if (rules.strict && this.#compare(repo, pull.base, pull.head).behind.length > 0) {
      return { state: "BEHIND", message: "Head branch is not up to date with the base branch." };
    }
    const decision = this.#reviewDecision(repo, pull);
    if (decision === "CHANGES_REQUESTED") return blocked("Changes requested by a reviewer.");
    if (decision === "REVIEW_REQUIRED") {
      return blocked(
        `At least ${rules.requiredApprovals} approving review is required by reviewers with write access.`,
      );
    }
    const checks = this.#rollup(this.head(repo, pull.head))?.checks ?? [];
    for (const name of rules.requiredChecks ?? []) {
      const check = checks.find((candidate) => candidate.name === name);
      if (!check || check.state === "queued" || check.state === "in_progress") {
        return blocked(`Required status check "${name}" is expected.`);
      }
      if (check.state !== "success") return blocked(`Required status check "${name}" is failing.`);
    }
    return null;
  }

  #mergeState(repo: FakeRepoAccess, pull: FakePull): string {
    if (pull.state !== "open") return "UNKNOWN";
    if (pull.draft) return "DRAFT";
    const mergeable = this.#mergeable(pull);
    if (mergeable === "UNKNOWN") return "UNKNOWN";
    if (mergeable === "CONFLICTING") return "DIRTY";
    const wanted = this.#wanted(repo, pull);
    if (wanted) return wanted.state;
    const checks = this.#rollup(this.head(repo, pull.head))?.checks ?? [];
    if (checks.some((check) => check.state === "failure")) return "UNSTABLE";
    return "CLEAN";
  }

  #open(
    repo: FakeRepoAccess,
    input: Pick<
      FakePull,
      "head" | "base" | "title" | "body" | "draft" | "author" | "headRepositoryId"
    >,
  ): FakePull {
    const now = this.#clock.now();
    const state = this.#repo(repo);
    const pull: FakePull = {
      ...input,
      number: state.pulls.length + 1,
      nodeId: this.#id("PR"),
      state: "open",
      merged: false,
      mergedShas: [],
      mergedHead: null,
      mergedBy: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      autoMerge: null,
      mergeableAt: now + MERGEABLE_AFTER_MS,
      shownHead: null,
      conflicting: false,
      queue: null,
      reviews: [],
      comments: [],
    };
    state.pulls.push(pull);
    return pull;
  }

  #create(caller: FakeCaller, repo: FakeRepoAccess, input: Record<string, any>): Response {
    if (!this.#may(caller, "pull_requests", ["write"])) return forbidden();
    const state = this.#repo(repo);
    const invalid = (errors: object[]) =>
      Response.json({ message: "Validation Failed", errors }, { status: 422 });
    if (!state.branches.has(input.head)) {
      return invalid([{ resource: "PullRequest", field: "head", code: "invalid" }]);
    }
    const open = (pull: FakePull) =>
      pull.state === "open" && pull.head === input.head && pull.base === input.base;
    if (state.pulls.some(open)) {
      const owner = repo.fullName.split("/")[0];
      return invalid([
        {
          resource: "PullRequest",
          code: "custom",
          message: `A pull request already exists for ${owner}:${input.head}.`,
        },
      ]);
    }
    if (this.#compare(repo, input.base, input.head).ahead.length === 0) {
      return invalid([
        {
          resource: "PullRequest",
          code: "custom",
          message: `No commits between ${input.base} and ${input.head}`,
        },
      ]);
    }
    if (input.draft && state.draftsUnsupported) {
      return invalid([
        {
          resource: "PullRequest",
          code: "custom",
          message: "Draft pull requests are not supported in this repository.",
        },
      ]);
    }
    const pull = this.#open(repo, {
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body ?? "",
      draft: input.draft === true,
      author:
        caller.kind === "app"
          ? { login: this.botLogin, bot: true }
          : { login: caller.login, bot: false },
      headRepositoryId: repo.id,
    });
    this.#acted("open", pull, caller);
    return Response.json({ number: pull.number, draft: pull.draft }, { status: 201 });
  }

  #edit(caller: FakeCaller, repo: FakeRepoAccess, pull: FakePull, input: Record<string, any>) {
    if (
      caller.kind === "user"
        ? !repo.canPush(caller.id)
        : !this.#may(caller, "pull_requests", ["write"])
    ) {
      return forbidden();
    }
    if (typeof input.body === "string") pull.body = input.body;
    const mergedBy = this.#mergedBeforeCloseBy;
    if (input.state === "closed" && mergedBy && pull.state === "open") {
      this.#mergedBeforeCloseBy = null;
      pull.state = "closed";
      pull.merged = true;
      pull.mergedBy = mergedBy;
      pull.mergedHead = this.head(repo, pull.head) ?? null;
      pull.closedAt = this.#clock.now();
      this.actions.push({ kind: "merge", number: pull.number, by: mergedBy });
    }
    if (input.state === "closed" && pull.state === "open") {
      pull.state = "closed";
      pull.closedAt = this.#clock.now();
      this.#acted("close", pull, caller);
    }
    pull.updatedAt = this.#clock.now();
    return Response.json({ number: pull.number, state: pull.state });
  }

  #merge(caller: FakeCaller, repo: FakeRepoAccess, pull: FakePull, input: Record<string, any>) {
    if (caller.kind !== "user" || !repo.canPush(caller.id)) return forbidden();
    const first = this.#mergedFirstBy;
    if (first) {
      // Someone else's merge lands between Ponzu's read and this one, as in a race on GitHub.
      this.#mergedFirstBy = null;
      this.#merge({ ...caller, login: first }, repo, pull, input);
    }
    const notMergeable = () =>
      Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
    if (pull.state !== "open" || pull.draft) return notMergeable();
    // A base behind a merge queue takes merges only from the queue.
    if (this.#repo(repo).settings.mergeQueue) {
      return Response.json(
        { message: "Changes must be made through the merge queue" },
        { status: 405 },
      );
    }
    const settings = this.#repo(repo).settings;
    if (!settings[input.merge_method as "squash" | "merge" | "rebase"]) return notMergeable();
    if (input.sha && input.sha !== this.head(repo, pull.head)) {
      return Response.json(
        { message: "Head branch was modified. Review and try the merge again." },
        { status: 409 },
      );
    }
    if (this.#mergeable(pull) !== "MERGEABLE") return notMergeable();
    const wanted = this.#wanted(repo, pull);
    const rules = this.#repo(repo).rules.get(pull.base) ?? {};
    if (wanted && !rules.bypass?.includes(caller.login)) {
      return Response.json({ message: wanted.message }, { status: 405 });
    }
    const ahead = this.#compare(repo, pull.base, pull.head).ahead;
    pull.mergedShas = ahead;
    pull.mergedHead = this.head(repo, pull.head) ?? null;
    const base = this.#repo(repo).branches.get(pull.base)!;
    base.push(...ahead);
    pull.state = "closed";
    pull.merged = true;
    pull.mergedBy = caller.login;
    pull.closedAt = this.#clock.now();
    pull.updatedAt = this.#clock.now();
    this.#acted("merge", pull, caller);
    return Response.json({ merged: true, message: "Pull Request successfully merged" });
  }

  #updateBranch(
    caller: FakeCaller,
    repo: FakeRepoAccess,
    pull: FakePull,
    input: Record<string, any>,
  ) {
    if (caller.kind !== "user" || !repo.canPush(caller.id)) return forbidden();
    if (input.expected_head_sha && input.expected_head_sha !== this.head(repo, pull.head)) {
      return Response.json(
        { message: "expected head sha didn’t match current head ref." },
        { status: 422 },
      );
    }
    if (pull.conflicting) {
      return Response.json({ message: "merge conflict between base and head" }, { status: 422 });
    }
    if (this.#repo(repo).settings.workflowRefused) {
      return Response.json({ message: WORKFLOW_REFUSED }, { status: 422 });
    }
    const { behind } = this.#compare(repo, pull.base, pull.head);
    const head = this.#repo(repo).branches.get(pull.head)!;
    head.push(...behind);
    this.push(repo, pull.head, { files: [], message: `Merge ${pull.base} into ${pull.head}` });
    this.#acted("update_branch", pull, caller);
    return Response.json({ message: "Updating pull request branch." }, { status: 202 });
  }

  #graphql(
    caller: FakeCaller,
    query: string,
    variables: Record<string, any>,
    find: (fullName: string) => FakeRepoAccess | undefined,
  ): Response {
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    const error = (type: string, message: string) =>
      Response.json({ data: null, errors: [{ type, message }] });
    if (operation === "PullRequestTab") {
      if (
        !this.#may(caller, "pull_requests", READ_PULLS) ||
        !this.#may(caller, "contents", READ_PULLS)
      ) {
        return error("FORBIDDEN", "Resource not accessible by integration");
      }
      const repo = find(`${variables.owner}/${variables.name}`);
      if (!repo || !this.#reaches(caller, repo))
        return error("NOT_FOUND", "Could not resolve to a Repository.");
      const repository = this.#tab(repo, variables);
      // As GitHub answers for a number it does not have: the rest, and an error for that part.
      const missing = variables.known && repository.pullRequest === undefined;
      const errors: object[] = missing
        ? [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              message: "Could not resolve to a PullRequest.",
            },
          ]
        : [];
      // As GitHub answers an App without the "Merge queues" permission: those fields alone.
      const pull = repository.pullRequest;
      if (pull && this.#repo(repo).settings.mergeQueueUnreadable) {
        Object.assign(pull, { isMergeQueueEnabled: null, mergeQueueEntry: null });
        for (const field of ["isMergeQueueEnabled", "mergeQueueEntry"]) {
          errors.push({
            type: "FORBIDDEN",
            path: ["repository", "pullRequest", field],
            message: "Resource not accessible by integration",
          });
        }
      }
      return Response.json({
        data: { repository: { ...repository, ...(missing ? { pullRequest: null } : {}) } },
        ...(errors.length > 0 ? { errors } : {}),
      });
    }
    if (operation === "LinkedPullRequest") {
      if (
        !this.#may(caller, "pull_requests", READ_PULLS) ||
        !this.#may(caller, "contents", READ_PULLS)
      ) {
        return error("FORBIDDEN", "Resource not accessible by integration");
      }
      const repo = find(`${variables.owner}/${variables.name}`);
      if (!repo || !this.#reaches(caller, repo))
        return error("NOT_FOUND", "Could not resolve to a Repository.");
      const pull = this.#repo(repo).pulls.find(
        (candidate) => candidate.number === variables.number,
      );
      if (!pull) {
        return Response.json({
          data: { repository: { pullRequest: null } },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              message: "Could not resolve to a PullRequest.",
            },
          ],
        });
      }
      return Response.json({ data: { repository: { pullRequest: this.#pullJson(repo, pull) } } });
    }
    if (caller.kind !== "user") return error("FORBIDDEN", "Resource not accessible by integration");
    const found = this.#byNodeId(String(variables.id), find);
    if (!found) return error("NOT_FOUND", "Could not resolve to a node.");
    const { repo, pull } = found;
    if (!repo.canPush(caller.id)) return error("FORBIDDEN", "You do not have permission.");
    const unprocessable = (message: string) => error("UNPROCESSABLE", message);
    switch (operation) {
      case "MarkReady":
        pull.draft = false;
        pull.updatedAt = this.#clock.now();
        this.#acted("ready", pull, caller);
        break;
      case "EnableAutoMerge": {
        if (!this.#repo(repo).settings.autoMerge) {
          return unprocessable("Auto merge is not allowed for this repository");
        }
        const state = this.#mergeState(repo, pull);
        if (state === "CLEAN") return unprocessable("Pull request is in clean status");
        pull.autoMerge = { method: String(variables.mergeMethod), enabledBy: caller.login };
        this.#acted("auto_merge", pull, caller);
        break;
      }
      case "DisableAutoMerge":
        pull.autoMerge = null;
        this.#acted("auto_merge_off", pull, caller);
        break;
      case "EnqueuePullRequest": {
        if (!this.#repo(repo).settings.mergeQueue) {
          return unprocessable("Pull request is not in a repository with a merge queue enabled");
        }
        if (pull.state !== "open" || pull.draft) {
          return unprocessable("Pull request is not in a mergeable state");
        }
        const expected = variables.expectedHeadOid;
        if (expected && expected !== this.head(repo, pull.head)) {
          return unprocessable("Head ref is not at the expected head oid");
        }
        pull.queue = { state: "AWAITING_CHECKS" };
        pull.updatedAt = this.#clock.now();
        this.#acted("enqueue", pull, caller);
        return Response.json({
          data: {
            enqueuePullRequest: { mergeQueueEntry: this.#queueEntry(repo, pull) },
          },
        });
      }
      default:
        return error("UNKNOWN", `The fake GitHub has no operation ${operation}.`);
    }
    return Response.json({ data: { result: { clientMutationId: null } } });
  }

  /** A pull request's entry in its base's merge queue, as GraphQL's `mergeQueueEntry` has it. */
  #queueEntry(repo: FakeRepoAccess, pull: FakePull) {
    if (!pull.queue) return null;
    const queued = this.#repo(repo).pulls.filter(
      (candidate) => candidate.queue && candidate.base === pull.base,
    );
    return { state: pull.queue.state, position: queued.indexOf(pull) + 1 };
  }

  #byNodeId(id: string, find: (fullName: string) => FakeRepoAccess | undefined) {
    for (const state of this.#repos.values()) {
      const pull = state.pulls.find((candidate) => candidate.nodeId === id);
      const repo = pull && find(state.fullName);
      if (pull && repo) return { repo, pull };
    }
    return null;
  }

  /** `repository { … }` as the `PullRequestTab` query asks for it. */
  #tab(repo: FakeRepoAccess, variables: Record<string, any>) {
    const state = this.#repo(repo);
    const branch = String(variables.qualifiedBranch).replace(/^refs\/heads\//, "");
    const head = this.head(repo, branch);
    const compare = this.#compare(repo, branch, variables.defaultBranch);
    const fromBranch = state.pulls.filter(
      (pull) =>
        pull.head === branch &&
        pull.headRepositoryId === repo.id &&
        pull.base === variables.defaultBranch,
    );
    const pull = variables.known
      ? state.pulls.find((candidate) => candidate.number === variables.number)
      : undefined;
    return {
      squashMergeAllowed: state.settings.squash,
      mergeCommitAllowed: state.settings.merge,
      rebaseMergeAllowed: state.settings.rebase,
      autoMergeAllowed: state.settings.autoMerge,
      ref: head
        ? {
            target: { oid: head },
            // The branch as the base and the default branch as the head, as GitHub's `compare`.
            compare: { aheadBy: compare.ahead.length, behindBy: compare.behind.length },
            associatedPullRequests: {
              nodes: fromBranch.slice(-1).map((candidate) => ({ number: candidate.number })),
            },
          }
        : null,
      ...(variables.known ? { pullRequest: pull && this.#pullJson(repo, pull) } : {}),
    };
  }

  #pullJson(repo: FakeRepoAccess, pull: FakePull) {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    // The App's bot as GraphQL names it, by its slug; anyone else is a person.
    const who = (login: string, bot = login === this.botLogin) => ({
      __typename: bot ? "Bot" : "User",
      login,
      avatarUrl: `https://avatars.example/${login}`,
    });
    const shown = pull.shownHead && this.#clock.now() < pull.shownHead.until;
    const headSha = shown
      ? pull.shownHead!.sha
      : (pull.mergedHead ?? this.head(repo, pull.head) ?? "0".repeat(40));
    const files = this.#files(repo, pull);
    const commits =
      (pull.merged ? pull.mergedShas : this.#compare(repo, pull.base, pull.head).ahead) ?? [];
    const merged = pull.merged && this.#clock.now() >= (pull.closedAt ?? 0) + this.#mergesHiddenMs;
    const rollup = this.#rollup(headSha);
    const required = this.#repo(repo).rules.get(pull.base)?.requiredChecks ?? [];
    return {
      id: pull.nodeId,
      number: pull.number,
      url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      title: pull.title,
      body: pull.body,
      state: merged ? "MERGED" : pull.state === "closed" && !pull.merged ? "CLOSED" : "OPEN",
      isDraft: pull.draft,
      createdAt: iso(pull.createdAt),
      updatedAt: iso(pull.updatedAt),
      mergedAt: merged ? iso(pull.closedAt) : null,
      closedAt: merged || !pull.merged ? iso(pull.closedAt) : null,
      mergeable: this.#mergeable(pull),
      mergeStateStatus: this.#mergeState(repo, pull),
      reviewDecision: this.#reviewDecision(repo, pull),
      isMergeQueueEnabled: this.#repo(repo).settings.mergeQueue,
      mergeQueueEntry: this.#queueEntry(repo, pull),
      headRefName: pull.head,
      headRefOid: headSha,
      baseRefName: pull.base,
      headRepository: { databaseId: pull.headRepositoryId },
      author: who(pull.author.login, pull.author.bot),
      mergedBy: pull.mergedBy ? who(pull.mergedBy) : null,
      autoMergeRequest: pull.autoMerge
        ? { mergeMethod: pull.autoMerge.method, enabledBy: who(pull.autoMerge.enabledBy) }
        : null,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files: {
        totalCount: files.length,
        nodes: files.slice(0, 100).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.change === "removed" ? "DELETED" : "MODIFIED",
        })),
      },
      commits: {
        totalCount: commits.length,
        nodes: commits.slice(-100).map((sha) => {
          const commit = this.#commits.get(sha)!;
          return {
            commit: {
              oid: sha,
              messageHeadline: commit.message,
              committedDate: iso(commit.at),
              author: { name: commit.author, user: { login: commit.author } },
            },
          };
        }),
      },
      head: {
        nodes: [
          {
            commit: {
              statusCheckRollup: rollup && {
                state: rollup.state,
                contexts: {
                  totalCount: rollup.checks.length,
                  nodes: rollup.checks.map((check) =>
                    check.status
                      ? {
                          __typename: "StatusContext",
                          context: check.name,
                          state:
                            check.state === "success"
                              ? "SUCCESS"
                              : check.state === "failure"
                                ? "FAILURE"
                                : "PENDING",
                          targetUrl: check.url ?? `https://ci.example/${check.name}`,
                          createdAt: iso(this.#clock.now()),
                          isRequired: required.includes(check.name),
                        }
                      : {
                          __typename: "CheckRun",
                          name: check.name,
                          status:
                            check.state === "queued"
                              ? "QUEUED"
                              : check.state === "in_progress"
                                ? "IN_PROGRESS"
                                : "COMPLETED",
                          conclusion: ["success", "failure", "skipped"].includes(check.state)
                            ? check.state.toUpperCase()
                            : null,
                          detailsUrl: check.url ?? `https://ci.example/${check.name}`,
                          startedAt: iso(this.#clock.now()),
                          completedAt: null,
                          isRequired: required.includes(check.name),
                          checkSuite: { app: { name: "GitHub Actions" } },
                        },
                  ),
                },
              },
            },
          },
        ],
      },
      comments: {
        nodes: pull.comments
          .filter((comment) => !comment.path)
          .map((comment) => ({
            id: comment.id,
            url: `https://github.com/${repo.fullName}/pull/${pull.number}#${comment.id}`,
            body: comment.body,
            createdAt: iso(comment.at),
            author: who(comment.login),
          })),
      },
      reviews: {
        nodes: [
          ...pull.reviews.map((review) => ({
            id: review.id,
            url: `https://github.com/${repo.fullName}/pull/${pull.number}#${review.id}`,
            state: review.state,
            body: review.body,
            submittedAt: iso(review.at),
            author: who(review.login),
            comments: { nodes: [] },
          })),
          // Line comments come inside a review, as GitHub keeps them.
          ...pull.comments
            .filter((comment) => comment.path)
            .map((comment) => ({
              id: this.#id("PRR"),
              url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
              state: "COMMENTED",
              body: "",
              submittedAt: iso(comment.at),
              author: who(comment.login),
              comments: {
                nodes: [
                  {
                    id: comment.id,
                    url: `https://github.com/${repo.fullName}/pull/${pull.number}#${comment.id}`,
                    body: comment.body,
                    path: comment.path,
                    line: comment.line,
                    originalLine: comment.line,
                    createdAt: iso(comment.at),
                    author: { ...who(comment.login), databaseId: this.#idOf(comment.login) },
                  },
                ],
              },
            })),
        ],
      },
      // One thread for each line comment, as a comment that starts one; only the newest.
      reviewThreads: {
        nodes: pull.comments
          .filter((comment) => comment.path)
          .map((comment) => ({
            isResolved: comment.resolved === true,
            comments: { nodes: [{ id: comment.id }] },
          }))
          .filter((_, i, all) => i >= all.length - this.threadsShown),
      },
    };
  }

  #acted(kind: string, pull: FakePull, caller: FakeCaller) {
    this.actions.push({
      kind,
      number: pull.number,
      by: caller.kind === "app" ? "app" : caller.login,
    });
  }

  #sha(): string {
    return (this.#next++).toString(16).padStart(40, "0");
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#next++}`;
  }
}

/** GitHub's words when the App would write a workflow file without the `workflows` permission. */
export const WORKFLOW_REFUSED =
  "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";

function notFound(): Response {
  return Response.json({ message: "Not Found" }, { status: 404 });
}

function forbidden(): Response {
  return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
}
