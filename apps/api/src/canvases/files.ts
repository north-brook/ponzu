import { isAssetKey, type NewJob } from "@ponzu/db";
import { z } from "zod";
import type { ObjectStorage } from "../deps/storage.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps } from "../jobs/run.ts";

/*
 * A canvas's files, deleted with it (docs/cloud.md, "Assets and previews"). Everything a canvas
 * stores lives under its asset key: `<asset key>/assets/…`, `previews/…`, `exports/…`,
 * `comments/…`. Deleting them is the one place the API removes objects by prefix, and it cannot
 * be undone, so the prefix is checked before storage is asked anything: a bug that passed an
 * empty string, a shorter key or another area's prefix (`pull-requests/`, `private/`) would
 * otherwise delete what belongs to other canvases.
 *
 * Pull request pictures (`pull-requests/<key>/`) are not under the asset key and are kept: the
 * pull request on GitHub still shows them.
 *
 * The job is registered here and recorded by nobody yet. Deleting a canvas, and deleting an
 * account, record it once the data lifecycle work wires them (W9).
 */

/** The job that deletes a deleted canvas's files. Its key is the canvas's asset key. */
export const CANVAS_FILES_DELETE_JOB = "canvas.files_delete";
/** How many attempts the job gets, each deleting up to `FILES_PER_ATTEMPT` objects. */
export const CANVAS_FILES_DELETE_ATTEMPTS = 10;
/** The most objects one attempt deletes, so an attempt stays well inside a function's time. */
export const FILES_PER_ATTEMPT = 2000;
/** The wait before the next attempt, when more remain. */
export const FILES_RETRY_MS = 10_000;

const Payload = z.object({ assetKey: z.string() });

/** Whether `prefix` is exactly an asset key and its slash: the only prefix `deleteUnder` takes. */
export function isAssetPrefix(prefix: string): boolean {
  return prefix.endsWith("/") && isAssetKey(prefix.slice(0, -1));
}

/**
 * Delete up to `limit` objects under `prefix`, a page at a time. Throws before asking storage
 * anything when `prefix` is not exactly a well-formed asset key followed by `/`. `done` once
 * nothing is left under it. Safe to repeat: what is already gone is not listed again.
 */
export async function deleteUnder(
  storage: ObjectStorage,
  prefix: string,
  { limit = FILES_PER_ATTEMPT }: { limit?: number } = {},
): Promise<{ deleted: number; done: boolean }> {
  if (!isAssetPrefix(prefix)) {
    throw new Error("deleteUnder takes only an asset key followed by a slash.");
  }
  let deleted = 0;
  let after: string | undefined;
  while (deleted < limit) {
    const page = await storage.list(prefix, after === undefined ? {} : { after });
    // Storage was asked for keys under the prefix; never delete one it answered from elsewhere.
    const keys = page.keys.filter((key) => key.startsWith(prefix)).slice(0, limit - deleted);
    await storage.deleteMany(keys);
    deleted += keys.length;
    if (keys.length === page.keys.length && !page.truncated) return { deleted, done: true };
    after = keys.at(-1) ?? page.keys.at(-1);
    if (after === undefined) return { deleted, done: true };
  }
  // The budget ran out at a page's end. Whether anything is left is the next attempt's question.
  const left = await storage.list(prefix, after === undefined ? {} : { after });
  return { deleted, done: left.keys.length === 0 };
}

/** The job that deletes the files under `assetKey`, for `runNow` or `enqueueJob` to record. */
export function canvasFilesDeleteJob(assetKey: string): NewJob {
  if (!isAssetKey(assetKey)) throw new Error("A files delete is keyed by an asset key.");
  return {
    kind: CANVAS_FILES_DELETE_JOB,
    key: assetKey,
    payload: { assetKey },
    maxAttempts: CANVAS_FILES_DELETE_ATTEMPTS,
  };
}

/**
 * The job's handler: delete a page of the files, and come back in `FILES_RETRY_MS` while more
 * remain. A key storage could not remove fails the attempt, which is tried again as usual.
 */
export async function runCanvasFilesDeleteJob(
  deps: Pick<JobDeps, "storage" | "log">,
  payload: unknown,
): Promise<void> {
  const { assetKey } = Payload.parse(payload);
  const { deleted, done } = await deleteUnder(deps.storage, `${assetKey}/`);
  // Ids only: the asset key is the capability to the files, so it is never logged.
  deps.log.info("canvas_files_deleted", { deleted, done });
  if (!done) throw new RetryLater(FILES_RETRY_MS, `Deleted ${deleted} files; more remain.`);
}
