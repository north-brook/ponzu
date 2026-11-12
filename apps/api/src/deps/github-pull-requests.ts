import type { PrChecks, PrState } from "@ponzu/db";
import { UpstreamError } from "../http/errors.ts";
import type { AppPermissions, GithubTransport } from "./github.ts";
import { answer, bearer, type GithubAnswer, graphql, repoParams, send } from "./github-octokit.ts";

/*
 * A canvas's pull request on GitHub (docs/cloud.md, "Pull requests"). The App reads it and
 * writes its description, with a token for the one repository; the person (or the agent, as the
 * person its turn is for) opens it, merges it,
 * marks it ready, sets auto-merge, closes it and updates its branch with their own user token,
 * so GitHub holds them to the repo's rules as they apply to them and names them as who did it.
 *
 * Everything the pull request tab shows is one GraphQL query. The github-app spike measured
 * what this rests on: `mergeable` is null (`UNKNOWN`) for seconds after a push, check suites are
 * no measure of checks (other apps leave theirs queued for good), and the rollup of check runs
 * and statuses is.
 */

/** One repository of an installation, as the App reaches it. */
export interface PullRequestRepo {
  installationId: number;
  repository: { id: number; fullName: string };
}

/** Someone on GitHub: a person, or an app's bot. */
export interface GithubWho {
  login: string;
  /** On http(s), or null. */
  avatarUrl: string | null;
  bot: boolean;
}

export type MergeMethod = "squash" | "merge" | "rebase";

/** GitHub's word on whether the pull request can merge now, and if not, why. */
export type MergeState =
  | "clean"
  | "unstable"
  | "has_hooks"
  | "behind"
  | "blocked"
  | "dirty"
  | "draft"
  | "unknown";

export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type CheckState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "neutral";

export interface GithubCheck {
  name: string;
  /** The app that ran it; null for a commit status. */
  app: string | null;
  state: CheckState;
  /** Whether the repo's rules want it to pass before the pull request merges. */
  required: boolean;
  /** Its page, when it gave one on http(s). Whoever posts a check chooses it. */
  url: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface GithubReview {
  id: string;
  author: GithubWho | null;
  state: "approved" | "changes_requested" | "dismissed";
  at: Date | null;
  url: string;
}

/** One thing said on the pull request: a comment, a review's text, or a line comment. */
export interface GithubRemark {
  id: string;
  author: GithubWho | null;
  body: string;
  at: Date;
  url: string;
  /** For a line comment, the file and line it is on. */
  path: string | null;
  line: number | null;
  /**
   * For a line comment, whether its thread was marked resolved on GitHub; null for any other, and
   * for one whose thread GitHub didn't answer for (it isn't known, so it is not called unresolved).
   */
  resolved: boolean | null;
  /**
   * For a line comment, its author's GitHub id when the author is a person: what the agent's read
   * of it asks GitHub whether they can push by, as for a review that reaches it as an event.
   */
  authorId?: number | null;
}

export interface GithubChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
}

export interface GithubCommit {
  sha: string;
  message: string;
  at: Date;
  /** Their GitHub login, or the name in the commit when they have none. */
  author: string | null;
}

/** GitHub's word on a pull request's entry in a merge queue (`MergeQueueEntryState`). */
export const MERGE_QUEUE_STATES = [
  "queued",
  "awaiting_checks",
  "mergeable",
  "unmergeable",
  "locked",
] as const;
export type MergeQueueState = (typeof MERGE_QUEUE_STATES)[number];

export interface GithubMergeQueue {
  /** The base branch's rules send every merge through a merge queue. */
  enabled: boolean;
  /** Its entry while it is in the queue: where, from 1, and how it stands. */
  entry: { state: MergeQueueState; position: number | null } | null;
}

