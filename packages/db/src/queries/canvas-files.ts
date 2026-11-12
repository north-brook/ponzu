import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { canvases, type Json, jobs } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";

/*
 * A canvas's files and its asset key (docs/cloud.md, "Assets and previews"). Whoever knows the
 * key can read the files, so it is never handed back here: each statement reads it, and records
 * the job that deletes what is under it, in the same statement that changes the row. Nothing can
 * then come between the row going (or its key changing) and the job being there to finish it.
 */

/** A job as a statement here recorded it: what a runner of jobs needs to run it. */
export interface RecordedJob {
  id: string;
  kind: string;
  payload: Json;
  attempts: number;
  maxAttempts: number;
}

/** A job a statement records along with the change it is for, as the API names it. */
export interface HeldJob {
  kind: string;
  maxAttempts: number;
  runAt: Date;
  /** Take the job as it is recorded, to run it at once (`enqueueJob`'s `lockedBy`). */
  lockedBy?: string;
}

/** The job that deletes a canvas's files. Its key is the asset key. */
export interface FilesJob extends HeldJob {
  /**
   * When the job makes its last pass, once every upload address signed before the delete has
   * run out: carried in its payload as `until`, in milliseconds.
   */
  until?: Date;
}

/**
 * Delete a canvas and everything that is only its own, and record `job`, keyed by the asset
 * key the row had as it went, with `{ assetKey, until? }` as its payload: in one statement, so the row
 * is never gone without the job that deletes its files. `deleted` is false when there was no
 * such canvas (deleted twice), and then nothing is recorded. `job` is null when nothing was
 * recorded, which is also so when a job for that key was already waiting: that one does the work.
 */
export async function deleteCanvasWithFiles(
  db: Db,
  { canvasId, job }: { canvasId: string; job: FilesJob },
): Promise<{ deleted: boolean; job: RecordedJob | null }> {
  const locked = job.lockedBy !== undefined;
  const result = await queryJson<{
    deleted: boolean;
    job: (Omit<RecordedJob, "maxAttempts"> & { max_attempts: number }) | null;
  }>(
    db,
    sql`
      with gone as (
        delete from ${canvases} where id = ${canvasId} returning asset_key
      ),
      recorded as (
        insert into ${jobs} (id, kind, key, payload, run_at, max_attempts, locked_by, locked_at,
                             attempts)
        select ${newId("job")}, ${job.kind}, gone.asset_key,
               jsonb_build_object('assetKey', gone.asset_key) || ${
                 job.until
                   ? sql`jsonb_build_object('until', ${job.until.getTime()}::bigint)`
                   : sql`'{}'::jsonb`
               },
               ${timeParam(job.runAt)}::timestamptz, ${job.maxAttempts}::int,
               ${job.lockedBy ?? null}::text,
               ${locked ? sql`now()` : sql`null::timestamptz`},
               ${locked ? 1 : 0}::int
          from gone
        on conflict (kind, key) where completed_at is null and failed_at is null do nothing
        returning id, kind, payload, attempts, max_attempts
      )
      select json_build_object(
        'deleted', exists (select 1 from gone),
        'job', (select row_to_json(r) from recorded r)
      ) as result
    `,
  );
  const recorded = result?.job ?? null;
  return {
    deleted: result?.deleted ?? false,
    job: recorded
      ? {
          id: recorded.id,
          kind: recorded.kind,
          payload: recorded.payload,
          attempts: recorded.attempts,
          maxAttempts: recorded.max_attempts,
        }
      : null,
  };
}

/** What `swapCanvasAssetKey` came to. */
export type AssetKeySwap =
  /** The canvas's files are under `to` now, and the job that retires `from` is recorded. */
  | "swapped"
  /** Its key was no longer `from`: another reset got there first. Nothing changed. */
  | "changed"
  /** There is no such canvas (deleted meanwhile). */
  | "missing";

/**
 * Give the canvas the asset key `to` in place of `from`, and move `asset_key_rotated_at` to
 * `now`, only if its key is still `from`; in the same statement, record `job` keyed by `from`
 * (the job that copies what `from` gained late and then deletes it). Two resets at once: the
 * second finds the key changed, and changes nothing.
 */
export async function swapCanvasAssetKey(
  db: Db,
  {
    canvasId,
    from,
    to,
    now,
    job,
  }: {
    canvasId: string;
    from: string;
    to: string;
    now: Date;
    job: { kind: string; payload: Json; runAt: Date; maxAttempts: number };
  },
): Promise<AssetKeySwap> {
  const result = await queryJson<{ found: boolean; swapped: boolean }>(
    db,
    sql`
      with swapped as (
        update ${canvases}
           set asset_key = ${to}, asset_key_rotated_at = ${timeParam(now)}::timestamptz,
               updated_at = now()
         where id = ${canvasId} and asset_key = ${from}
        returning id
      ),
      recorded as (
        insert into ${jobs} (id, kind, key, payload, run_at, max_attempts)
        select ${newId("job")}, ${job.kind}, ${from}::text, ${JSON.stringify(job.payload)}::jsonb,
               ${timeParam(job.runAt)}::timestamptz, ${job.maxAttempts}::int
          from swapped
        on conflict (kind, key) where completed_at is null and failed_at is null do nothing
      )
      select json_build_object(
        'found', exists (select 1 from ${canvases} where id = ${canvasId}),
        'swapped', exists (select 1 from swapped)
      ) as result
    `,
  );
  if (result?.swapped) return "swapped";
  return result?.found ? "changed" : "missing";
}
