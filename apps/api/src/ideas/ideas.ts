import { claimRepoIdeas, type RepoIdeasRow, releaseRepoIdeas, saveRepoIdeas } from "@ponzu/db";
import type { z } from "zod";
import { stableUuid } from "../analytics/analytics.ts";
import type { Deps } from "../deps/index.ts";
import type { Model, StructuredAnswer } from "../deps/model.ts";
import type { Logger } from "../http/log.ts";
import { checkIdeas, IdeasOutput, type IdeasRequest, ideasRequest } from "./prompt.ts";
import { readRepository } from "./read-repo.ts";

type IdeasAnswer = z.infer<typeof IdeasOutput>;

/*
 * A repo's ideas (docs/cloud.md, "Ideas"): four prompts to start a design from, made for the
 * repo by a small fast model on Ponzu's own key, kept on its row for everyone who can read it.
 * They are made lazily, the first time anyone asks, in the background: the asker hears
 * `generating` at once and asks again. One instance at a time makes them (the claim in the
 * row), within a workspace's allowance, and every failure is quiet: nothing new is kept and
 * the screen shows no ideas. A failure to get an answer (GitHub or the model down, the
 * deadline) is tried again an hour later; answers turned away twice wait for a push, or a
 * week when they leave the repo with none.
 *
 * Every repo the App can read gets four, however little is in it: a product not built yet gets
 * where to begin designing it (`FRESH_SYSTEM_PROMPT`).
 */

/**
 * The way ideas are made, kept with them (`repos.ideas_version`). An empty list an earlier way
 * wrote is made again at the next ask, push or not. 1: a repo with nothing built yet gets
 * ideas, where before it got none, so those it was skipped for get theirs.
 */
export const IDEAS_VERSION = 1;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const IDEAS_POLICY = {
  /** A claim this young is a generation under way: what `generating` means. */
  generatingMs: 60_000,
  /** The longest one generation may take, the read of the repo included. */
  timeoutMs: 45_000,
  /** How long after one try (that worked or not) the next may begin. */
  retryMs: HOUR,
  /**
   * Ideas this old are made again once the repo has been pushed to since: a month of work
   * may have changed what it is. An empty list is made again after any push, once `retryMs`
   * has passed. A repo nobody pushes to keeps its ideas; nobody's visit alone remakes them.
   */
  staleMs: 30 * DAY,
  /**
   * An empty list (both answers turned away, with none from before) is made again this long
   * after, pushed or not: a repo with little in it is the kind nobody pushes to, and one
   * unlucky pair of answers must not leave it with no ideas for good.
   */
  emptyRetryMs: 7 * DAY,
  /** Each workspace may start this many generations an hour, whatever it has in repos. */
  windowMs: HOUR,
  windowLimit: 20,
} as const;

/** What `GET /v1/repos/:id/ideas` answers. */
export type IdeasStatus = "ready" | "generating" | "none";

/** What LLM analytics calls the model calls made here. */
export const IDEAS_FEATURE = "repo_ideas";

/** What the read and the answer may write: room for thinking, and four short lines. */
const MAX_TOKENS = 4_000;
/** One answer that breaks a rule is asked for again, once. */
const ATTEMPTS = 2;

type IdeasDeps = Pick<Deps, "db" | "clock" | "github" | "model" | "background" | "analytics">;

/**
 * The repo's ideas as the person may see them now, starting their generation if they are due.
 * The caller has checked the person may read the repo (`requireRepo`). `installationId` is the
 * App's on the repo's workspace, or null while Ponzu can reach none of its repos.
 */