export interface GithubPullRequest {
  /** GitHub's node id, which its GraphQL mutations take. */
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: PrState;
  head: { ref: string; sha: string; repositoryId: number | null };
  base: { ref: string };
  author: GithubWho | null;
  mergedBy: GithubWho | null;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
  /** Null while GitHub works it out. */
  mergeable: boolean | null;
  mergeState: MergeState;
  reviewDecision: ReviewDecision | null;
  autoMerge: { method: MergeMethod; enabledBy: GithubWho | null } | null;
  checks: { state: PrChecks; items: GithubCheck[]; complete: boolean };
  /**
   * Whether its base merges through a merge queue (docs/cloud.md, "Pull requests"), and its place
   * in the queue while it is in one.
   */
  mergeQueue: GithubMergeQueue;
  reviews: GithubReview[];
  conversation: GithubRemark[];
  files: { total: number; additions: number; deletions: number; items: GithubChangedFile[] };
  commits: { total: number; items: GithubCommit[] };
}

/** What one read finds about a canvas's branch and the pull request asked for. */
export interface GithubPullRequestRead {
  /** The ways the repo lets a pull request merge, the one to use first. */
  mergeMethods: MergeMethod[];
  autoMergeAllowed: boolean;
  /** Null when the branch is not on GitHub. */
  branch: { sha: string; aheadBy: number; behindBy: number } | null;
  /** The newest pull request from the branch into the default branch, if there is one. */
  newest: number | null;
  /** The pull request asked for, if a number was given. */
  pullRequest: GithubPullRequest | null;
}

export type OpenResult =
  | { kind: "opened"; number: number }
  /** One is already open from this branch. */
  | { kind: "exists" }
  /** The branch has nothing its base does not. */
  | { kind: "no_commits" }
  /** The branch is not on GitHub. */
  | { kind: "no_branch" }
  /** The repo's plan has no draft pull requests. */
  | { kind: "draft_unsupported" }
  /** GitHub does not let this person open one here. */
  | { kind: "forbidden" };

/** How GitHub answered something a person asked of it. */
export type PersonResult =
  | "done"
  /** The branch is no longer at the commit the request named. */
  | "head_moved"
  /** GitHub does not let this person do this here. */
  | "forbidden"
  /**
   * It would change a file under `.github/workflows/`, which GitHub refuses to Ponzu's App (and
   * so to a person's token through it) without the `workflows` permission.
   */
  | "workflow_permission"
  /** GitHub refused it for some other reason. */
  | "refused";

/**
 * Why GitHub would not merge, as its answer words it: what the repo's rules still want, or
 * `not_mergeable` when it does not say.
 */
export type MergeRefusal =
  | "review_required"
  | "changes_requested"
  | "checks_pending"
  | "checks_failing"
  | "branch_behind"
  | "merge_conflicts"
  | "not_mergeable";

export interface GithubChangedFileDiff extends GithubChangedFile {
  previousPath: string | null;
  /** The unified diff; null when GitHub has none to give (a binary file, or one too large). */
  patch: string | null;
}

export interface GithubPullRequests {
  /** As the App: the branch, and the pull request `number` names (none for null). */
  readPullRequest(
    repo: PullRequestRepo,
    query: { branch: string; defaultBranch: string; number: number | null },
  ): Promise<GithubPullRequestRead>;
  /** As the person, so that they are its author. */
  openPullRequest(
    userToken: string,
    input: {
      fullName: string;
      head: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
    },
  ): Promise<OpenResult>;
  /** As the App: its description. */
  editPullRequestBody(repo: PullRequestRepo, number: number, body: string): Promise<void>;
  /**
   * As the App: one of the first hundred changed files (those the tab lists) with its diff, or
   * null when they have no such file.
   */
  readPullRequestFile(
    repo: PullRequestRepo,
    number: number,
    path: string,
  ): Promise<GithubChangedFileDiff | null>;

