import { redactText } from "@ponzu/core/redact";
import { claimRepoIdeas, type RepoIdeasRow, releaseRepoIdeas, saveRepoIdeas } from "@ponzu/db";
import type { z } from "zod";
import { stableUuid } from "../analytics/analytics.ts";
import type { Deps } from "../deps/index.ts";
import type { Model, StructuredAnswer } from "../deps/model.ts";
import type { Logger } from "../http/log.ts";
import { gateIdeas } from "./gate.ts";
import {
  checkIdeas,
  IdeasOutput,
  type IdeasRequest,
  ideasRequest,
  RETRY_REASONS,
  type RejectCode,
} from "./prompt.ts";
import { readRepository } from "./read-repo.ts";

type IdeasAnswer = z.infer<typeof IdeasOutput>;

/*
 * A repo's ideas (docs/cloud.md, "Ideas"): four prompts to start a design from, made for the
 * repo by a small fast model on Ponzu's own key, kept on its row for everyone who can read it.
 * They are made lazily, the first time anyone asks, in the background: the asker hears
 * `generating` at once and asks again. One instance at a time makes them (the claim in the
 * row), within a workspace's allowance, and every failure is quiet: nothing new is kept and
 * the screen shows no ideas.
 *
 * What reaches a person passes the exact checks (`checkIdeas`) and then the gate (gate.ts), a
 * stronger model that says of each idea whether it is safe and a design. An answer either fails
 * is asked for again once, with Ponzu's own sentence for what failed. Then:
 * - every idea passes: all four are kept;
 * - some fail only as designs: those that pass are kept, one to four;
 * - one is unsafe in the last answer the gate read: the repository is steering the ideas, so
 *   none of this generation's are kept (`ideas_withheld`);
 * - nothing passes: none are kept (`ideas_rejected`).
 * The last two count as a generation, keeping the ideas there were: the next waits for a push,
 * or a day when the repo is left with none. A failure to get an answer at all (GitHub, the model
 * or the gate down or out of shape, the deadline) is tried again an hour later.
 *
 * Every repo the App can read gets ideas, however little is in it: a product not built yet gets
 * where to begin designing it (`FRESH_SYSTEM_PROMPT`).
 */

/**
 * The way ideas are made, kept with them (`repos.ideas_version`). An empty list an earlier way
 * wrote is made again at the next ask, push or not. 1: a repo with nothing built yet gets
 * ideas, where before it got none, so those it was skipped for get theirs. 2: a product may be
 * named by its own name even when that is a word like "ponzu" or "gpt". 3: the pattern rules
 * (banned words, openers, five-word echoes, addresses, file names) are gone, and a gate judges
 * what reaches a person, so every list they left empty is made again.
 */
export const IDEAS_VERSION = 3;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const IDEAS_POLICY = {
  /** A claim this young is a generation under way: what `generating` means. */
  generatingMs: 75_000,
  /** The longest one generation may take: the read, two asks and two checks by the gate. */
  timeoutMs: 60_000,
  /** How long after one try (that worked or not) the next may begin. */
  retryMs: HOUR,
  /**
   * Ideas are made again when the repo's default branch has moved since (GitHub's push webhook
   * says when), once `retryMs` has passed since the last try: what they were made from changed.
   * A push to another branch (a design's own, say) changes nothing they were made from, and is
   * only known from the repo list's `pushed_at`; it counts once the ideas are this old, which
   * also catches a default-branch push whose webhook never came. An empty list is made again
   * after any push. A repo nobody pushes to keeps its ideas; nobody's visit alone remakes them.
   */
  staleMs: 30 * DAY,
  /**
   * An empty list (nothing passed, or the gate withheld it, with none from before) is made
   * again this long after, pushed or not: a repo with little in it is the kind nobody pushes to,
   * and one unlucky pair of answers must not leave it with no ideas for long.
   */
  emptyRetryMs: DAY,
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
/** One answer that fails a check or the gate is asked for again, once. */
const ATTEMPTS = 2;
/** How much of a gate's reason a log line keeps. */
const REASON_LOGGED = 300;

type IdeasDeps = Pick<
  Deps,
  "db" | "clock" | "github" | "model" | "reviewer" | "background" | "analytics"
>;

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
  if (repo.defaultPushedAt && repo.defaultPushedAt > generated) return true;
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
  deps: Pick<Deps, "db" | "clock" | "github" | "model" | "reviewer" | "analytics">,
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
  const tally = newTally();
  const models = { model: deps.model.id, reviewer: deps.reviewer.id };
  const skipped = (reason: "rejected" | "unsafe" | "failed") =>
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
    const asked = await askForIdeas({ writer: deps.model, reviewer: deps.reviewer }, request, {
      signal: deadline,
      tally,
      workspaceId: repo.workspaceId,
    });
    if (asked.kind === "withheld") {
      // The repository steered an idea into asking the reader for something. What the gate
      // said goes to the logs only, redacted and clipped: it may quote the repository.
      log.warn("ideas_withheld", {
        ...ids,
        ...models,
        ...tally,
        fresh: request.fresh,
        failures: logged(asked.failures),
      });
    } else if (asked.kind === "rejected") {
      log.warn("ideas_rejected", {
        ...ids,
        ...models,
        ...tally,
        fresh: request.fresh,
        codes: asked.codes,
        failures: logged(asked.failures),
      });
    }
    // Nothing kept counts as a generation: the ideas there were stay (none, the first time),
    // and the next try waits for a push, or `emptyRetryMs` when the repo has none.
    const ideas = asked.kind === "kept" ? asked.ideas : repo.ideas;
    const saved = await saveRepoIdeas(deps.db, {
      repoId: repo.id,
      ideas,
      // As of the claim, taken before the repo was read: a push that lands while these are
      // being made is then newer than them, and they are made again.
      generatedAt: claimedAt,
      claimedAt,
      version: IDEAS_VERSION,
    });
    if (asked.kind === "withheld") skipped("unsafe");
    else if (asked.kind === "rejected") skipped("rejected");
    else {
      const ms = deps.clock.now() - started;
      log.info("ideas_generated", {
        ...ids,
        ...models,
        ...tally,
        fresh: request.fresh,
        ideas: ideas.length,
        ...(asked.failures.length ? { failures: logged(asked.failures) } : {}),
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
      ...models,
      ...tally,
      timedOut: deadline.aborted,
      error,
    });
    await release(deps, repo.id, claimedAt).catch((cause) => {
      log.warn("ideas_release_failed", { ...ids, error: cause });
    });
  }
}

