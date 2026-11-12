import {
  getClaudeAccountById,
  getRunnerContext,
  getSandbox,
  listOpenQuestions,
  type SandboxRow,
  takeRunnerLease,
} from "@ponzu/db";
import type { Effort, RunnerSession } from "@ponzu/runner/protocol";
import { effortOrDefault, type ModelOffer, modelOrDefault, offerFor } from "../claude/models.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { savedView } from "./checkpoint.ts";
import { modelsHeld } from "./models.ts";

/*
 * The runner's first call (docs/cloud.md, "The runner protocol", "Session"): it takes the
 * design's lease, and is answered with everything the runner needs to start.
 */

/** Where a design opens in Ponzu. */
export const designLink = (designId: string) => `https://ponzu.design/designs/${designId}`;

export async function startRunnerSession(
  deps: Pick<Deps, "db" | "clock" | "config" | "log">,
  designId: string,
  /** What the runner said it is (`X-Ponzu-Client`), recorded with its lease. */
  client: string | null = null,
): Promise<RunnerSession> {
  // The lease first: from here on, any runner of this design but this one is refused.
  const lease = await takeRunnerLease(deps.db, {
    designId,
    now: new Date(deps.clock.now()),
    client,
  });
  const [context, open, sandbox] = await Promise.all([
    getRunnerContext(deps.db, designId),
    listOpenQuestions(deps.db, designId),
    getSandbox(deps.db, designId),
  ]);
  if (!context) throw new ApiError(404, "not_found", "There is no such design.");
  logStart(deps, designId, client, sandbox);
  const { design, repo, owner, assetKey } = context;
  const claude = design.claudeAccountId
    ? await getClaudeAccountById(deps.db, design.claudeAccountId)
    : null;
  const run = runsOn(offerFor(claude), design);
  if (design.model !== null && run.model !== design.model) {
    // What it was made with is no longer offered: it runs on what the account offers now.
    deps.log.info("model_unoffered", { designId, chosen: design.model, runs: run.model });
  }
  const { slug, botUserId } = deps.config.githubApp;
  const committer = {
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
  const [repoOwner, repoName] = repo ? splitName(repo.fullName) : [];
  return {
    runnerId: lease.runnerId,
    design: { id: design.id, name: design.name },
    repo: repo ? { owner: repoOwner!, name: repoName!, defaultBranch: repo.defaultBranch } : null,
    branch: repo ? design.branch : null,
    claudeSessionId: lease.claudeSessionId,
    model: run.model,
    effort: run.effort,
    // A design whose owner is gone is still worked on; its commits are then the App's own.
    author: owner
      ? {
          name: owner.name ?? owner.githubLogin,
          email: `${owner.githubUserId}+${owner.githubLogin}@users.noreply.github.com`,
        }
      : committer,
    committer,
    assetBase: `${deps.config.assetsUrl}/${assetKey}`,
    link: designLink(design.id),
    // Nothing records the theme of a person's canvas yet.
    theme: null,
    openQuestions: open.map((question) => question.id),
    seq: design.seq,
    saved: lease.saved ? savedView(lease.saved) : null,
    workspaceId: design.workspaceId,
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
 * What a design's turns run on: what it was made with while its account offers that, or what
 * the account runs in its place; nothing chosen is Claude Code's own default. The effort is the
 * one chosen while the model takes it.
 */
export function runsOn(
  offer: ModelOffer,
  design: { model: string | null; effort: string | null },
): { model: string | null; effort: Effort | null } {
  const model = design.model === null ? null : modelOrDefault(offer, design.model);
  const effort =
    design.effort === null
      ? null
      : effortOrDefault(offer, model ?? offer.defaultModel, design.effort);
  return { model, effort };
}

/** Which runner started, in which session, on which image, and what it says it is. */
function logStart(
  deps: Pick<Deps, "log">,
  designId: string,
  client: string | null,
  sandbox: SandboxRow | null,
) {
  deps.log.info("runner_started", {
    designId,
    sessionId: sandbox?.sessionId ?? null,
    image: sandbox?.image ?? null,
    client,
  });
}

function splitName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}