  /** As the person: these take their GitHub user token and the pull request's node id. */
  markReady(userToken: string, pullRequestId: string): Promise<PersonResult>;
  enableAutoMerge(
    userToken: string,
    pullRequestId: string,
    method: MergeMethod,
  ): Promise<PersonResult>;
  disableAutoMerge(userToken: string, pullRequestId: string): Promise<PersonResult>;
  /**
   * As the person: adds it to its base's merge queue, only while its head is at `sha`. GitHub
   * merges it once the queue's checks pass.
   */
  enqueuePullRequest(userToken: string, pullRequestId: string, sha: string): Promise<PersonResult>;
  /** As the person: merges only while the branch is at `sha`. */
  mergePullRequest(
    userToken: string,
    input: { fullName: string; number: number; method: MergeMethod; sha: string },
  ): Promise<PersonResult | MergeRefusal>;
  /** As the person: merges the base into the branch, only while the branch is at `sha`. */
  updatePullRequestBranch(
    userToken: string,
    input: { fullName: string; number: number; sha: string },
  ): Promise<PersonResult>;
  closePullRequest(
    userToken: string,
    input: { fullName: string; number: number },
  ): Promise<PersonResult>;
  /** As the person: deletes a branch. One already gone is done. */
  deleteBranch(
    userToken: string,
    input: { fullName: string; branch: string },
  ): Promise<PersonResult>;
}

/** Reading takes these; statuses are what CI that reports the old way shows up as. */
const READ: AppPermissions = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
};
/** Writing a pull request's description. */
const WRITE: AppPermissions = { contents: "read", pull_requests: "write", metadata: "read" };

/** The most of one comment or review the tab is sent. */
const MAX_TEXT = 8_000;
/** The files the tab lists, and so the most a diff is looked for among: one page of GitHub's. */
const LISTED_FILES = 100;

const WHO = "__typename login avatarUrl";

export const PULL_REQUEST_QUERY = `query PullRequestTab($owner: String!, $name: String!, $qualifiedBranch: String!, $defaultBranch: String!, $number: Int!, $known: Boolean!) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed
    mergeCommitAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    ref(qualifiedName: $qualifiedBranch) {
      target { oid }
      compare(headRef: $defaultBranch) { aheadBy behindBy }
      associatedPullRequests(first: 1, baseRefName: $defaultBranch, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number } }
    }
    pullRequest(number: $number) @include(if: $known) {
      id number url title body state isDraft createdAt updatedAt mergedAt closedAt
      mergeable mergeStateStatus reviewDecision
      isMergeQueueEnabled mergeQueueEntry { state position }
      headRefName headRefOid baseRefName
      headRepository { databaseId }
      author { ${WHO} }
      mergedBy { ${WHO} }
      autoMergeRequest { mergeMethod enabledBy { ${WHO} } }
      additions deletions
      files(first: 100) { totalCount nodes { path additions deletions changeType } }
      commits(last: 100) { totalCount nodes { commit { oid messageHeadline committedDate author { name user { login } } } } }
      head: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber: $number) checkSuite { app { name } } }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
      comments(last: 100) { nodes { id url body createdAt author { ${WHO} } } }
      reviews(last: 100) { nodes { id url state body submittedAt author { ${WHO} }
        comments(first: 30) { nodes { id url body path line originalLine createdAt author { ${WHO} ... on User { databaseId } } } } } }
      reviewThreads(last: 100) { nodes { isResolved comments(first: 30) { nodes { id } } } }
    }
  }
}`;

/** The tab query's merge queue fields, which GitHub may refuse alone (`readPullRequest`). */
const QUEUE_FIELDS = ["isMergeQueueEnabled", "mergeQueueEntry"];

const MARK_READY = `mutation MarkReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`;
const ENABLE_AUTO_MERGE = `mutation EnableAutoMerge($id: ID!, $mergeMethod: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod }) { clientMutationId } }`;
const DISABLE_AUTO_MERGE = `mutation DisableAutoMerge($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`;
/**
 * `EnqueuePullRequestInput` is `pullRequestId`, `expectedHeadOid` and `jump`, as GitHub's schema
 * answered an introspection on 12 Nov 2026. `jump` (the front of the queue) is never sent.
 */
const ENQUEUE = `mutation EnqueuePullRequest($id: ID!, $expectedHeadOid: GitObjectID) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { state position } } }`;

/**
 * GitHub's own words when something would change a workflow file without the permission to:
 * "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`
 * without `workflows` permission". The runner's push.ts reads a push's refusal the same way.
 */
export const WORKFLOW_REFUSAL =
  /refusing to allow (?:a GitHub App|an OAuth App|an integration) to create or update workflow|without `?workflows?`? (?:permission|scope)/i;

