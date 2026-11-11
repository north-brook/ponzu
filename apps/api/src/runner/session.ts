import {
  getLiveSandbox,
  getRunnerContext,
  listOpenQuestions,
  type Sandbox,
  takeRunnerLease,
} from "@ponzu/db";
import type { Effort, RunnerSession } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { savedView } from "./checkpoint.ts";
import { runnerImage } from "./client.ts";

/*
 * The runner's first call (docs/cloud.md, "The runner protocol", "Session"): it takes the
 * design's lease, and is answered with everything the runner needs to start.
 */

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"] satisfies Effort[];

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
    getLiveSandbox(deps.db, designId),
  ]);
  if (!context) throw new ApiError(404, "not_found", "There is no such design.");
  logStart(deps, designId, client, sandbox);
  const { design, repo, owner, assetKey } = context;
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
    model: design.model,
    effort: design.effort && EFFORTS.includes(design.effort) ? (design.effort as Effort) : null,
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
  };
}

/**
 * Which runner started, in which image, against the image its sandbox was made from. A runner
 * that says another image than its sandbox's is logged as a mismatch: a sandbox recorded wrong,
 * or an image that was changed under its name. One that says none is older than saying so.
 * While a move is under way the design's row is still the old sandbox's, so a runner starting
 * in the new one is not a mismatch.
 */
function logStart(
  deps: Pick<Deps, "log">,
  designId: string,
  client: string | null,
  sandbox: Sandbox | null,
) {
  const reported = runnerImage(client);
  const fields = {
    designId,
    sandboxId: sandbox?.id ?? null,
    generation: sandbox?.generation ?? null,
    client,
    runnerImage: reported,
    sandboxImage: sandbox?.image ?? null,
  };
  const moving = sandbox?.movingSince != null;
  if (reported && sandbox?.image && reported !== sandbox.image && !moving) {
    deps.log.warn("runner_image_mismatch", fields);
  } else {
    deps.log.info("runner_started", fields);
  }
}

function splitName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}
