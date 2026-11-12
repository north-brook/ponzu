import {
  askRunnerToPush,
  getPullRequestContext,
  type PullRequestContext,
  randomString,
  setPullRequestSummary,
  type User,
} from "@ponzu/db";
import type { PullRequestSummaryResponse } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { ApiError } from "../http/errors.ts";
import { canvasLink } from "../runner/session.ts";
import { requestWake, type WakeDeps } from "../sandboxes/wake.ts";
import {
  isOpen,
  type PullRequestDeps,
  readPullRequest,
  recordCurrent,
  refreshPullRequest,
  targetOf,
} from "./sync.ts";
import { type PullRequestTab, toTab } from "./view.ts";

/*
 * Opening a canvas's pull request, as the person who asks (docs/cloud.md, "Pull requests"), and
 * keeping the agent's summary in its description. The person is its author, so where the repo's
 * rules want a review, GitHub wants it from someone else.
 */

type OpenDeps = PullRequestDeps &
  WakeDeps &
  Pick<Deps, "background" | "config" | "storage" | "vault">;

/** Where the agent's words go in a description, so they can be written again in place. */
const SUMMARY_START = "<!-- ponzu:summary -->";
const SUMMARY_END = "<!-- /ponzu:summary -->";
/** Where the canvas's picture goes, so it can be taken out again. */
const PICTURE_START = "<!-- ponzu:picture -->";
const PICTURE_END = "<!-- /ponzu:picture -->";
/**
 * Where a pull request's pictures are kept in storage: under a random key of their own, which
 * reaches those two files and nothing else of the canvas's.
 */
const PICTURES = "pull-requests";

/**
 * Open a draft pull request from the canvas's branch into the repo's default branch, or answer
 * the one already open from it: `opened` says which. A merged one is answered too, until the
 * branch has commits since its merge (the canvas was reopened and worked on): then a new one is
 * opened. Refused when the canvas is Scratch, or the branch has nothing the default branch lacks
 * on GitHub or in the sandbox.
 *
 * Commits only the sandbox holds (its runner said so) are pushed first: the runner is asked with
 * a `push` event, which wakes a sleeping sandbox. When GitHub has nothing to open a pull request
 * from yet, the answer is the tab with `pushing` set, and the person's client asks again once the
 * branch is there.
 */
export async function openPullRequest(
  deps: OpenDeps,
  context: PullRequestContext,
  user: User,
): Promise<{ tab: PullRequestTab; opened: boolean; pushing?: boolean }> {
  const target = targetOf(context);
  if (target instanceof ApiError) throw target;
  const found = await readPullRequest(deps, target);
  const { pullRequest: existing, branch } = found.read;
  // Its branch deleted once merged is done with too, until something is pushed to it again.
  const mergedAndDone =
    existing?.state === "merged" && (!branch || branch.sha === existing.head.sha);
  if (isOpen(existing) || mergedAndDone) {
    await recordCurrent(deps, target.canvasId, found);
    return { tab: toTab(target, found.read, deps.config.githubApp.slug), opened: false };
  }
  const { unpushed } = context.sandbox;
  if (unpushed > 0) {
    await askRunnerToPush(deps.db, { canvasId: target.canvasId, userId: user.id });
    await requestWake(deps, target.canvasId, "push");
  }
  if (!branch || branch.aheadBy === 0) {
    if (unpushed > 0) {
      // A new try: what the last push said is moot until the runner says how this one went.
      const asked = { ...target, sandbox: { unpushed, pushError: null } };
      const tab = toTab(asked, found.read, deps.config.githubApp.slug);
      return { tab, opened: false, pushing: true };
    }
    if (!branch) throw notPushed(target.branch);
    throw noChanges(target.branch, target.defaultBranch);
  }

  const token = await githubUserToken(deps, user.id);
  const input = {
    fullName: target.repo.repository.fullName,
    head: target.branch,
    base: target.defaultBranch,
    title: context.canvas.name,
    body: composeBody(deps, context, await copyPictures(deps, context)),
  };
  let result = await deps.github.openPullRequest(token, { ...input, draft: true });
  // Draft pull requests need a paid plan for a private repo: such a repo gets a ready one.
  if (result.kind === "draft_unsupported") {
    result = await deps.github.openPullRequest(token, { ...input, draft: false });
  }
  switch (result.kind) {
    case "no_branch":
      throw notPushed(target.branch);
    case "no_commits":
      throw noChanges(target.branch, target.defaultBranch);
    case "forbidden":
      throw new ApiError(
        403,
        "forbidden",
        `GitHub does not let you open a pull request in ${input.fullName}.`,
      );
    case "draft_unsupported":
      throw new Error("GitHub refused a pull request that was not a draft as a draft.");
  }
  // Opened now, or by someone else a moment ago: either way, the newest from the branch.
  const read = await readPullRequest(deps, target, result.kind === "opened" ? result.number : null);
  const pullRequest = read.read.pullRequest;
  if (!pullRequest) throw new Error("GitHub does not show the pull request it just opened.");
  await recordCurrent(deps, target.canvasId, read, { lagging: true });
  // GitHub works out whether it can merge over the next few seconds.
  deps.background(
    "pull_request_refresh",
    refreshPullRequest(deps, target.canvasId, { number: pullRequest.number }),
  );
  return {
    tab: toTab(target, read.read, deps.config.githubApp.slug),
    opened: result.kind === "opened",
  };
}