export function createPullRequestCalls({ octokit, asApp }: GithubTransport): GithubPullRequests {
  const target = ({ installationId, repository }: PullRequestRepo) => ({
    installationId,
    repositoryId: repository.id,
  });

  async function mutate(
    userToken: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<PersonResult> {
    const { errors } = await graphql(octokit, "user", userToken, query, variables);
    if (errors.length === 0) return "done";
    if (errors.some((error) => WORKFLOW_REFUSAL.test(String(error.message ?? "")))) {
      return "workflow_permission";
    }
    return errors.some((error) => error.type === "FORBIDDEN") ? "forbidden" : "refused";
  }

  return {
    readPullRequest(repo, { branch, defaultBranch, number }) {
      const { owner, repo: name } = repoParams(repo.repository.fullName);
      return asApp(target(repo), READ, async (token) => {
        const { data, errors } = await graphql(octokit, "app", token, PULL_REQUEST_QUERY, {
          owner,
          name,
          qualifiedBranch: `refs/heads/${branch}`,
          defaultBranch,
          number: number ?? 0,
          known: number !== null,
        });
        // A number GitHub does not have is an error about that part alone; the rest still holds.
        const noSuchNumber = (error: { type?: string; path?: unknown[] }) =>
          error.type === "NOT_FOUND" && error.path?.[1] === "pullRequest";
        // The merge queue's fields can be refused to an App without the "Merge queues"
        // permission, which Ponzu's tokens don't ask for: read as no queue, never as a failed
        // tab. A merge GitHub then sends to its queue is refused by GitHub, never merged past it.
        const queueUnreadable = (error: { path?: unknown[] }) =>
          error.path?.[1] === "pullRequest" && QUEUE_FIELDS.includes(String(error.path?.[2] ?? ""));
        if (
          !data?.repository ||
          !errors.every((error) => noSuchNumber(error) || queueUnreadable(error))
        ) {
          const notFound = errors.some((error) => error.type === "NOT_FOUND");
          throw new UpstreamError("github", "the pull request query was refused", {
            status: notFound ? 404 : 502,
          });
        }
        return toRead(data.repository);
      });
    },

    async openPullRequest(userToken, { fullName, head, base, title, body, draft }) {
      const opened = await answer("user", () =>
        octokit.request("POST /repos/{owner}/{repo}/pulls", {
          ...repoParams(fullName),
          title,
          head,
          base,
          body,
          draft,
          headers: bearer(userToken),
        }),
      );
      if (opened.status === 201) return { kind: "opened", number: opened.body.number };
      if (opened.status === 403 || opened.status === 404) return { kind: "forbidden" };
      if (opened.status === 422) {
        const refused = whyRefused(opened);
        if (refused) return { kind: refused };
      }
      throw new UpstreamError("github", `POST /repos/${fullName}/pulls answered ${opened.status}`, {
        status: opened.status,
      });
    },

    editPullRequestBody(repo, number, body) {
      return asApp(target(repo), WRITE, async (token) => {
        await send("app", () =>
          octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
            ...repoParams(repo.repository.fullName),
            pull_number: number,
            body,
            headers: bearer(token),
          }),
        );
      });
    },

    readPullRequestFile(repo, number, wanted) {
      return asApp(target(repo), READ, async (token) => {
        // GitHub lists a pull request's files in the same order here as to the tab's query.
        const { data: files } = await send("app", () =>
          octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
            ...repoParams(repo.repository.fullName),
            pull_number: number,
            per_page: LISTED_FILES,
            headers: bearer(token),
          }),
        );
        const file = files.find((candidate) => candidate.filename === wanted);
        if (!file) return null;
        return {
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          change: changeOf(file.status),
          additions: file.additions,
          deletions: file.deletions,
          patch: typeof file.patch === "string" ? file.patch : null,
        };
      });
    },

    markReady: (userToken, id) => mutate(userToken, MARK_READY, { id }),
    // `method` is a name `@octokit/graphql` keeps for itself.
    enableAutoMerge: (userToken, id, method) =>
      mutate(userToken, ENABLE_AUTO_MERGE, { id, mergeMethod: method.toUpperCase() }),
    disableAutoMerge: (userToken, id) => mutate(userToken, DISABLE_AUTO_MERGE, { id }),
    enqueuePullRequest: (userToken, id, sha) =>
      mutate(userToken, ENQUEUE, { id, expectedHeadOid: sha }),

    async mergePullRequest(userToken, { fullName, number, method, sha }) {
      const merged = await answer("user", () =>
        octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          ...repoParams(fullName),
          pull_number: number,
          merge_method: method,
          sha,
          headers: bearer(userToken),
        }),
      );
      if (refusesWorkflows(merged)) return "workflow_permission";
      if (merged.status === 405) return mergeRefusal(messageOf(merged));
      return personResult(merged, { 409: "head_moved" });
    },

    async updatePullRequestBranch(userToken, { fullName, number, sha }) {
      const updated = await answer("user", () =>
        octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
          ...repoParams(fullName),
          pull_number: number,
          expected_head_sha: sha,
          headers: bearer(userToken),
        }),
      );
      // GitHub says a moved head with a 422 and these words; any other 422 is something else.
      const moved = updated.status === 422 && /expected head sha/i.test(messageOf(updated));
      if (moved) return "head_moved";
      // Merging the base in would bring a workflow file the App may not write onto the branch.
      if (refusesWorkflows(updated)) return "workflow_permission";
      return personResult(updated, {});
    },

    async closePullRequest(userToken, { fullName, number }) {
      const closed = await answer("user", () =>
        octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          ...repoParams(fullName),
          pull_number: number,
          state: "closed",
          headers: bearer(userToken),
        }),
      );
      return personResult(closed, {});
    },

    async deleteBranch(userToken, { fullName, branch }) {
      const deleted = await answer("user", () =>
        octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
          ...repoParams(fullName),
          ref: `heads/${branch}`,
          headers: bearer(userToken),
        }),
      );
      // 422 "Reference does not exist": someone, or the repo's own setting, deleted it first.
      return personResult(deleted, { 422: "done" });
    },
  };
}

