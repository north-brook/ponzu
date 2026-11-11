import { getRunnerContext, listOpenQuestions, takeRunnerLease } from "@ponzu/db";
import type { Effort, RunnerSession } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * The runner's first call (docs/cloud.md, "The runner protocol", "Session"): it takes the
 * design's lease, and is answered with everything the runner needs to start.
 */

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"] satisfies Effort[];

/** Where a design opens in Ponzu. */
export const designLink = (designId: string) => `https://ponzu.design/designs/${designId}`;

export async function startRunnerSession(
  deps: Pick<Deps, "db" | "clock" | "config">,
  designId: string,
): Promise<RunnerSession> {
  // The lease first: from here on, any runner of this design but this one is refused.
  const lease = await takeRunnerLease(deps.db, { designId, now: new Date(deps.clock.now()) });
  const [context, open] = await Promise.all([
    getRunnerContext(deps.db, designId),
    listOpenQuestions(deps.db, designId),
  ]);
  if (!context) throw new ApiError(404, "not_found", "There is no such design.");
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
  };
}

function splitName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}
