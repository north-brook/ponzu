import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { designRunners, designs, events, type Json, users } from "../schema/index.ts";
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

/** Whether `runnerId` holds `designId`'s lease, as a condition of the statement it is in. */
function leaseHeld(db: Db, designId: string, runnerId: string) {
  const leased = db
    .select({ id: designRunners.designId })
    .from(designRunners)
    .where(and(eq(designRunners.designId, designId), eq(designRunners.runnerId, runnerId)));
  return sql`exists (${leased})`;
}

/**
 * Hand a design's runner the events it has not been handed, oldest first, at most `limit`: those
 * not yet delivered and not already claimed by `runnerId`, which is then recorded as their
 * runner under `claimId`. So an event goes to each runner once, and one an earlier runner took
 * and never acknowledged (it is gone) is the next one's.
 *
 * `claimId` is the runner's, new for each claim. Sent again, because the first answer was lost,
 * it hands out again what that claim handed out and has not been acknowledged, and nothing
 * else. The design's head `seq` comes back from the same statement, so a claim that happened
 * always gets its answer.
 *
 * Only the design's current runner (`design_runners.runner_id`) is handed anything: a runner
 * whose lease was taken between its call being let in and this statement gets nothing. Null
 * when there is no such design.
 */
export async function claimEvents(
  db: Db,
  {
    designId,
    runnerId,
    claimId,
    limit = 100,
  }: { designId: string; runnerId: string; claimId: string; limit?: number },
): Promise<{ events: ClaimedEvent[]; seq: number } | null> {
  const pending = and(eq(events.designId, designId), isNull(events.deliveredAt));
  const ofThisClaim = and(eq(events.claimedBy, runnerId), eq(events.claimId, claimId));
  const repeated = db.select({ id: events.id }).from(events).where(and(pending, ofThisClaim));
  // In `with`, so that it runs once. As a subquery of the update it is run again for each
  // row whenever the planner joins by nested loop, and each run locks the next `limit` rows.
  const waiting = db.$with("waiting").as(
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          pending,
          leaseHeld(db, designId, runnerId),
          or(
            ofThisClaim,
            and(
              sql`not exists (${repeated})`,
              or(isNull(events.claimedBy), sql`${events.claimedBy} <> ${runnerId}`),
            ),
          ),
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
      .set({ claimedAt: sql`now()`, claimedBy: runnerId, claimId })
      .where(inArray(events.id, db.select({ id: waiting.id }).from(waiting)))
      .returning(),
  );
  // From the design, so that its head comes back when nothing is claimed.
  const rows = await run(
    db
      .with(claimed)
      .select({
        seq: designs.seq,
        event: {
          id: claimed.id,
          designId: claimed.designId,
          seq: claimed.seq,
          kind: claimed.kind,
          priority: claimed.priority,
          payload: claimed.payload,
          createdAt: claimed.createdAt,
          claimedAt: claimed.claimedAt,
          claimedBy: claimed.claimedBy,
          claimId: claimed.claimId,
          deliveredAt: claimed.deliveredAt,
        },
        user: { id: users.id, name: users.name, githubLogin: users.githubLogin },
      })
      .from(designs)
      .leftJoin(claimed, sql`true`)
      .leftJoin(users, eq(users.id, claimed.userId))
      .where(eq(designs.id, designId)),
  );
  const [head] = rows;
  if (!head) return null;
  const claimedEvents = rows
    .flatMap(({ event, user }) => (event ? [{ ...event, from: personOf(user) }] : []))
    .sort((a, b) => a.seq - b.seq);
  return { events: claimedEvents, seq: head.seq };
}

/**
 * Mark events as delivered, by id: `runnerId` has put them into the Claude session. Only events
 * it claimed are marked: anything else stays waiting, whatever its place in the feed, and an id
 * already marked, of another design or handed to another runner is left alone.
 * `claudeSessionId`, when not null, is stored as the design's session in the same statement, so
 * the next runner resumes the session these events went into. Nothing is marked or stored once
 * `runnerId` no longer holds the lease. Answers how many were marked.
 */
export async function markEventsDelivered(
  db: Db,
  {
    designId,
    runnerId,
    ids,
    claudeSessionId = null,
  }: { designId: string; runnerId: string; ids: string[]; claudeSessionId?: string | null },
): Promise<number> {
  const session = db.$with("session").as(
    db
      .update(designRunners)
      .set({ claudeSessionId })
      .where(
        and(
          eq(designRunners.designId, designId),
          eq(designRunners.runnerId, runnerId),
          sql`${claudeSessionId}::text is not null`,
        ),
      )
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
        and(
          eq(events.designId, designId),
          inArray(events.id, ids),
          isNull(events.deliveredAt),
          eq(events.claimedBy, runnerId),
          leaseHeld(db, designId, runnerId),
        ),
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

/**
 * Whether the design's feed has an event that wakes a sandbox (`now` or `next`) that its current
 * runner claimed and has not put into its session: in a sandbox that was idle, what the runner
 * held back because its claim was answered as it got ready to sleep. Asleep, the sandbox must be
 * woken again for it.
 */
export async function hasHeldEvents(db: Db, designId: string): Promise<boolean> {
  const [row] = await run(
    db
      .select({ id: events.id })
      .from(events)
      .innerJoin(designRunners, eq(designRunners.designId, events.designId))
      .where(
        and(
          eq(events.designId, designId),
          isNull(events.deliveredAt),
          inArray(events.priority, ["now", "next"]),
          eq(events.claimedBy, designRunners.runnerId),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}