export async function repoIdeas(
  deps: IdeasDeps,
  log: Logger,
  { repo, installationId }: { repo: RepoIdeasRow; installationId: number | null },
): Promise<{ status: IdeasStatus; ideas: string[] }> {
  const now = deps.clock.now();
  if (installationId !== null && isDue(repo, now)) {
    const claim = await claimRepoIdeas(deps.db, {
      repoId: repo.id,
      now: new Date(now),
      retryBefore: new Date(now - IDEAS_POLICY.retryMs),
      staleBefore: new Date(now - IDEAS_POLICY.staleMs),
      emptyBefore: new Date(now - IDEAS_POLICY.emptyRetryMs),
      windowStartedBefore: new Date(now - IDEAS_POLICY.windowMs),
      windowLimit: IDEAS_POLICY.windowLimit,
      version: IDEAS_VERSION,
    });
    if (claim === "claimed") {
      const claimedAt = new Date(now);
      deps.background("ideas", generateRepoIdeas(deps, log, { repo, installationId, claimedAt }));
      return repo.ideas.length
        ? { status: "ready", ideas: repo.ideas }
        : { status: "generating", ideas: [] };
    }
    if (claim === "rate_limited") {
      log.warn("ideas_rate_limited", { repoId: repo.id, workspaceId: repo.workspaceId });
      // Every read of a due repo says this while the limit holds: said once per repo and window
      // (one id, time and nobody's), so how often the app reads is not what PostHog counts.
      const window = Math.floor(now / IDEAS_POLICY.windowMs) * IDEAS_POLICY.windowMs;
      deps.analytics.capture(
        "ideas skipped",
        { repo_id: repo.id, reason: "rate_limited" },
        {
          distinctId: null,
          workspaceId: repo.workspaceId,
          timestamp: new Date(window),
          uuid: stableUuid(`${repo.id}/ideas/rate_limited/${window}`),
        },
      );
    } else if (!repo.ideas.length) {
      // Due when this request read the row, and no longer: someone else claimed it meanwhile.
      return { status: "generating", ideas: [] };
    }
  }
  if (repo.ideas.length) return { status: "ready", ideas: repo.ideas };
  return { status: isGenerating(repo, now) ? "generating" : "none", ideas: [] };
}

/** Whether the repo's ideas should be made now, by `IDEAS_POLICY`: what the claim checks again. */
function isDue(repo: RepoIdeasRow, now: number): boolean {
  if (repo.ideasClaimedAt && repo.ideasClaimedAt.getTime() > now - IDEAS_POLICY.retryMs) {
    return false;
  }
  const generated = repo.ideasGeneratedAt;
  if (!generated) return true;
  if (repo.ideas.length === 0) {
    if (repo.ideasVersion < IDEAS_VERSION) return true;
    if (generated.getTime() <= now - IDEAS_POLICY.emptyRetryMs) return true;
  }
  if (!repo.pushedAt || repo.pushedAt <= generated) return false;
  return repo.ideas.length === 0 || generated.getTime() <= now - IDEAS_POLICY.staleMs;
}

/** A generation was claimed lately and has not written yet. */
function isGenerating(repo: RepoIdeasRow, now: number): boolean {
  const claimed = repo.ideasClaimedAt;
  if (!claimed || claimed.getTime() <= now - IDEAS_POLICY.generatingMs) return false;
  return !repo.ideasGeneratedAt || repo.ideasGeneratedAt < claimed;
}

/**
 * Make and keep a repo's ideas, as the holder of the claim taken at `claimedAt`. Never throws:
 * a failure is logged and nothing is kept.
 */
