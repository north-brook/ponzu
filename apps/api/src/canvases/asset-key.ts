import { getCanvasAssetKey, isAssetKey, newAssetKey, swapCanvasAssetKey } from "@ponzu/db";
import { z } from "zod";
import type { Deps } from "../deps/index.ts";
import type { ObjectStorage } from "../deps/storage.ts";
import { UpstreamError } from "../http/errors.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunNowDeps, RunningJob } from "../jobs/run.ts";
import { runNow } from "../jobs/run.ts";
import { UPLOADS_SETTLED_MS } from "../uploads/uploads.ts";
import { canvasFilesDeleteJob, deleteUnder, FILES_RETRY_MS } from "./files.ts";

/*
 * Resetting a canvas's file links (docs/cloud.md, "Assets and previews"): its asset key is the
 * capability to its files, so a link that got out (pasted in a chat, kept by someone who lost
 * access) is withdrawn by moving the files under a new key. On demand only, by the owner or a
 * workspace admin, from Share.
 *
 *   1. make a new key;
 *   2. copy every object under the old key to the new one;
 *   3. swap the canvas's key, only if it is still the old one, moving `asset_key_rotated_at`
 *      (clients watch it on the head and ask for the new address), and record the job that
 *      retires the old key, in the same statement;
 *   4. copy again what the old key gained or changed meanwhile: an upload signed before the
 *      swap can still land there;
 *   5. the job, `ASSET_KEY_RETIRE_DELAY_MS` later, once every address signed for the old key has
 *      run out, copies what came late once more and deletes the old key's objects.
 *
 * An upload completed after the swap is served from the new key (`completeUploads` moves it),
 * so the job's last pass is a backstop, not the only way in.
 */

/** The job that retires an old asset key: a last copy of what came late, then a delete. */
export const ASSET_KEY_RETIRE_JOB = "canvas.asset_key_retire";
/** How many attempts it gets, each deleting up to `FILES_PER_ATTEMPT` objects. */
export const ASSET_KEY_RETIRE_ATTEMPTS = 10;
/**
 * How long the old key's files stay after the swap: past every upload address signed for it
 * (`UPLOAD_SECONDS`), with five minutes over for the upload's completion.
 */
export const ASSET_KEY_RETIRE_DELAY_MS = UPLOADS_SETTLED_MS;
/** How many copies run at once. */
const COPY_CONCURRENCY = 16;
/**
 * How far before a pass began an object counts as possibly changed since, for the clocks of
 * storage and of the API to disagree by.
 */
const CLOCK_SLACK_MS = 60_000;

const RetirePayload = z.object({
  canvasId: z.string(),
  from: z.string(),
  to: z.string(),
  /** When the key was swapped, in milliseconds. */
  swappedAt: z.number(),
  /**
   * When the first copy began, in milliseconds: what changed at `from` since is copied again, so
   * a second pass that failed loses nothing. A job recorded before this was carried has only
   * `swappedAt`, and uses it.
   */
  copiedSince: z.number().optional(),
});

/**
 * Copy every object under `from/` to the same path under `to/` that `to/` lacks, or that changed
 * at `from/` at or after `changedSince` (storage's own time of writing), unless the one at `to/`
 * was written after it: a file written under the new key since the swap (the runner replacing an
 * image) is newer than anything left under the old one, and is never copied over. Both must be
 * well-formed asset keys, and different, or it throws before asking storage anything. Answers
 * how many it copied. Safe to repeat.
 */
export async function copyUnder(
  storage: ObjectStorage,
  from: string,
  to: string,
  { changedSince, onlyChanged = false }: { changedSince?: number; onlyChanged?: boolean } = {},
): Promise<number> {
  if (!isAssetKey(from) || !isAssetKey(to) || from === to) {
    throw new Error("copyUnder takes two different asset keys.");
  }
  // Each path `to/` has, with when storage wrote it there (null when it does not say).
  const have = new Map<string, number | null>();
  for await (const object of listAll(storage, `${to}/`)) {
    have.set(object.key.slice(to.length), object.modifiedAt?.getTime() ?? null);
  }
  let copied = 0;
  let batch: Promise<boolean>[] = [];
  const settle = async () => {
    for (const done of await Promise.all(batch)) if (done) copied++;
    batch = [];
  };
  for await (const object of listAll(storage, `${from}/`)) {
    const path = object.key.slice(from.length);
    const at = object.modifiedAt?.getTime() ?? null;
    const changed = changedSince !== undefined && (at === null || at >= changedSince);
    if (have.has(path) || onlyChanged) {
      if (!changed) continue;
      // Written at `to/` after this was written at `from/`: the copy there is as new, or newer.
      const there = have.get(path) ?? null;
      if (there !== null && at !== null && there > at) continue;
    }
    const target = `${to}${path}`;
    batch.push(
      (async () => {
        // After the swap the new key is written to (uploads, a runner), so `have` may be stale by
        // now: what is there is read again just before the copy, and a newer one is kept.
        if (changedSince !== undefined && at !== null) {
          const there = await writtenAt(storage, target);
          if (there !== null && there > at) return false;
        }
        return copyIfThere(storage, object.key, target);
      })(),
    );
    if (batch.length >= COPY_CONCURRENCY) await settle();
  }
  await settle();
  return copied;
}

