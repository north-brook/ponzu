import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { queryJson, timeParam } from "./json.ts";

/*
 * How long the rows that only keep the service running are kept (docs/legal.md, "How long we
 * keep it" on the privacy policy). Each is something the code reads only for a short while
 * after it is written, so keeping it longer would keep personal data for no reason:
 *
 * - an `auth_states` row is a sign-in or an install on its way through someone else's page. It
 *   is worth nothing once it expires (`consumeAuthState`), and the app that began it reads its
 *   outcome within minutes;
 * - a finished `jobs` row (completed, or failed for good) is never claimed again, and its key no
 *   longer stands in the way of a new job. `recordOnce`'s marks are finished jobs too; every one
 *   names a window of an hour or less, so a month-old mark guards nothing;
 * - a `webhook_deliveries` row lets a redelivery be recognised. GitHub offers a delivery for
 *   redelivery for three days and Stripe retries one for up to three, so a month is well past
 *   the last copy that could arrive.
 *
 * To change a period, change it here; the privacy draft (apps/web/app/(legal)/privacy) says
 * the same numbers and must change with it.
 */

const DAY_MS = 24 * 60 * 60_000;

/** A round trip's state is deleted this long after it expired. */
export const AUTH_STATE_RETENTION_MS = DAY_MS;
/** A finished job is deleted this long after it completed or failed. */
export const JOB_RETENTION_DAYS = 30;
/** A webhook delivery's record is deleted this long after it was received. */
export const WEBHOOK_RETENTION_DAYS = 30;
/**
 * The most rows of each table one sweep deletes, so that one run is a short statement however
 * far behind it is. The sweep runs hourly, so a backlog clears at this many rows an hour.
 */
export const RETENTION_BATCH = 5_000;

/** What one sweep deleted, by table. */
export interface SweptRows {
  authStates: number;
  jobs: number;
  webhookDeliveries: number;
}

/**
 * Delete what has outlived its retention at `now`, at most `limit` rows of each table (never
 * more than `RETENTION_BATCH`, whatever is asked): expired
 * `auth_states` more than a day past expiry, `jobs` finished more than 30 days ago, and
 * `webhook_deliveries` received more than 30 days ago. One statement per table, so a failure
 * in one leaves the others done. Answers how many rows went from each.
 *
 * `now` is the caller's clock, so a test on a fake clock sees the same boundaries. A row is kept
 * at exactly its boundary and deleted after it.
 *
 * Runs may overlap: two deletes that pick the same rows each delete what the other has not.
 * Waiting and running jobs are never touched, whatever their age.
 */
export async function sweepOldRows(
  db: Db,
  now: Date,
  { limit: asked = RETENTION_BATCH }: { limit?: number } = {},
): Promise<SweptRows> {
  // A caller may ask for a smaller batch, never a larger one.
  const limit = Math.max(0, Math.min(Math.floor(asked), RETENTION_BATCH));
  const at = now.getTime();
  const authCutoff = timeParam(new Date(at - AUTH_STATE_RETENTION_MS));
  const jobCutoff = timeParam(new Date(at - JOB_RETENTION_DAYS * DAY_MS));
  const webhookCutoff = timeParam(new Date(at - WEBHOOK_RETENTION_DAYS * DAY_MS));

  const authStates = await counted(
    db,
    sql`
      delete from auth_states
       where id in (
         select id from auth_states
          where expires_at < ${authCutoff}::timestamptz
          limit ${limit}
       )
      returning 1`,
  );
  const jobs = await counted(
    db,
    sql`
      delete from jobs
       where id in (
         select id from jobs
          where completed_at < ${jobCutoff}::timestamptz
             or failed_at < ${jobCutoff}::timestamptz
          limit ${limit}
       )
      returning 1`,
  );
  const webhookDeliveries = await counted(
    db,
    sql`
      delete from webhook_deliveries
       where (source, delivery_id) in (
         select source, delivery_id from webhook_deliveries
          where received_at < ${webhookCutoff}::timestamptz
          limit ${limit}
       )
      returning 1`,
  );
  return { authStates, jobs, webhookDeliveries };
}

/** Run a `delete … returning` and answer how many rows it deleted. */
async function counted(db: Db, deletion: SQL): Promise<number> {
  const result = await queryJson<{ count: number }>(
    db,
    sql`
      with deleted as (${deletion})
      select json_build_object('count', (select count(*) from deleted)) as result`,
  );
  return Number(result?.count ?? 0);
}