/** GitHub's own words for a refusal, from `message` and each of `errors`. Never shown to anyone. */
function messageOf(answer: GithubAnswer): string {
  const errors: any[] = Array.isArray(answer.body?.errors) ? answer.body.errors : [];
  return [answer.body?.message, ...errors.map((error) => error?.message ?? error?.field)]
    .filter((part) => typeof part === "string")
    .join(" ");
}

/** Whether GitHub refused it for a workflow file the App may not write, in its own words. */
function refusesWorkflows(answer: GithubAnswer): boolean {
  return answer.status >= 400 && WORKFLOW_REFUSAL.test(messageOf(answer));
}

/** What GitHub's words for a merge it refused (a 405) say the repo's rules still want. */
function mergeRefusal(message: string): MergeRefusal {
  if (/approving review|review is required|code owner/i.test(message)) return "review_required";
  if (/changes requested|requested changes/i.test(message)) return "changes_requested";
  if (/status checks? .*(expected|in progress|pending|queued)/i.test(message)) {
    return "checks_pending";
  }
  if (/status check|required check/i.test(message)) return "checks_failing";
  if (/not up to date|out of date/i.test(message)) return "branch_behind";
  if (/conflict/i.test(message)) return "merge_conflicts";
  return "not_mergeable";
}

/** Why GitHub would not open a pull request, when it is one Ponzu can tell people. */
function whyRefused(
  answer: GithubAnswer,
): Exclude<OpenResult["kind"], "opened" | "forbidden"> | null {
  const message = messageOf(answer);
  if (/already exists/i.test(message)) return "exists";
  if (/no commits between/i.test(message)) return "no_commits";
  if (/draft pull requests are not supported/i.test(message)) return "draft_unsupported";
  const errors: any[] = Array.isArray(answer.body?.errors) ? answer.body.errors : [];
  if (errors.some((error) => error?.field === "head" && error?.code === "invalid")) {
    return "no_branch";
  }
  return null;
}

function personResult(answer: GithubAnswer, meanings: Record<number, PersonResult>): PersonResult {
  if (answer.status >= 200 && answer.status < 300) return "done";
  const meaning = meanings[answer.status];
  if (meaning) return meaning;
  if (answer.status === 403 || answer.status === 404) return "forbidden";
  if (answer.status === 422) return "refused";
  throw new UpstreamError("github", `a pull request action answered ${answer.status}`, {
    status: answer.status,
  });
}