/**
 * Keep the agent's words on what the branch changes, and write them into the open pull
 * request's description in place of what it said before. Answers the number of the pull request
 * that now carries them, or null with why they were only kept: no pull request is open (they
 * become the description of the one that opens next, by Create PR or the agent), or the open one's
 * description no longer has Ponzu's part because someone rewrote it on GitHub (theirs to keep),
 * or GitHub could not be read. `open` is the canvas's pull request as the app shows it, either way.
 */
export async function savePullRequestSummary(
  deps: PullRequestDeps,
  canvasId: string,
  summary: string,
): Promise<Required<PullRequestSummaryResponse>> {
  const saved = await setPullRequestSummary(deps.db, { canvasId, summary });
  if (!saved) throw new ApiError(404, "not_found", "There is no such canvas.");
  const open =
    saved.prNumber !== null && saved.prState !== null
      ? { number: saved.prNumber, state: saved.prState }
      : null;
  const kept = (why: "none_open" | "rewritten" | "unreadable") => ({
    pullRequest: null,
    open,
    kept: why,
  });
  if (saved.prState !== "open" && saved.prState !== "draft") return kept("none_open");
  const context = await getPullRequestContext(deps.db, canvasId);
  const target = context && targetOf(context);
  if (!target || target instanceof ApiError) return kept("unreadable");
  const { read } = await readPullRequest(deps, target);
  const pullRequest = read.pullRequest;
  if (!isOpen(pullRequest)) return { ...kept("none_open"), open: null };
  const current = { number: pullRequest.number, state: pullRequest.state };
  const body = withSummary(pullRequest.body, summary);
  if (body === null) {
    deps.log.info("pull_request_summary_kept", { canvasId, reason: "description_rewritten" });
    return { ...kept("rewritten"), open: current };
  }
  if (body !== pullRequest.body) {
    await deps.github.editPullRequestBody(target.repo, pullRequest.number, body);
  }
  return { pullRequest: pullRequest.number, open: current, kept: null };
}

/**
 * Take the canvas's picture out of its pull request's description, and its files out of
 * storage: for a repo just made public, whose descriptions anyone can now read. Only the newest
 * pull request is reached; an earlier one's pictures stay.
 */
export async function withdrawPictures(
  deps: PullRequestDeps & Pick<Deps, "config" | "storage">,
  canvasId: string,
): Promise<void> {
  const context = await getPullRequestContext(deps.db, canvasId);
  const target = context && targetOf(context);
  if (!target || target instanceof ApiError) return;
  const { pullRequest } = (await readPullRequest(deps, target)).read;
  if (!pullRequest) return;
  const start = pullRequest.body.indexOf(PICTURE_START);
  const end = pullRequest.body.indexOf(PICTURE_END, start);
  if (start < 0 || end < 0) return;
  const picture = pullRequest.body.slice(start, end);
  const prefix = `${deps.config.assetsUrl}/${PICTURES}/`;
  const keys = new Set(
    [...picture.matchAll(/(?:src|srcset)="([^"]+)"/g)]
      .map(([, url]) => url!)
      .filter((url) => url.startsWith(prefix))
      .map((url) => `${PICTURES}/${url.slice(prefix.length)}`),
  );
  const body = `${pullRequest.body.slice(0, start)}${pullRequest.body.slice(end + PICTURE_END.length)}`;
  await deps.github.editPullRequestBody(target.repo, pullRequest.number, body.trim());
  for (const key of keys) await deps.storage.delete(key);
  deps.log.info("pull_request_pictures_withdrawn", { canvasId, number: pullRequest.number });
}

/**
 * Copies of the canvas's previews for a new pull request's description, under a key that opens
 * nothing else: the canvas's own asset key opens every file of it, and a description outlives
 * anyone's access to the repo, is mailed to its watchers and is read by its integrations. Only a
 * private repo's pull request gets one (whoever reads a public one need not be able to open the
 * canvas), and only once the canvas has previews. Answers the key, or null for none.
 */
async function copyPictures(
  { storage, log }: Pick<Deps, "storage" | "log">,
  { canvas, repo, assetKey }: PullRequestContext,
): Promise<string | null> {
  if (!repo?.private || canvas.previewSeq === null) return null;
  const key = randomString(32);
  try {
    for (const theme of ["light", "dark"]) {
      await storage.copy(
        `${assetKey}/previews/${canvas.previewSeq}-${theme}.png`,
        `${PICTURES}/${key}/${theme}.png`,
      );
    }
  } catch (error) {
    log.warn("pull_request_pictures_skipped", { canvasId: canvas.id, error });
    return null;
  }
  return key;
}

/**
 * A new pull request's description: the agent's summary, the canvas's first page as its
 * preview showed it (`pictures`, from `copyPictures`), and the way back to it in Ponzu.
 */
export function composeBody(
  { config }: Pick<Deps, "config">,
  { canvas }: PullRequestContext,
  pictures: string | null,
): string {
  const link = canvasLink(canvas.id);
  const name = escapeMarkdown(canvas.name);
  const parts = [`${SUMMARY_START}\n${unmarked(canvas.prSummary ?? "")}\n${SUMMARY_END}`];
  if (pictures) {
    const picture = (theme: "light" | "dark") =>
      `${config.assetsUrl}/${PICTURES}/${pictures}/${theme}.png`;
    parts.push(
      `${PICTURE_START}<a href="${link}"><picture>` +
        `<source media="(prefers-color-scheme: dark)" srcset="${picture("dark")}">` +
        `<img src="${picture("light")}" alt="${escapeHtml(canvas.name)}" width="720">` +
        `</picture></a>${PICTURE_END}`,
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
  let text = summary;
  for (const marker of [SUMMARY_START, SUMMARY_END, PICTURE_START, PICTURE_END]) {
    text = text.replaceAll(marker, "");
  }
  return text.trim();
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
