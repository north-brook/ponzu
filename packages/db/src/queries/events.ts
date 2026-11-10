import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { events, type Json } from "../schema/index.ts";

export type DesignEvent = typeof events.$inferSelect;

export interface NewEvent {
  designId: string;
  kind: DesignEvent["kind"];
  priority: DesignEvent["priority"];
  payload: Json;
  /** The person behind it. Null when GitHub was. */
  userId?: string | null;
}

/** Add something that happened to a design's feed, for its agent to take up. */
export async function appendEvent(db: Db, event: NewEvent): Promise<DesignEvent> {
  const [row] = await db
    .insert(events)
    .values({ ...event, id: newId("evt") })
    .returning();
  return row!;
}

/**
 * Take a design's waiting events for its runner, oldest first. An event is waiting until it is
 * marked delivered; one that was taken more than `retakeAfterSeconds` ago and never marked
 * (the runner died holding it) is handed out again.
 */
export async function claimEvents(
  db: Db,
  {
    designId,
    limit = 100,
    retakeAfterSeconds = 60,
  }: { designId: string; limit?: number; retakeAfterSeconds?: number },
): Promise<DesignEvent[]> {
  const waiting = db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.designId, designId),
        isNull(events.deliveredAt),
        or(
          isNull(events.claimedAt),
          sql`${events.claimedAt} < now() - make_interval(secs => ${retakeAfterSeconds})`,
        ),
      ),
    )
    .orderBy(events.seq)
    .limit(limit)
    // Two claims at once split the events between them and neither waits.
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(events)
    .set({ claimedAt: sql`now()` })
    .where(inArray(events.id, waiting))
    .returning();
  return claimed.sort((a, b) => a.seq - b.seq);
}

/**
 * Mark the events a runner took, up to and including `throughSeq`, as delivered. Only taken
 * events count: one that was appended later but drew a lower seq is left for the next claim.
 * Answers how many were marked.
 */
export async function markEventsDelivered(
  db: Db,
  { designId, throughSeq }: { designId: string; throughSeq: number },
): Promise<number> {
  const delivered = await db
    .update(events)
    .set({ deliveredAt: sql`now()` })
    .where(
      and(
        eq(events.designId, designId),
        lte(events.seq, throughSeq),
        isNotNull(events.claimedAt),
        isNull(events.deliveredAt),
      ),
    )
    .returning({ id: events.id });
  return delivered.length;
}
