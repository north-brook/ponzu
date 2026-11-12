import { enqueueJob, markBaseForRebuild } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { type JobDeps, type RunningJob, runJob } from "../jobs/run.ts";

/*
 * Rebuilding a repo's base (docs/cloud.md, "Environments"): Settings' Rebuild records the
 * intent as a job and answers at once. The sandbox side of building a base, Claude setting the
 * repo up again from its default branch and the result saved as its snapshot, is not built
 * yet. Until it is, the job's handler does only what can be done now: it marks the base to be
 * rebuilt at the repo's next start (`repos.base_rebuild_requested_at`), which nothing reads
 * yet. Canvases that have a sandbox keep it either way.
 */

/** The job a rebuild is. One waits per repo: its key is the repo's id. */
export const BASE_REBUILD_JOB = "repo.base_rebuild";

/** Record a rebuild of the repo's base and run it in the background. */
export async function requestBaseRebuild(
  deps: JobDeps & Pick<Deps, "background">,
  repoId: string,
): Promise<void> {
  const worker = `rebuild:${crypto.randomUUID()}`;
  const job = await enqueueJob(deps.db, {
    kind: BASE_REBUILD_JOB,
    key: repoId,
    payload: { repoId },
    runAt: new Date(deps.clock.now()),
    lockedBy: worker,
  });
  // Null when one is already waiting: that one will do.
  if (job) deps.background("base_rebuild", runJob(deps, job, worker));
}

/**
 * The rebuild job's handler, for now only a mark: the base is to be rebuilt at the repo's next
 * start. Safe to repeat.
 */
export async function runBaseRebuildJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
): Promise<void> {
  await markBaseForRebuild(deps.db, {
    repoId: String(payload.repoId),
    now: new Date(deps.clock.now()),
  });
}
