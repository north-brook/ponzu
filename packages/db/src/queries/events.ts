import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { events, type Json } from "../schema/index.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type DesignEvent = typeof events.$inferSelect;

export interface NewEvent {
  designId: string;
  kind: DesignEvent["kind"];
  priority: DesignEvent["priority"];
  /** Stored in the clear. Never put a secret's value in one. */
  payload: Json;
  /** The person behind it. Null when GitHub was. */
  userId?: string | null;
}

/**
 * An event as a row of `events` stores it: a new id, its payload with what Postgres cannot hold
 * replaced, and the person behind it (null when GitHub was). Every way into a design's feed
 * makes its rows here: `appendEvent`, and the commit statement for the events of a person's ops.
 */
export function eventRow({
  kind,
  priority,
  payload,
  userId = null,
}: Omit<NewEvent, "designId">): Omit<NewEvent, "designId"> & { id: string; userId: string | null } {
  return { id: newId("evt"), kind, priority, payload: scrubbed(payload), userId };
}

/**
 * Add something that happened to a design's feed, for its agent to take up: what a webhook or
 * a route appends on its own. The events of a person's ops go in with the ops (`commitOps`).
 */
export async function appendEvent(db: Db, event: NewEvent): Promise<DesignEvent> {
  const [row] = await run(
    db
      .insert(events)
      .values({ designId: event.designId, ...eventRow(event) })
      .returning(),
  );
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
  // In `with`, so that it runs once. As a subquery of the update it is run again for each
  // row whenever the planner joins by nested loop, and each run locks the next `limit` rows.
  const waiting = db.$with("waiting").as(
    db
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
      .for("update", { skipLocked: true }),
  );
  const claimed = await run(
    db
      .with(waiting)
      .update(events)
      .set({ claimedAt: sql`now()` })
      .where(inArray(events.id, db.select({ id: waiting.id }).from(waiting)))
      .returning(),
  );
  return claimed.sort((a, b) => a.seq - b.seq);
}

/**
 * Mark events as delivered, by id: the ones a claim handed out and the runner has since taken
 * in. Anything else stays waiting, whatever its place in the feed, so an event that another
 * claim holds, or that a runner died holding, is never written off. Answers how many were marked.
 */
export async function markEventsDelivered(
  db: Db,
  { designId, ids }: { designId: string; ids: string[] },
): Promise<number> {
  if (ids.length === 0) return 0;
  const delivered = await run(
    db
      .update(events)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(eq(events.designId, designId), inArray(events.id, ids), isNull(events.deliveredAt)),
      )
      .returning({ id: events.id }),
  );
  return delivered.length;
}
