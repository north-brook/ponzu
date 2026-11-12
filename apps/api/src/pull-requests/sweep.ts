import { enqueueJob, listStalePullRequests, recordOnce } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { REFRESH_JOB } from "./refresh.ts";

/*
 * The sweep for pull requests whose webhooks were all lost (docs/cloud.md, "Pull requests").
 * GitHub's deliveries can fail for good (an outage, a deploy at the wrong moment, a secret being
 * rotated), and a pull request nobody reads again would show open for ever after it merged. So
 * each minute the cron reads again a few open pull requests that nobody has read from GitHub for
 * a quarter of an hour, by recording the same read a webhook would (`pull_request.refresh`), for
 * the next minute's jobs to make.
 *
 * Each read is one GraphQL point of the canvas's installation (5,000 an hour), so 20 a minute is
 * the most a deployment spends on it, spread over every installation. A quiet pull request is
 * read again once a window, which is all its webhooks being lost could cost: 300 of them a
 * window before the oldest are read twice as seldom.
 */

/** How long a pull request may go unread before the sweep reads it, and the sweep's window. */
export const SWEEP_STALE_MS = 15 * 60_000;
/** The most pull requests one minute's sweep reads again. */
export const SWEEP_LIMIT = 20;
/** The mark that a window's sweep took a canvas, so the next minute moves on to others. */
export const SWEPT_KIND = "pull_request.sweep";

/**
 * Record a read of each stale open pull request, at most `limit`, each once a window. Answers
 * how many reads it recorded. A canvas with a read already waiting is left to it.
 */
export async function sweepPullRequests(
  { db, log }: Pick<Deps, "db" | "log">,
  now: Date,
  { limit = SWEEP_LIMIT }: { limit?: number } = {},
): Promise<number> {
  const at = now.getTime();
  const window = new Date(at - (at % SWEEP_STALE_MS)).toISOString();
  const stale = await listStalePullRequests(db, {
    readBefore: new Date(at - SWEEP_STALE_MS),
    refreshKind: REFRESH_JOB,
    sweptKind: SWEPT_KIND,
    window,
    limit,
  });
  let swept = 0;
  for (const { canvasId, number } of stale) {
    // An overlapping run took this one first.
    if (!(await recordOnce(db, { kind: SWEPT_KIND, key: `${canvasId}@${window}` }))) continue;
    const job = await enqueueJob(db, {
      kind: REFRESH_JOB,
      key: `sweep:${canvasId}:${window}`,
      payload: { canvasId, number },
      runAt: now,
    });
    if (job) swept++;
  }
  if (swept > 0) log.info("pr_swept", { count: swept });
  return swept;
}