/** When storage last wrote `key`, or null when nothing is there or it does not say. */
async function writtenAt(storage: ObjectStorage, key: string): Promise<number | null> {
  const page = await storage.list(key);
  const found = page.objects.find((object) => object.key === key);
  return found?.modifiedAt?.getTime() ?? null;
}

/**
 * Copy `from` to `to`, unless `from` went after it was listed (a preview replaced by a later one):
 * there is nothing of it to keep.
 */
async function copyIfThere(storage: ObjectStorage, from: string, to: string): Promise<boolean> {
  try {
    await storage.copy(from, to);
    return true;
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return false;
    throw error;
  }
}

/** Every object under `prefix`, a page at a time, only ever ones that start with it. */
async function* listAll(storage: ObjectStorage, prefix: string) {
  let after: string | undefined;
  for (;;) {
    const page = await storage.list(prefix, after === undefined ? {} : { after });
    for (const object of page.objects) if (object.key.startsWith(prefix)) yield object;
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return;
  }
}

/** What a reset came to: the canvas's files are under a new key, or it is gone. */
export type Rotation = "rotated" | "changed" | "missing";

/**
 * Reset the canvas's file links (the steps above). "changed" when another reset swapped the key
 * first, which leaves that one standing and deletes this one's copies; "missing" when there is
 * no such canvas, or it was deleted meanwhile. Throws when storage fails before the swap, having
 * changed nothing anyone can see (the copies made are deleted by a job).
 */
export async function rotateAssetKey(
  deps: RunNowDeps & Pick<Deps, "log">,
  canvasId: string,
): Promise<Rotation> {
  const from = await getCanvasAssetKey(deps.db, canvasId);
  if (!from) return "missing";
  const to = newAssetKey();
  // Copies under a key no row names are nobody's: deleted, unless the swap makes them the canvas's.
  const discard = () => runNow(deps, canvasFilesDeleteJob(to));

  const began = deps.clock.now();
  try {
    await copyUnder(deps.storage, from, to);
  } catch (error) {
    await discard();
    throw error;
  }
  const swappedAt = deps.clock.now();
  const swap = await swapCanvasAssetKey(deps.db, {
    canvasId,
    from,
    to,
    now: new Date(swappedAt),
    job: {
      kind: ASSET_KEY_RETIRE_JOB,
      payload: { canvasId, from, to, swappedAt, copiedSince: began },
      runAt: new Date(swappedAt + ASSET_KEY_RETIRE_DELAY_MS),
      maxAttempts: ASSET_KEY_RETIRE_ATTEMPTS,
    },
  });
  if (swap !== "swapped") {
    await discard();
    return swap;
  }
  // What the old key gained or changed while the first pass ran. A failure here loses nothing:
  // the retire job copies the same again before it deletes anything.
  try {
    await copyUnder(deps.storage, from, to, { changedSince: began - CLOCK_SLACK_MS });
  } catch (error) {
    // Its name and status only: a storage error's message could carry a key.
    deps.log.warn("asset_key_second_copy_failed", {
      canvasId,
      error: error instanceof Error ? error.name : "unknown",
      status: error instanceof UpstreamError ? error.status : undefined,
    });
  }
  return "rotated";
}

/**
 * The retire job's handler: while the canvas's files are still under `to`, copy what `from`
 * gained or changed since the first copy began (what the second pass covers, should it have
 * failed); then delete a page of `from`'s files, and come back while
 * more remain, as the files delete does. A canvas reset again gets what changed at `from` since
 * the swap under its current key. A canvas deleted meanwhile needs no copy, and what is under `to` is deleted
 * here as well as by its files job, which may have run while the reset still copied into it.
 */
export async function runAssetKeyRetireJob(
  deps: Pick<JobDeps, "db" | "storage" | "log">,
  payload: unknown,
  job?: Pick<RunningJob, "attempts" | "maxAttempts">,
): Promise<void> {
  const { canvasId, from, to, swappedAt, copiedSince } = RetirePayload.parse(payload);
  const now = await getCanvasAssetKey(deps.db, canvasId);
  if (now === to) {
    // Since the first pass began, as the second pass would have: that one may have failed.
    await copyUnder(deps.storage, from, to, {
      changedSince: (copiedSince ?? swappedAt) - CLOCK_SLACK_MS,
    });
  } else if (now !== null && isAssetKey(now) && now !== from) {
    // Reset again since: what came late to `from` never reached `to`, so `to`'s own job cannot
    // carry it on. It goes straight to the canvas's key now, but only what changed since this
    // swap: a file missing there for another reason (deleted under `to`) is not brought back.
    await copyUnder(deps.storage, from, now, {
      changedSince: swappedAt - CLOCK_SLACK_MS,
      onlyChanged: true,
    });
  }
  let { deleted, done } = await deleteUnder(deps.storage, `${from}/`);
  if (now === null && isAssetKey(to)) {
    // Deleted after the swap: its files job took `to/` as the reset's second pass may still have
    // been copying into it. Long past that pass now, whatever it left under `to/` goes too.
    const left = await deleteUnder(deps.storage, `${to}/`);
    deleted += left.deleted;
    done &&= left.done;
  }
  // Ids only: an asset key is the capability to the files, so it is never logged.
  deps.log.info("asset_key_retired", { canvasId, deleted, done });
  if (done) return;
  if (job && job.attempts >= job.maxAttempts) {
    throw new Error(`Deleted ${deleted} files on the last attempt; more remain.`);
  }
  throw new RetryLater(FILES_RETRY_MS, `Deleted ${deleted} files; more remain.`);
}
