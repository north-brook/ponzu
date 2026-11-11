import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { designRunners, events, type Json, users } from "../schema/index.ts";
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

/** Someone behind an event, as the runner names them. */
export interface EventPerson {
  id: string;
  name: string;
  /** Their GitHub login. */
  login: string;
}

/** An event as its runner is handed it. */
export interface ClaimedEvent extends Omit<DesignEvent, "userId"> {
  /** The person behind it. Null when GitHub was, or when they have since been deleted. */
  from: EventPerson | null;
}

/**
 * An event as a row of `events` stores it: a new id, its payload with what Postgres cannot hold
 * replaced, and the person behind it (null when GitHub was). Every way into a design's feed
 * makes its rows here: `appendEvent`, a person's message (`postMessage`), an answer
 * (`answerQuestion`), and the commit statement for the events of a person's ops.
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

/** A person as an event names them. */
export function personOf(
  user: Pick<typeof users.$inferSelect, "id" | "name" | "githubLogin"> | null,
): EventPerson | null {
  return user
    ? { id: user.id, name: user.name ?? user.githubLogin, login: user.githubLogin }
    : null;
}

/**
 * Hand a design's runner the events it has not been handed, oldest first, at most `limit`: those
 * not yet delivered and not already claimed by `runnerId`, which is then recorded as their
 * runner. So an event goes to each runner once, and one an earlier runner took and never
 * acknowledged (it is gone) is the next one's.
 *
 * Only the design's current runner (`design_runners.runner_id`) is handed anything: a runner
 * whose lease was taken between its call being let in and this statement gets nothing.
 */
export async function claimEvents(
  db: Db,
  { designId, runnerId, limit = 100 }: { designId: string; runnerId: string; limit?: number },
): Promise<ClaimedEvent[]> {
  const leased = db
    .select({ id: designRunners.designId })
    .from(designRunners)
    .where(and(eq(designRunners.designId, designId), eq(designRunners.runnerId, runnerId)));
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
          or(isNull(events.claimedBy), sql`${events.claimedBy} <> ${runnerId}`),
          sql`exists (${leased})`,
        ),
      )
      .orderBy(events.seq)
      .limit(limit)
      // Two claims at once split the events between them and neither waits.
      .for("update", { skipLocked: true }),
  );
  const claimed = db.$with("claimed").as(
    db
      .with(waiting)
      .update(events)
      .set({ claimedAt: sql`now()`, claimedBy: runnerId })
      .where(inArray(events.id, db.select({ id: waiting.id }).from(waiting)))
      .returning(),
  );
  const rows = await run(
    db.with(claimed).select().from(claimed).leftJoin(users, eq(users.id, claimed.userId)),
  );
  return rows
    .map(({ claimed: { userId: _, ...event }, users: user }) => ({
      ...event,
      from: personOf(user),
    }))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Mark events as delivered, by id: the runner has put them into the Claude session. Anything
 * else stays waiting, whatever its place in the feed, and an id already marked or of another
 * design is left alone. `claudeSessionId`, when not null, is stored as the design's session in
 * the same statement, so the next runner resumes the session these events went into. Answers
 * how many were marked.
 */
export async function markEventsDelivered(
  db: Db,
  {
    designId,
    ids,
    claudeSessionId = null,
  }: { designId: string; ids: string[]; claudeSessionId?: string | null },
): Promise<number> {
  const session = db.$with("session").as(
    db
      .update(designRunners)
      .set({ claudeSessionId })
      .where(and(eq(designRunners.designId, designId), sql`${claudeSessionId}::text is not null`))
      .returning({ id: designRunners.designId }),
  );
  if (ids.length === 0) {
    await run(db.with(session).select({ id: session.id }).from(session));
    return 0;
  }
  const delivered = await run(
    db
      .with(session)
      .update(events)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(eq(events.designId, designId), inArray(events.id, ids), isNull(events.deliveredAt)),
      )
      .returning({ id: events.id }),
  );
  return delivered.length;
}

/**
 * Of these ids, the design's `stop` events, each with the person who stopped the run: what a
 * runner's `stopped` notice names, for the API to say who it was.
 */
export async function findStops(
  db: Db,
  { designId, ids }: { designId: string; ids: string[] },
): Promise<{ id: string; from: EventPerson | null }[]> {
  if (ids.length === 0) return [];
  const rows = await run(
    db
      .select({
        id: events.id,
        user: { id: users.id, name: users.name, githubLogin: users.githubLogin },
      })
      .from(events)
      .leftJoin(users, eq(users.id, events.userId))
      .where(and(eq(events.designId, designId), eq(events.kind, "stop"), inArray(events.id, ids))),
  );
  return rows.map(({ id, user }) => ({ id, from: personOf(user) }));
}
