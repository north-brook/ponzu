import { getPullRequestContext, type PullRequestContext, setPullRequestSummary } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { designLink } from "../runner/session.ts";
import {
  type PullRequestDeps,
  readPullRequest,
  recordRead,
  refreshPullRequest,
  targetOf,
} from "./sync.ts";
import { type PullRequestTab, toTab } from "./view.ts";

/*
 * Opening a design's pull request, as the App (docs/cloud.md, "Pull requests"), and keeping the
 * agent's summary in its description. The App is its author, so the person who asked for it
 * can approve it when the repo's rules want a review.
 */

type OpenDeps = PullRequestDeps & Pick<Deps, "background" | "config">;

/** Where the agent's words go in a description, so they can be written again in place. */
const SUMMARY_START = "<!-- ponzu:summary -->";
const SUMMARY_END = "<!-- /ponzu:summary -->";

/**
 * Open a draft pull request from the design's branch into the repo's default branch, or answer
 * the one already open (or merged) from it: `opened` says which. Refused when the design is
 * Scratch, its branch is not on GitHub, or the branch has nothing the default branch lacks.
 */
export async function openPullRequest(
  deps: OpenDeps,
  context: PullRequestContext,
): Promise<{ tab: PullRequestTab; opened: boolean }> {
  const target = targetOf(context);
  if (target instanceof ApiError) throw target;
  const { github } = deps;
  const found = await readPullRequest(deps, target);
  const existing = found.read.pullRequest;
  if (existing && existing.state !== "closed") {
    await recordRead(deps, target.designId, existing, found.readAt);
    return { tab: toTab(target, found.read), opened: false };
  }
  if (!found.read.branch) throw notPushed(target.branch);
  if (found.read.branch.aheadBy === 0) throw noChanges(target.branch, target.defaultBranch);

  const input = {
    head: target.branch,
    base: target.defaultBranch,
    title: context.design.name,
    body: composeBody(deps, context),
  };
  let result = await github.openPullRequest(target.repo, { ...input, draft: true });
  // Draft pull requests need a paid plan for a private repo: such a repo gets a ready one.
  if (result.kind === "draft_unsupported") {
    result = await github.openPullRequest(target.repo, { ...input, draft: false });
  }
  switch (result.kind) {
    case "no_branch":
      throw notPushed(target.branch);
    case "no_commits":
      throw noChanges(target.branch, target.defaultBranch);
    case "draft_unsupported":
      throw new Error("GitHub refused a pull request that was not a draft as a draft.");
  }
  // Opened now, or by someone else a moment ago: either way, the newest from the branch.
  const read = await readPullRequest(deps, target, result.kind === "opened" ? result.number : null);
  const pullRequest = read.read.pullRequest;
  if (!pullRequest) throw new Error("GitHub does not show the pull request it just opened.");
  await recordRead(deps, target.designId, pullRequest, read.readAt);
  // GitHub works out whether it can merge over the next few seconds.
  deps.background(
    "pull_request_refresh",
    refreshPullRequest(deps, target.designId, {
      number: pullRequest.number,
      untilMergeable: true,
    }),
  );
  return { tab: toTab(target, read.read), opened: result.kind === "opened" };
}

/**
 * Keep the agent's words on what the branch changes, and write them into the open pull
 * request's description in place of what it said before. Answers the number of the pull request
 * that now carries them, or null when they wait for one to open (or the description no longer
 * has Ponzu's part, because someone rewrote it on GitHub, which is theirs to keep).
 */
export async function savePullRequestSummary(
  deps: PullRequestDeps,
  designId: string,
  summary: string,
): Promise<number | null> {
  const saved = await setPullRequestSummary(deps.db, { designId, summary });
  if (!saved) throw new ApiError(404, "not_found", "There is no such design.");
  if (saved.prState !== "open" && saved.prState !== "draft") return null;
  const context = await getPullRequestContext(deps.db, designId);
  const target = context && targetOf(context);
  if (!target || target instanceof ApiError) return null;
  const { read } = await readPullRequest(deps, target);
  const pullRequest = read.pullRequest;
  if (!pullRequest || (pullRequest.state !== "open" && pullRequest.state !== "draft")) return null;
  const body = withSummary(pullRequest.body, summary);
  if (body === null) {
    deps.log.info("pull_request_summary_kept", { designId, reason: "description_rewritten" });
    return null;
  }
  if (body !== pullRequest.body) {
    await deps.github.editPullRequestBody(target.repo, pullRequest.number, body);
  }
  return pullRequest.number;
}

/**
 * A new pull request's description: the agent's summary, the design's first page as its
 * preview shows it, and the way back to it in Ponzu. The preview's address carries the design's
 * asset key, which opens all of its files, so it goes only into a private repo's pull request:
 * whoever can read that is someone the repo would let open the design.
 */
export function composeBody(
  { config }: Pick<Deps, "config">,
  { design, repo, assetKey }: PullRequestContext,
): string {
  const link = designLink(design.id);
  const name = escapeMarkdown(design.name);
  const parts = [`${SUMMARY_START}\n${unmarked(design.prSummary ?? "")}\n${SUMMARY_END}`];
  if (repo?.private && design.previewSeq !== null) {
    const preview = (theme: "light" | "dark") =>
      `${config.assetsUrl}/${assetKey}/previews/${design.previewSeq}-${theme}.png`;
    parts.push(
      `<a href="${link}"><picture>` +
        `<source media="(prefers-color-scheme: dark)" srcset="${preview("dark")}">` +
        `<img src="${preview("light")}" alt="${escapeHtml(design.name)}" width="720">` +
        "</picture></a>",
    );
  }
  parts.push(`Designed in Ponzu: [${name}](${link})`);
  return parts.join("\n\n");
}

/** `body` with Ponzu's part replaced by `summary`, or null when it has no such part. */
export function withSummary(body: string, summary: string): string | null {
  const start = body.indexOf(SUMMARY_START);
  const end = body.indexOf(SUMMARY_END, start);
  if (start < 0 || end < 0) return null;
  return `${body.slice(0, start)}${SUMMARY_START}\n${unmarked(summary)}\n${body.slice(end)}`;
}

/** The summary without Ponzu's markers in it, which would confuse the next rewrite. */
function unmarked(summary: string): string {
  return summary.replaceAll(SUMMARY_START, "").replaceAll(SUMMARY_END, "").trim();
}

const notPushed = (branch: string) =>
  new ApiError(409, "branch_not_pushed", `Nothing has been pushed to ${branch} yet.`);

const noChanges = (branch: string, base: string) =>
  new ApiError(409, "no_changes", `${branch} has no commits that ${base} does not have.`);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Text that stays text inside a Markdown link's label. */
function escapeMarkdown(text: string): string {
  return escapeHtml(text).replace(/[\\[\]*_`~]/g, (char) => `\\${char}`);
}
