import {
  addLinkedPullRequest,
  appendThreadItemOnce,
  countLinks,
  findWorkspaceRepo,
  getLinkContext,
  getLinkedPullRequest,
  getPullRequestContext,
  type LinkContext,
  type LinkedPullRequestView,
  listLinkedPullRequests,
  MAX_LINKED_PULL_REQUESTS,
  type PrChecks,
  type PrLinkSource,
  type PrState,
  removeLinkedPullRequests,
  type User,
} from "@ponzu/db";
import { repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * Linking pull requests to a canvas (docs/cloud.md, "Linked pull requests"): those a person, or
 * their agent through the MCP, says are this canvas's work besides the one from its branch. One
 * function for both, so a refusal says the same thing to each, in a sentence an agent can act on.
 *
 * The caller has already checked that the person may steer the canvas (`requireCanvas` with
 * write access). Here each pull request is checked on its own: a repo of the canvas's workspace,
 * one the App can still reach and the person can read, and a pull request GitHub has. It is read
 * as the App and recorded; one already merged or closed is recorded finished, and never settles
 * the canvas by itself.
 */

export type LinkDeps = Pick<Deps, "db" | "github" | "clock" | "vault" | "log">;

/** A pull request as a link names it: its URL on GitHub, or its repo and number. */
export type PullRequestRef = string | { repository: string; number: number };

/** Why a pull request was not linked. */
export type LinkRefusal =
  | "invalid_url"
  | "repo_not_in_workspace"
  | "forbidden"
  | "not_found"
  | "too_many_pull_requests";

/** A linked pull request as clients and agents see it. */
export interface LinkedPullRequest {
  repoId: string;
  /** `owner/repo`. */
  repository: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  checks: PrChecks;
  mergeable: boolean | null;
  autoMerge: boolean;
  source: PrLinkSource;
  /** The agent's name for an `agent` link ("Claude Code"); null for a person's. */
  via: string | null;
  linkedAt: string;
  linkedBy: { id: string; name: string; avatarUrl: string | null } | null;
}

/** What linking one pull request did. `ref` is the one asked for, as it was given. */
export type LinkResult =
  | { ref: string; result: "linked"; pullRequest: LinkedPullRequest }
  | {
      ref: string;
      result: "alreadyLinked";
      alreadyLinked: true;
      /** It is the canvas's own pull request, from its branch: never a link. */
      branch: boolean;
      /** The link as it stands; null for the branch's own. */
      pullRequest: LinkedPullRequest | null;
      message: string;
    }
  | { ref: string; result: "refused"; code: LinkRefusal; message: string };

/** What unlinking one pull request did. */
export type UnlinkResult =
  | { ref: string; result: "unlinked" | "notLinked"; repository: string; number: number }
  | { ref: string; result: "refused"; code: "invalid_url"; message: string };

/** The branch's own pull request as a summary, beside the canvas's links. */
export interface BranchPullRequest {
  number: number;
  state: PrState;
  checks: PrChecks;
  mergeable: boolean | null;
  autoMerge: boolean;
}

const URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?:[/?#].*)?$/;
const REPOSITORY_PATTERN = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

/** A ref's repo and number, or null when it doesn't name a GitHub pull request. */
export function parseRef(ref: PullRequestRef): { repository: string; number: number } | null {
  if (typeof ref === "string") {
    const match = URL_PATTERN.exec(ref.trim());
    if (!match) return null;
    const number = Number(match[3]);
    return Number.isSafeInteger(number) && number <= 2_147_483_647
      ? { repository: `${match[1]}/${match[2]}`, number }
      : null;
  }
  const { repository, number } = ref;
  if (!REPOSITORY_PATTERN.test(repository.trim())) return null;
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) return null;
  return { repository: repository.trim(), number };
}

const refText = (ref: PullRequestRef) =>
  typeof ref === "string" ? ref : `${ref.repository}#${ref.number}`;

const INVALID_URL =
  "That isn't a GitHub pull request link. Pass one like https://github.com/owner/repo/pull/12.";

export function toLinked(view: LinkedPullRequestView): LinkedPullRequest {
  return {
    repoId: view.repoId,
    repository: view.repository,
    number: view.number,
    title: view.title,
    url: view.url,
    state: view.state,
    checks: view.checks,
    mergeable: view.mergeable,
    autoMerge: view.autoMerge,
    source: view.source,
    via: view.linkedVia,
    linkedAt: view.linkedAt.toISOString(),
    linkedBy: view.linkedBy,
  };
}

/**
 * Link pull requests to a canvas, in the order given, and answer what happened to each: linked
 * (with the pull request as GitHub has it now), already linked (or the canvas's own, from its
 * branch, which is never a link), or refused with a code and a sentence for whoever asked.
 * 404 when there is no such canvas.
 */
export async function linkPullRequests(
  deps: LinkDeps,
  {
    canvasId,
    user,
    refs,
    source,
    via = null,
  }: {
    canvasId: string;
    /** The person, or the person whose grant the agent uses. */
    user: User;
    refs: PullRequestRef[];
    source: PrLinkSource;
    /** The agent's name, for an `agent` link. */
    via?: string | null;
  },
): Promise<LinkResult[]> {
  const context = await getLinkContext(deps.db, canvasId);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  const results: LinkResult[] = [];
  for (const ref of refs) {
    results.push(await linkOne(deps, context, { ref, user, source, via }));
  }
  return results;
}

async function linkOne(
  deps: LinkDeps,
  { canvas, workspace }: LinkContext,
  {
    ref,
    user,
    source,
    via,
  }: { ref: PullRequestRef; user: User; source: PrLinkSource; via: string | null },
): Promise<LinkResult> {
  const { db } = deps;
  const text = refText(ref);
  const refuse = (code: LinkRefusal, message: string): LinkResult => ({
    ref: text,
    result: "refused",
    code,
    message,
  });
  const parsed = parseRef(ref);
  if (!parsed) return refuse("invalid_url", INVALID_URL);
  const { number } = parsed;

  const repo = await findWorkspaceRepo(db, {
    workspaceId: canvas.workspaceId,
    fullName: parsed.repository,
  });
  const installationId = workspace.suspendedAt === null ? workspace.installationId : null;
  if (!repo || repo.removedAt !== null || installationId === null) {
    return refuse(
      "repo_not_in_workspace",
      `Ponzu's GitHub App isn't installed on ${parsed.repository} for ${workspace.name}, so Ponzu can't follow that pull request. Link a pull request in one of ${workspace.name}'s repositories, or ask the person to add ${parsed.repository} to Ponzu on GitHub.`,
    );
  }
  const permission = await repoPermission(deps, {
    user,
    repo,
    installation: { installationId: workspace.installationId, suspendedAt: workspace.suspendedAt },
  });
  if (permission === "none") {
    const who = user.name ?? user.githubLogin;
    return refuse(
      "forbidden",
      `${who} can't read ${repo.fullName} on GitHub, so Ponzu won't link it.`,
    );
  }

  const key = { canvasId: canvas.id, repoId: repo.id, number };
  const branchMessage = `#${number} in ${repo.fullName} is this canvas's own pull request, from its branch. It already counts toward settling the canvas.`;
  const branch = (): LinkResult => ({
    ref: text,
    result: "alreadyLinked",
    alreadyLinked: true,
    branch: true,
    pullRequest: null,
    message: branchMessage,
  });
  if (canvas.repoId === repo.id && canvas.prNumber === number) return branch();
  const already = (view: LinkedPullRequestView): LinkResult => ({
    ref: text,
    result: "alreadyLinked",
    alreadyLinked: true,
    branch: false,
    pullRequest: toLinked(view),
    message: `${repo.fullName}#${number} is already linked to this canvas.`,
  });
  const existing = await getLinkedPullRequest(db, key);
  if (existing) return already(existing);
  const tooMany = () =>
    refuse(
      "too_many_pull_requests",
      `This canvas already links ${MAX_LINKED_PULL_REQUESTS} pull requests, the most it can. Unlink one it no longer needs, then link this one.`,
    );
  if ((await countLinks(db, canvas.id)) >= MAX_LINKED_PULL_REQUESTS) return tooMany();

  const readAt = new Date(deps.clock.now());
  const pullRequest = await deps.github.readPullRequestByNumber(
    { installationId, repository: { id: repo.githubRepoId, fullName: repo.fullName } },
    number,
  );
  if (!pullRequest) {
    return refuse(
      "not_found",
      `GitHub has no pull request #${number} in ${repo.fullName}. Check the number and link it again.`,
    );
  }
  // One from the canvas's branch into its default branch is the canvas's own, even before a read
  // of the branch recorded it.
  if (
    canvas.branch !== null &&
    canvas.repoId === repo.id &&
    pullRequest.head.ref === canvas.branch &&
    pullRequest.head.repositoryId === repo.githubRepoId &&
    pullRequest.base.ref === repo.defaultBranch
  ) {
    return branch();
  }

  const linkedAt = new Date(deps.clock.now());
  const added = await addLinkedPullRequest(db, {
    ...key,
    githubRepoId: repo.githubRepoId,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    checks: pullRequest.checks,
    mergeable: pullRequest.mergeable,
    autoMerge: pullRequest.autoMerge,
    updatedAt: pullRequest.updatedAt,
    readAt,
    source,
    linkedByUserId: user.id,
    linkedVia: source === "agent" ? via : null,
    linkedAt,
  });
  if (added.kind === "full") return tooMany();
  if (added.kind === "exists") {
    const now = await getLinkedPullRequest(db, key);
    return now ? already(now) : refuse("not_found", `${repo.fullName}#${number} was unlinked.`);
  }
  await appendThreadItemOnce(db, {
    id: `ti_prl-${repo.id}-${number}-${linkedAt.getTime()}`,
    canvasId: canvas.id,
    kind: "notice",
    payload: {
      type: "pull_request_linked",
      repository: repo.fullName,
      number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state,
      via: source === "agent" ? via : null,
    },
  });
  deps.log.info("pull_request_linked", { canvasId: canvas.id, number, source });
  return { ref: text, result: "linked", pullRequest: toLinked(added.link) };
}

/**
 * Take pull requests off a canvas. Unlinking never settles or reopens it. A ref that names no
 * link answers `notLinked`. 404 when there is no such canvas.
 */
export async function unlinkPullRequests(
  deps: Pick<Deps, "db" | "log">,
  { canvasId, refs }: { canvasId: string; refs: PullRequestRef[] },
): Promise<UnlinkResult[]> {
  const context = await getLinkContext(deps.db, canvasId);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  const results: UnlinkResult[] = [];
  for (const ref of refs) {
    const text = refText(ref);
    const parsed = parseRef(ref);
    if (!parsed) {
      results.push({ ref: text, result: "refused", code: "invalid_url", message: INVALID_URL });
      continue;
    }
    const repo = await findWorkspaceRepo(deps.db, {
      workspaceId: context.canvas.workspaceId,
      fullName: parsed.repository,
    });
    const removed = repo
      ? await removeLinkedPullRequests(deps.db, canvasId, [
          { repoId: repo.id, number: parsed.number },
        ])
      : [];
    results.push({
      ref: text,
      result: removed.length > 0 ? "unlinked" : "notLinked",
      repository: repo?.fullName ?? parsed.repository,
      number: parsed.number,
    });
  }
  const unlinked = results.filter((result) => result.result === "unlinked").length;
  if (unlinked > 0) deps.log.info("pull_request_unlinked", { canvasId, count: unlinked });
  return results;
}

/** The canvas's own pull request, if it has one, and the ones it links, the first linked first. */
export async function listPullRequests(
  { db }: Pick<Deps, "db">,
  canvasId: string,
): Promise<{ branch: BranchPullRequest | null; linked: LinkedPullRequest[] }> {
  const context = await getPullRequestContext(db, canvasId);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  const { canvas } = context;
  const branch =
    canvas.prNumber !== null && canvas.prState !== null
      ? {
          number: canvas.prNumber,
          state: canvas.prState,
          checks: canvas.prChecks,
          mergeable: canvas.prMergeable,
          autoMerge: canvas.prAutoMerge,
        }
      : null;
  return { branch, linked: (await listLinkedPullRequests(db, canvasId)).map(toLinked) };
}
