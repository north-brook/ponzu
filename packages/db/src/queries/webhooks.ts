import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import type { Json, webhookDeliveries } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { scrubbed } from "./text.ts";

type Delivery = typeof webhookDeliveries.$inferInsert;

/**
 * Take a delivery, and record the work it asks for as a job, in one statement: so that once
 * the sender has been told it arrived, the work is a row that outlives the request. The job is
 * held by `job.lockedBy` with its first attempt counted, for the request to run it at once;
 * if that request dies, its lock runs out and the cron takes the job (see `claimJobs`).
 *
 * Answers the job's id the first time a delivery id is seen, and null for a redelivery or a
 * retry of one already taken, which the caller acknowledges and drops. The job's key is the
 * delivery id. Text Postgres cannot store in the payload becomes U+FFFD.
 */
export async function takeWebhookDelivery(
  db: Db,
  {
    delivery,
    job,
  }: {
    delivery: Pick<Delivery, "source" | "deliveryId" | "event">;
    job: { kind: string; payload: Json; runAt: Date; lockedBy: string; maxAttempts: number };
  },
): Promise<string | null> {
  const result = await queryJson<{ jobId: string | null }>(
    db,
    sql`
      with taken as (
        insert into webhook_deliveries (source, delivery_id, event)
        values (${delivery.source}, ${delivery.deliveryId}, ${delivery.event})
        on conflict do nothing
        returning delivery_id
      ), queued as (
        insert into jobs (id, kind, key, payload, run_at, attempts, max_attempts, locked_at, locked_by)
        select ${newId("job")}, ${job.kind}, delivery_id, ${JSON.stringify(scrubbed(job.payload))}::jsonb,
          ${timeParam(job.runAt)}::timestamptz, 1, ${job.maxAttempts}, now(), ${job.lockedBy}
        from taken
        returning id
      )
      select json_build_object('jobId', (select id from queued)) as result`,
  );
  return result?.jobId ?? null;
}
