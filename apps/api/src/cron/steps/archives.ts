import { randomString, recordedArchiveKeys } from "@ponzu/db";
import type { Deps } from "../../deps/index.ts";
import type { ListedObject } from "../../deps/storage.ts";
import { PRIVATE } from "../../uploads/uploads.ts";
import type { CronStep } from "../steps.ts";

/*
 * The orphan archive sweep (docs/cloud.md, "Saving the sandbox"). A checkpoint's archives are
 * uploaded under `private/` in `deps.archives` before the checkpoint that names them is
 * recorded, so one whose checkpoint call never came (the runner died between the two, or the
 * call was refused) is held by nobody. The API deletes the archives a later checkpoint replaces
 * and those of a deleted canvas, but a delete that failed leaves those behind too.
 *
 * A bucket lifecycle rule cannot tell a recorded archive from an unrecorded one, and a settled
 * canvas keeps its last checkpoint for good, so a rule on `private/` would delete live
 * checkpoints. This sweep does it instead: once a day it lists `private/` and deletes the
 * objects over a day old that no checkpoint row names now.
 *
 * What keeps a recorded checkpoint safe:
 * - Only `private/` is listed, and a key storage answers from anywhere else is never touched.
 * - An object is deleted only when the database, asked after the listing, says no canvas's
 *   checkpoint names it. A failed query fails the step and deletes nothing.
 * - An object storage gives no time for is kept.
 * - A checkpoint records only archives uploaded in the last `ARCHIVE_RECORD_HOURS` hours
 *   (runner/checkpoint.ts), far inside the day this sweep waits, so no archive the sweep finds
 *   unrecorded and a day old can be recorded while it deletes it.
 */

/** The hour of the day (UTC) the sweep runs in: early morning in the US. */
export const ARCHIVES_HOUR = 9;
/** The minute past that hour, away from the steps on the hour. */
export const ARCHIVES_MINUTE = 41;
/** How old an unrecorded archive must be before it is deleted. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** The most archives one run deletes. The rest wait for the next day. */
export const ORPHANS_PER_RUN = 2000;
/** The most pages of keys (a thousand each) one run lists, so a run stays inside a function. */
export const ARCHIVE_PAGES_PER_RUN = 50;

/** What a run did, by count. Keys are never logged: the random part of one opens the archive. */
export interface ArchiveSweep {
  /** Objects listed under `private/`. */
  listed: number;
  /** Objects over a day old that a checkpoint records now, kept. */
  recorded: number;
  /** Unrecorded objects not yet a day old, kept. */
  young: number;
  /** Objects storage gave no time for, kept. */
  undated: number;
  /** Unrecorded objects over a day old, deleted. */
  deleted: number;
}

/**
 * List `private/` in `deps.archives` and delete up to `limit` objects over a day old that no
 * checkpoint records, reading at most `pages` pages. A run starts at a random key (`start`, a
 * key under `private/`, for a test to fix) and goes round to it, so a bucket larger than a run
 * reads is still swept whole over the days. Throws, having deleted only what it had checked,
 * when storage or the database fails.
 */
export async function sweepOrphanArchives(
  deps: Pick<Deps, "db" | "archives" | "log">,
  now: Date,
  {
    limit = ORPHANS_PER_RUN,
    pages = ARCHIVE_PAGES_PER_RUN,
    start = `${PRIVATE}/${randomString(32)}`,
  }: { limit?: number; pages?: number; start?: string } = {},
): Promise<ArchiveSweep> {
  const prefix = `${PRIVATE}/`;
  if (!start.startsWith(prefix)) throw new Error("The sweep starts at a key under private/.");
  const before = now.getTime() - ORPHAN_AGE_MS;
  const counts: ArchiveSweep = { listed: 0, recorded: 0, young: 0, undated: 0, deleted: 0 };
  // From `start` to the end, then from the beginning back round to `start`.
  let after: string | undefined = start;
  let wrapped = false;
  for (let page = 0; page < pages && counts.deleted < limit; page++) {
    const listed = await deps.archives.list(prefix, after === undefined ? {} : { after });
    let objects = listed.objects.filter((object) => object.key.startsWith(prefix));
    let round = false;
    if (wrapped) {
      const past = objects.findIndex((object) => object.key > start);
      if (past !== -1) {
        objects = objects.slice(0, past);
        round = true;
      }
    }
    await sweepPage(deps, objects, before, limit - counts.deleted, counts);
    if (round) break;
    if (!listed.truncated || listed.keys.length === 0) {
      if (wrapped) break;
      wrapped = true;
      after = undefined;
      continue;
    }
    after = listed.keys.at(-1);
  }
  deps.log.info("archives_swept", { ...counts });
  return counts;
}

/** Sort one page into kept and deleted, and delete up to `room` of it. */
async function sweepPage(
  deps: Pick<Deps, "db" | "archives">,
  objects: ListedObject[],
  before: number,
  room: number,
  counts: ArchiveSweep,
): Promise<void> {
  counts.listed += objects.length;
  const old: string[] = [];
  for (const { key, modifiedAt } of objects) {
    if (modifiedAt === null) counts.undated++;
    else if (modifiedAt.getTime() > before) counts.young++;
    else old.push(key);
  }
  if (old.length === 0) return;
  // Asked after the listing: a checkpoint recorded since is seen.
  const recorded = await recordedArchiveKeys(deps.db, old);
  counts.recorded += recorded.size;
  const orphans = old.filter((key) => !recorded.has(key)).slice(0, room);
  if (orphans.length === 0) return;
  await deps.archives.deleteMany(orphans);
  counts.deleted += orphans.length;
}

/** Once a day: the archives no checkpoint records, deleted. */
export const archivesStep: CronStep = {
  name: "archives",
  atMinute: ARCHIVES_MINUTE,
  run: async (deps, now) => {
    // The cron keeps hourly slots; the sweep takes one of them a day.
    if (now.getUTCHours() !== ARCHIVES_HOUR) return {};
    return { ...(await sweepOrphanArchives(deps, now)) };
  },
};
