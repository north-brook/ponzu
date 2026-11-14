import { enqueueJob } from "@ponzu/db";
import { z } from "zod";
import { type JobDeps, runJob } from "../jobs/run.ts";
import { refreshLinkedPullRequest, refreshPullRequest } from "./sync.ts";

/*
 * Reading canvases' pull requests again when GitHub says something about them changed, as jobs
 * (`jobs/run.ts`), so that a read that fails is tried again.
 *
 * GitHub sends a webhook for every check that finishes, so one push to a branch with twenty
 * checks is forty deliveries within minutes, and every read is a point of the installation's
 * 5,000 an hour of GraphQL. So deliveries are folded into windows of two seconds: the first
 * about a canvas in a window records one read for the window's end and makes it then; the rest
 * find that read recorded and leave it. A read that begins at the window's end sees everything
 * delivered in it.
 */

/**
 * The job that reads a canvas's pull request again. Its key is the canvas's id and a time, or,
 * for a linked one, `link:<canvas>:<repo>:<number>` and a time.
 */
export const REFRESH_JOB = "pull_request.refresh";
export const REFRESH_WINDOW_MS = 2_000;
/** How many canvases one delivery reads at once (a push to a default branch reads up to 50). */
const AT_ONCE = 4;

const Request = z.union([
  z.object({
    canvasId: z.string(),
    number: z.number().int().nullable(),
    repoId: z.undefined().optional(),
  }),
  /** A linked pull request (docs/cloud.md, "Linked pull requests"): the link names it whole. */
  z.object({ canvasId: z.string(), repoId: z.string(), number: z.number().int().positive() }),
]);

/**
 * A canvas whose pull request to read again: its branch's, where `number` is the one a webhook
 * named, if any; or, with `repoId`, one it links.
 */
export type RefreshRequest = z.infer<typeof Request>;

/** The key a request's job is recorded under, before the window's time. */
export function requestKey(request: RefreshRequest): string {
  return request.repoId === undefined
    ? request.canvasId
    : `link:${request.canvasId}:${request.repoId}:${request.number}`;
}

/** Runs a recorded read. */
export async function runRefreshJob(deps: JobDeps, payload: unknown): Promise<void> {
  const request = Request.parse(payload);
  if (request.repoId !== undefined) {
    await refreshLinkedPullRequest(deps, request);
    return;
  }
  await refreshPullRequest(deps, request.canvasId, { number: request.number });
}

/**
 * Read these canvases' pull requests again at the end of the current window, a few at a time,
 * unless a read at that time is already recorded for one. Each read is a job held here and run
 * here; one that fails is left to the cron to try again, and the rest go on.
 */
export async function refreshSoon(deps: JobDeps, requests: RefreshRequest[]): Promise<void> {
  const { db, clock } = deps;
  const at = (Math.floor(clock.now() / REFRESH_WINDOW_MS) + 1) * REFRESH_WINDOW_MS;
  const waiting = [...requests];
  async function readNext(): Promise<void> {
    for (let request = waiting.shift(); request; request = waiting.shift()) {
      const key = `${requestKey(request)}@${at}`;
      const worker = `${REFRESH_JOB}:${key}`;
      const job = await enqueueJob(db, {
        kind: REFRESH_JOB,
        key,
        payload: request,
        runAt: new Date(at),
        lockedBy: worker,
      });
      if (!job) continue;
      await clock.sleep(Math.max(0, at - clock.now()));
      await runJob(deps, job, worker);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, waiting.length) }, readNext));
}

/** Record a read of one canvas's pull request `afterMs` from now, for the cron to make. */
export async function refreshLater(
  { db, clock }: Pick<JobDeps, "db" | "clock">,
  request: RefreshRequest,
  afterMs: number,
): Promise<void> {
  const at = clock.now() + afterMs;
  await enqueueJob(db, {
    kind: REFRESH_JOB,
    key: `${requestKey(request)}@${at}`,
    payload: request,
    runAt: new Date(at),
  });
}
