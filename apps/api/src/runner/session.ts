import { createHash } from "node:crypto";
import {
  appendThreadItemOnce,
  getClaudeAccountById,
  getRunnerContext,
  getSandbox,
  listOpenQuestions,
  type SandboxRow,
  takeRunnerLease,
} from "@ponzu/db";
import type { Effort, Notice, RunnerSession } from "@ponzu/runner/protocol";
import {
  effortOrDefault,
  type ModelOffer,
  modelLabel,
  modelOrDefault,
  offerFor,
} from "../claude/models.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { savedView } from "./checkpoint.ts";
import { modelsHeld } from "./models.ts";

/*
 * The runner's first call (docs/cloud.md, "The runner protocol", "Session"): it takes the
 * canvas's lease, and is answered with everything the runner needs to start.
 */

/** Where a canvas opens in Ponzu. */
export const canvasLink = (canvasId: string) => `https://ponzu.design/canvases/${canvasId}`;

export async function startRunnerSession(
  deps: Pick<Deps, "db" | "clock" | "config" | "log">,
  canvasId: string,
  /** What the runner said it is (`X-Ponzu-Client`), recorded with its lease. */
  client: string | null = null,
): Promise<RunnerSession> {
  // The lease first: from here on, any runner of this canvas but this one is refused.
  const lease = await takeRunnerLease(deps.db, {
    canvasId,
    now: new Date(deps.clock.now()),
    client,
  });
  const [context, open, sandbox] = await Promise.all([
    getRunnerContext(deps.db, canvasId),
    listOpenQuestions(deps.db, canvasId),
    getSandbox(deps.db, canvasId),
  ]);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  logStart(deps, canvasId, client, sandbox);
  const { canvas, repo, owner, assetKey } = context;
  const claude = canvas.claudeAccountId
    ? await getClaudeAccountById(deps.db, canvas.claudeAccountId)
    : null;
  const offer = offerFor(claude);
  const run = runsOn(offer, canvas);
  if (canvas.model !== null && run.model !== null && run.model !== canvas.model) {
    // What it was made with is no longer offered: it runs on what the account offers now.
    deps.log.info("model_unoffered", {
      canvasId,
      chosen: canvas.model,
      runs: run.model,
      reported: offer.reported,
    });
    // The thread says so, once for each change, but only when a runner has said what the
    // account offers: before that (a credential just connected again, or revoked) nobody knows
    // the model is gone, and "doesn't offer it any more" would not be true. Named here, while
    // the names are known: the model gone is no longer in what the account offers, so no app
    // could name it later.
    if (offer.reported) {
      const holder = owner && claude?.userId === owner.id ? owner : null;
      await appendThreadItemOnce(deps.db, {
        id: modelNoticeId(canvas.model, run.model),
        canvasId,
        kind: "notice",
        payload: {
          type: "model_changed",
          from: canvas.model,
          to: run.model,
          fromName: modelLabel(offer, canvas.model),
          toName: modelLabel(offer, run.model),
          account: holder
            ? { id: holder.id, name: holder.name ?? holder.githubLogin, login: holder.githubLogin }
            : null,
        } satisfies Notice,
      });
    }
  }
  const { slug, botUserId } = deps.config.githubApp;
  const committer = {
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
  const [repoOwner, repoName] = repo ? splitName(repo.fullName) : [];
  return {
    runnerId: lease.runnerId,
    canvas: { id: canvas.id, name: canvas.name },
    repo: repo ? { owner: repoOwner!, name: repoName!, defaultBranch: repo.defaultBranch } : null,
    branch: repo ? canvas.branch : null,
    claudeSessionId: lease.claudeSessionId,
    model: run.model,
    effort: run.effort,
    // A canvas whose owner is gone is still worked on; its commits are then the App's own.
    author: owner
      ? {
          name: owner.name ?? owner.githubLogin,
          email: `${owner.githubUserId}+${owner.githubLogin}@users.noreply.github.com`,
        }
      : committer,
    committer,
    assetBase: `${deps.config.assetsUrl}/${assetKey}`,
    link: canvasLink(canvas.id),
    // Nothing records the theme of a person's canvas yet.
    theme: null,
    openQuestions: open.map((question) => question.id),
    seq: canvas.seq,
    saved: lease.saved ? savedView(lease.saved) : null,
    workspaceId: canvas.workspaceId,
    // Public values: the runner reports each turn's trace to LLM analytics itself.
    analytics: deps.config.posthog
      ? {
          key: deps.config.posthog.key,
          host: deps.config.posthog.host,
          content: deps.config.posthog.aiContent,
        }
      : null,
    models: modelsHeld(claude),
  };
}

/**
 * What a canvas's turns run on: what it was made with while its account offers that, or what
 * the account runs in its place; nothing chosen is Claude Code's own default. The effort is the
 * one chosen while the model takes it.
 */
export function runsOn(
  offer: ModelOffer,
  canvas: { model: string | null; effort: string | null },
): { model: string | null; effort: Effort | null } {
  const model = canvas.model === null ? null : modelOrDefault(offer, canvas.model);
  const effort =
    canvas.effort === null
      ? null
      : effortOrDefault(offer, model ?? offer.defaultModel, canvas.effort);
  return { model, effort };
}

/**
 * The id of the notice that a canvas made on `chosen` now runs on `runs`: the same for the same
 * change, so every start after it writes nothing more, and a change to another model is another
 * notice. A runner's ids are `ti_` and sixteen letters and digits, so no sandbox can take it.
 */
export function modelNoticeId(chosen: string, runs: string): string {
  const hash = createHash("sha256").update(`${chosen}→${runs}`).digest("hex");
  return `ti_model-${hash.slice(0, 12)}`;
}

/** Which runner started, in which session, on which image, and what it says it is. */
function logStart(
  deps: Pick<Deps, "log">,
  canvasId: string,
  client: string | null,
  sandbox: SandboxRow | null,
) {
  deps.log.info("runner_started", {
    canvasId,
    sessionId: sandbox?.sessionId ?? null,
    image: sandbox?.image ?? null,
    client,
  });
}

function splitName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}