/** How many times the models were asked, and what that cost in tokens. */
export interface Tally {
  /** Asks of the model that writes the ideas. */
  attempts: number;
  usage: { input: number; output: number };
  /** Checks by the gate, and what they cost. */
  gate: { calls: number; usage: { input: number; output: number } };
}

export const newTally = (): Tally => ({
  attempts: 0,
  usage: { input: 0, output: 0 },
  gate: { calls: 0, usage: { input: 0, output: 0 } },
});

/** An idea the gate failed: its number (1 to 4), what it failed, and the gate's reason. */
export interface GateFailure {
  idea: number;
  criteria: ("safe" | "visible")[];
  reason: string;
}

/** What asking came to (see the top of this file for what each means). */
export type Asked =
  | { kind: "kept"; ideas: string[]; failures: GateFailure[] }
  | { kind: "withheld"; failures: GateFailure[] }
  | { kind: "rejected"; codes: RejectCode[]; failures: GateFailure[] };

/**
 * Ideas for the product `request` describes (`ideasRequest`), checked exactly and then by the
 * gate. An answer that fails either is asked for again, once, with Ponzu's fixed sentence for
 * what failed (`RETRY_REASONS`): never the answer's words or the gate's, which may quote the
 * repository. What each call cost is added to `tally`, so it is known even when one throws. A
 * gate that gives no verdict throws: that is a failed generation, never a verdict.
 */
export async function askForIdeas(
  { writer, reviewer }: { writer: Model; reviewer: Model },
  { instructions, prompt, product }: IdeasRequest,
  {
    signal,
    tally,
    workspaceId = null,
  }: { signal?: AbortSignal; tally: Tally; workspaceId?: string | null },
): Promise<Asked> {
  let codes: RejectCode[] = [];
  /** The answer whose ideas failed only as designs, with the most that passed. */
  let best: { ideas: string[]; failures: GateFailure[] } | null = null;
  /** What the gate found in the last answer it read. */
  let last: GateFailure[] | null = null;
  while (tally.attempts < ATTEMPTS) {
    tally.attempts++;
    const answer: StructuredAnswer<IdeasAnswer> = await writer.structured({
      instructions: codes.length
        ? `${instructions}\n\nAn earlier answer was turned away: ${codes.map((code) => RETRY_REASONS[code]).join("; ")}. Keep to every rule.`
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
    const checked = answer.output
      ? checkIdeas(answer.output)
      : ({ ok: false, code: "shape" } as const);
    if (!checked.ok) {
      codes = [checked.code];
      continue;
    }
    tally.gate.calls++;
    const gated = await gateIdeas(reviewer, product, checked.ideas, { signal, workspaceId });
    tally.gate.usage.input += gated.usage.input;
    tally.gate.usage.output += gated.usage.output;
    const failures = gated.verdicts.flatMap((verdict, i): GateFailure[] => {
      const criteria = [
        ...(verdict.safe ? [] : (["safe"] as const)),
        ...(verdict.visible ? [] : (["visible"] as const)),
      ];
      return criteria.length ? [{ idea: i + 1, criteria, reason: verdict.reason }] : [];
    });
    last = failures;
    if (!failures.length) return { kind: "kept", ideas: checked.ideas, failures };
    const unsafe = failures.some((failure) => failure.criteria.includes("safe"));
    if (!unsafe) {
      const passing = checked.ideas.filter((_, i) => !failures.some((f) => f.idea === i + 1));
      if (!best || passing.length >= best.ideas.length) best = { ideas: passing, failures };
    }
    codes = [unsafe ? "unsafe" : "not_visible"];
  }
  if (last?.some((failure) => failure.criteria.includes("safe"))) {
    return { kind: "withheld", failures: last };
  }
  if (best?.ideas.length) return { kind: "kept", ideas: best.ideas, failures: best.failures };
  return { kind: "rejected", codes, failures: last ?? [] };
}

/** The gate's failures as a log line keeps them: its reasons redacted and clipped. */
function logged(failures: readonly GateFailure[]) {
  return failures.map(({ idea, criteria, reason }) => ({
    idea,
    criteria,
    reason: redactText(reason).slice(0, REASON_LOGGED),
  }));
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