export async function generateRepoIdeas(
  deps: Pick<Deps, "db" | "clock" | "github" | "model" | "analytics">,
  log: Logger,
  {
    repo,
    installationId,
    claimedAt,
  }: { repo: RepoIdeasRow; installationId: number; claimedAt: Date },
): Promise<void> {
  const started = deps.clock.now();
  const deadline = deps.clock.timeout(IDEAS_POLICY.timeoutMs);
  const ids = { repoId: repo.id, workspaceId: repo.workspaceId };
  const tally: Tally = { attempts: 0, usage: { input: 0, output: 0 } };
  const skipped = (reason: "rejected" | "failed") =>
    deps.analytics.capture(
      "ideas skipped",
      { repo_id: repo.id, reason },
      { workspaceId: repo.workspaceId },
    );
  try {
    // Only this repo, only to read: the token is used for these few reads and never kept.
    const { token } = await deps.github.createInstallationToken({
      installationId,
      repositoryIds: [repo.githubRepoId],
      permissions: { contents: "read", metadata: "read" },
    });
    const snapshot = await beforeDeadline(
      readRepository(deps.github, token, repo.fullName),
      deadline,
    );
    const request = ideasRequest(snapshot);
    const asked = await askForIdeas(deps.model, request, {
      signal: deadline,
      tally,
      workspaceId: repo.workspaceId,
    });
    let ideas: string[];
    const rejected = "rejected" in asked;
    if ("rejected" in asked) {
      log.warn("ideas_rejected", {
        ...ids,
        model: deps.model.id,
        ...tally,
        fresh: request.fresh,
        reason: asked.rejected,
      });
      // Asking about the same material again would most likely be turned away again, so
      // this counts as a generation: the ideas it had stay (none, the first time), and the
      // next try waits for a push, or `emptyRetryMs` when it has none.
      ideas = repo.ideas;
    } else {
      ideas = asked.ideas;
    }
    const saved = await saveRepoIdeas(deps.db, {
      repoId: repo.id,
      ideas,
      generatedAt: new Date(deps.clock.now()),
      claimedAt,
      version: IDEAS_VERSION,
    });
    if (rejected) skipped("rejected");
    else {
      const ms = deps.clock.now() - started;
      log.info("ideas_generated", {
        ...ids,
        model: deps.model.id,
        ...tally,
        fresh: request.fresh,
        ideas: ideas.length,
        saved,
        ms,
      });
      if (saved && ideas.length > 0) {
        deps.analytics.capture(
          "ideas generated",
          {
            repo_id: repo.id,
            count: ideas.length,
            duration_ms: ms,
            attempts: tally.attempts,
            input_tokens: tally.usage.input,
            output_tokens: tally.usage.output,
          },
          { workspaceId: repo.workspaceId },
        );
      }
    }
  } catch (error) {
    skipped("failed");
    log.warn("ideas_failed", {
      ...ids,
      model: deps.model.id,
      ...tally,
      timedOut: deadline.aborted,
      error,
    });
    await release(deps, repo.id, claimedAt).catch((cause) => {
      log.warn("ideas_release_failed", { ...ids, error: cause });
    });
  }
}

/** How many times the model was asked, and what that cost in tokens. */
export interface Tally {
  attempts: number;
  usage: { input: number; output: number };
}

/**
 * Four ideas for the product `request` describes (`ideasRequest`), or why there are none: one
 * answer that breaks a rule is asked for again, once, with the rule it broke, and the second
 * is the last. What each ask cost is added to `tally`, so it is known even when one throws.
 */
export async function askForIdeas(
  model: Model,
  { instructions, prompt, fresh }: IdeasRequest,
  {
    signal,
    tally,
    workspaceId = null,
  }: { signal?: AbortSignal; tally: Tally; workspaceId?: string | null },
): Promise<{ ideas: string[] } | { rejected: string }> {
  let rejected = "";
  while (tally.attempts < ATTEMPTS) {
    tally.attempts++;
    const answer: StructuredAnswer<IdeasAnswer> = await model.structured({
      instructions: rejected
        ? `${instructions}\n\nAn earlier answer was turned away because ${rejected}. Keep to every rule.`
        : instructions,
      prompt,
      schema: IdeasOutput,
      maxTokens: MAX_TOKENS,
      // Medium read more of the material than low on real repos (sharper, more varied ideas),
      // for under a tenth of a cent and a few more seconds, off the request's path.
      effort: "medium",
      signal,
      feature: { name: IDEAS_FEATURE, workspaceId },
    });
    tally.usage.input += answer.usage.input;
    tally.usage.output += answer.usage.output;
    const checked: ReturnType<typeof checkIdeas> = answer.output
      ? checkIdeas(answer.output, { fresh, instructions })
      : { ok: false, reason: `it was not in the shape asked for (${answer.finishReason})` };
    if (checked.ok) return { ideas: checked.ideas };
    rejected = checked.reason;
  }
  return { rejected };
}

/**
 * The try kept nothing: it stops reading as `generating` at once, so the screen stops waiting,
 * and the next may begin `retryMs` after it began.
 */
function release(deps: Pick<Deps, "db">, repoId: string, claimedAt: Date) {
  const to = new Date(claimedAt.getTime() - IDEAS_POLICY.generatingMs);
  return releaseRepoIdeas(deps.db, { repoId, claimedAt, to });
}

/** `work`, or a rejection once `deadline` aborts, whichever is first. */
function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) return Promise.reject(deadline.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        deadline.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