// What GitHub's GraphQL answers, mapped to the shapes above. Only the fields the query asks for.

function toRead(repository: any): GithubPullRequestRead {
  const methods: MergeMethod[] = [];
  if (repository.squashMergeAllowed) methods.push("squash");
  if (repository.mergeCommitAllowed) methods.push("merge");
  if (repository.rebaseMergeAllowed) methods.push("rebase");
  const ref = repository.ref;
  return {
    mergeMethods: methods,
    autoMergeAllowed: repository.autoMergeAllowed === true,
    // `compare` is of the branch as the base and the default branch as the head: the default
    // branch's commits ahead are what the branch lacks, and the branch's own are those behind.
    branch: ref
      ? {
          sha: ref.target.oid,
          aheadBy: ref.compare?.behindBy ?? 0,
          behindBy: ref.compare?.aheadBy ?? 0,
        }
      : null,
    newest: ref?.associatedPullRequests.nodes[0]?.number ?? null,
    pullRequest: repository.pullRequest ? toPullRequest(repository.pullRequest) : null,
  };
}

function toPullRequest(pr: any): GithubPullRequest {
  const rollup = pr.head.nodes[0]?.commit.statusCheckRollup ?? null;
  const reviews: any[] = pr.reviews.nodes;
  // Whether each line comment's thread is resolved, by the comment's id: GitHub keeps that on
  // the thread, not the comment.
  const resolved = new Map<string, boolean>(
    (pr.reviewThreads?.nodes ?? []).flatMap((thread: any) =>
      (thread.comments?.nodes ?? []).map((comment: any) => [
        comment.id,
        thread.isResolved === true,
      ]),
    ),
  );
  const conversation: GithubRemark[] = [
    ...pr.comments.nodes.map((comment: any) => remark(comment, null, null)),
    ...reviews
      .filter((review) => review.body?.trim())
      .map((review) => remark({ ...review, createdAt: review.submittedAt }, null, null)),
    ...reviews.flatMap((review) =>
      review.comments.nodes.map((comment: any) => ({
        ...remark(comment, comment.path, comment.line ?? comment.originalLine ?? null),
        // Unknown (null) for one whose thread the query's last 100 left out: never unresolved.
        resolved: resolved.get(comment.id) ?? null,
        authorId: typeof comment.author?.databaseId === "number" ? comment.author.databaseId : null,
      })),
    ),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    id: pr.id,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    // Whole, since Ponzu writes its part of it back (at most 65,536 characters on GitHub).
    body: pr.body ?? "",
    state:
      pr.state === "MERGED"
        ? "merged"
        : pr.state === "CLOSED"
          ? "closed"
          : pr.isDraft
            ? "draft"
            : "open",
    head: {
      ref: pr.headRefName,
      sha: pr.headRefOid,
      repositoryId: pr.headRepository?.databaseId ?? null,
    },
    base: { ref: pr.baseRefName },
    author: who(pr.author),
    mergedBy: who(pr.mergedBy),
    createdAt: new Date(pr.createdAt),
    updatedAt: new Date(pr.updatedAt),
    mergedAt: dateOrNull(pr.mergedAt),
    closedAt: dateOrNull(pr.closedAt),
    mergeable: pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : null,
    mergeState: (MERGE_STATES as readonly string[]).includes(
      String(pr.mergeStateStatus).toLowerCase(),
    )
      ? (String(pr.mergeStateStatus).toLowerCase() as MergeState)
      : "unknown",
    reviewDecision: pr.reviewDecision ? (pr.reviewDecision.toLowerCase() as ReviewDecision) : null,
    autoMerge: pr.autoMergeRequest
      ? {
          method: String(pr.autoMergeRequest.mergeMethod).toLowerCase() as MergeMethod,
          enabledBy: who(pr.autoMergeRequest.enabledBy),
        }
      : null,
    checks: {
      state: rollupState(rollup?.state ?? null),
      items: (rollup?.contexts.nodes ?? []).map(toCheck),
      complete: !rollup || rollup.contexts.totalCount <= rollup.contexts.nodes.length,
    },
    mergeQueue: {
      enabled: pr.isMergeQueueEnabled === true,
      entry: queueEntry(pr.mergeQueueEntry),
    },
    reviews: reviews
      .filter((review) => REVIEW_STATES.includes(review.state))
      .map((review) => ({
        id: review.id,
        author: who(review.author),
        state: review.state.toLowerCase(),
        at: dateOrNull(review.submittedAt),
        url: review.url,
      })),
    conversation,
    files: {
      total: pr.files?.totalCount ?? 0,
      additions: pr.additions,
      deletions: pr.deletions,
      items: (pr.files?.nodes ?? []).map((file: any) => ({
        path: file.path,
        change: changeOf(file.changeType),
        additions: file.additions,
        deletions: file.deletions,
      })),
    },
    commits: {
      total: pr.commits.totalCount,
      items: pr.commits.nodes.map(({ commit }: any) => ({
        sha: commit.oid,
        message: commit.messageHeadline,
        at: new Date(commit.committedDate),
        author: commit.author?.user?.login ?? commit.author?.name ?? null,
      })),
    },
  };
}

const MERGE_STATES = [
  "clean",
  "unstable",
  "has_hooks",
  "behind",
  "blocked",
  "dirty",
  "draft",
  "unknown",
] as const;
/** The reviews that are a verdict; a review that only comments is in the conversation. */
const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

/** A merge queue entry, or null for none; a state GitHub adds later reads as `queued`. */
function queueEntry(entry: any): GithubMergeQueue["entry"] {
  if (!entry) return null;
  const state = String(entry.state).toLowerCase();
  return {
    state: (MERGE_QUEUE_STATES as readonly string[]).includes(state)
      ? (state as MergeQueueState)
      : "queued",
    position: typeof entry.position === "number" ? entry.position : null,
  };
}

function who(actor: any): GithubWho | null {
  if (!actor?.login) return null;
  return {
    login: actor.login,
    avatarUrl: httpUrl(actor.avatarUrl),
    bot: actor.__typename === "Bot",
  };
}

/**
 * `value` when it is an http(s) address, else null. A check's link is whatever the app or CI
 * that posted it said, and a client opens it.
 */
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function remark(node: any, path: string | null, line: number | null): GithubRemark {
  return {
    id: node.id,
    author: who(node.author),
    body: clip(node.body ?? ""),
    at: new Date(node.createdAt),
    url: node.url,
    path,
    line,
    resolved: null,
  };
}

function rollupState(state: string | null): PrChecks {
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "running";
  return "none";
}

function toCheck(node: any): GithubCheck {
  if (node.__typename === "StatusContext") {
    const state: CheckState =
      node.state === "SUCCESS"
        ? "passed"
        : node.state === "FAILURE" || node.state === "ERROR"
          ? "failed"
          : "pending";
    return {
      name: node.context,
      app: null,
      state,
      required: node.isRequired === true,
      url: httpUrl(node.targetUrl),
      startedAt: dateOrNull(node.createdAt),
      completedAt: null,
    };
  }
  return {
    name: node.name,
    app: node.checkSuite?.app?.name ?? null,
    state: checkRunState(node.status, node.conclusion),
    required: node.isRequired === true,
    url: httpUrl(node.detailsUrl),
    startedAt: dateOrNull(node.startedAt),
    completedAt: dateOrNull(node.completedAt),
  };
}

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status === "IN_PROGRESS") return "running";
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "passed";
    case "SKIPPED":
      return "skipped";
    case "NEUTRAL":
      return "neutral";
    case "CANCELLED":
    case "STALE":
      return "cancelled";
    default:
      return "failed";
  }
}

/** GraphQL's `changeType` or REST's `status`, which calls a deletion `removed`. */
function changeOf(change: string): GithubChangedFile["change"] {
  const known = ["added", "modified", "deleted", "renamed", "copied", "changed"] as const;
  const lower = String(change)
    .toLowerCase()
    .replace(/^removed$/, "deleted");
  return (known as readonly string[]).includes(lower)
    ? (lower as GithubChangedFile["change"])
    : "changed";
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}
