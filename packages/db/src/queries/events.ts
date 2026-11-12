import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { PrState } from "../enums.ts";
import { newId } from "../ids.ts";
import { canvases, canvasRunners, events, type Json, users } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type FeedEvent = typeof events.$inferSelect;

export interface NewEvent {
  canvasId: string;
  kind: FeedEvent["kind"];
  priority: FeedEvent["priority"];
  /** Stored in the clear. Never put a secret's value in one. */
  payload: Json;
  /** The person behind it. Null when GitHub was. */
  userId?: string | null;
  /** The PostHog session of the app that sent it, if it said. */
  posthogSessionId?: string | null;
}

/** Someone behind an event, as the runner names them. */
export interface EventPerson {
  id: string;
  name: string;
  /** Their GitHub login. */
  login: string;
}

/** An event as its runner is handed it. */
export interface ClaimedEvent extends Omit<FeedEvent, "userId"> {
  /** The person behind it. Null when GitHub was, or when they have since been deleted. */
  from: EventPerson | null;
}

/**
 * An event as a row of `events` stores it: a new id, its payload with what Postgres cannot hold
 * replaced, and the person behind it (null when GitHub was). Every way into a canvas's feed
 * makes its rows here: `appendEvent`, a person's message (`postMessage`), an answer
 * (`answerQuestion`), and the commit statement for the events of a person's ops.
 */
export function eventRow({
  kind,
  priority,
  payload,
  userId = null,
  posthogSessionId = null,
}: Omit<NewEvent, "canvasId">): Omit<NewEvent, "canvasId"> & {
  id: string;
  userId: string | null;
  posthogSessionId: string | null;
} {
  return {
    id: newId("evt"),
    kind,
    priority,
    payload: scrubbed(payload),
    userId,
    posthogSessionId,
  };
}

/**
 * Add something that happened to a canvas's feed, for its agent to take up: what a webhook or
 * a route appends on its own. The events of a person's ops go in with the ops (`commitOps`).
 */
export async function appendEvent(db: Db, event: NewEvent): Promise<FeedEvent> {
  const [row] = await run(
    db
      .insert(events)
      .values({ canvasId: event.canvasId, ...eventRow(event) })
      .returning(),
  );
  return row!;
}

/**
 * Who sent each of these events of a canvas, and from which app session: what a turn the event
 * began is attributed to. Ids that are not the canvas's are left out.
 */
export async function getEventOrigins(
  db: Db,
  { canvasId, ids }: { canvasId: string; ids: string[] },
): Promise<Map<string, { userId: string | null; posthogSessionId: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await run(
    db
      .select({ id: events.id, userId: events.userId, posthogSessionId: events.posthogSessionId })
      .from(events)
      .where(and(eq(events.canvasId, canvasId), inArray(events.id, ids))),
  );
  return new Map(rows.map(({ id, ...origin }) => [id, origin]));
}

/** A person as an event names them. */
export function personOf(
  user: Pick<typeof users.$inferSelect, "id" | "name" | "githubLogin"> | null,
): EventPerson | null {
  return user
    ? { id: user.id, name: user.name ?? user.githubLogin, login: user.githubLogin }
    : null;
}

/** `now` as a statement's time, or the database's own clock when there is none. */
function at(now: Date | undefined) {
  return now ? sql`${timeParam(now)}::timestamptz` : sql`now()`;
}

/**
 * The kinds of event that begin a turn the agent owes a person an answer for, as a `now` or
 * `next` event. A stop and a push are put into nothing, and an edit never starts a turn.
 */
export const TURN_KINDS = ["message", "answer", "comment", "check", "review"] as const;

/** Whether `runnerId` holds `canvasId`'s lease, as a condition of the statement it is in. */
function leaseHeld(db: Db, canvasId: string, runnerId: string) {
  const leased = db
    .select({ id: canvasRunners.canvasId })
    .from(canvasRunners)
    .where(and(eq(canvasRunners.canvasId, canvasId), eq(canvasRunners.runnerId, runnerId)));
  return sql`exists (${leased})`;
}

/**
 * Hand a canvas's runner the events it has not been handed, oldest first, at most `limit`: those
 * not yet delivered and not already claimed by `runnerId`, which is then recorded as their
 * runner under `claimId`. So an event goes to each runner once, and one an earlier runner took
 * and never acknowledged (it is gone) is the next one's.
 *
 * `claimId` is the runner's, new for each claim. Sent again, because the first answer was lost,
 * it hands out again what that claim handed out and has not been acknowledged, and nothing
 * else. The canvas's head `seq` comes back from the same statement, so a claim that happened
 * always gets its answer.
 *
 * Only the canvas's current runner (`canvas_runners.runner_id`) is handed anything: a runner
 * whose lease was taken between its call being let in and this statement gets nothing. Null
 * when there is no such canvas.
 */
export async function claimEvents(
  db: Db,
  {
    canvasId,
    runnerId,
    claimId,
    limit = 100,
    now,
  }: {
    canvasId: string;
    runnerId: string;
    claimId: string;
    limit?: number;
    /** The API's clock, which the wake compares a claim with; the database's when absent. */
    now?: Date;
  },
): Promise<{
  events: ClaimedEvent[];
  seq: number;
  /** The canvas's pull request as its row says, for the agent's next turn. */
  pullRequest: { number: number; state: PrState } | null;
} | null> {
  const pending = and(eq(events.canvasId, canvasId), isNull(events.deliveredAt));
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
          leaseHeld(db, canvasId, runnerId),
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
      .set({ claimedAt: at(now), claimedBy: runnerId, claimId })
      .where(inArray(events.id, db.select({ id: waiting.id }).from(waiting)))
      .returning(),
  );
  // From the canvas, so that its head comes back when nothing is claimed.
  const rows = await run(
    db
      .with(claimed)
      .select({
        seq: canvases.seq,
        prNumber: canvases.prNumber,
        prState: canvases.prState,
        event: {
          id: claimed.id,
          canvasId: claimed.canvasId,
          seq: claimed.seq,
          kind: claimed.kind,
          priority: claimed.priority,
          payload: claimed.payload,
          posthogSessionId: claimed.posthogSessionId,
          createdAt: claimed.createdAt,
          claimedAt: claimed.claimedAt,
          claimedBy: claimed.claimedBy,
          claimId: claimed.claimId,
          deliveredAt: claimed.deliveredAt,
          lapsedAt: claimed.lapsedAt,
        },
        user: { id: users.id, name: users.name, githubLogin: users.githubLogin },
      })
      .from(canvases)
      .leftJoin(claimed, sql`true`)
      .leftJoin(users, eq(users.id, claimed.userId))
      .where(eq(canvases.id, canvasId)),
  );
  const [head] = rows;
  if (!head) return null;
  const claimedEvents = rows
    .flatMap(({ event, user }) => (event ? [{ ...event, from: personOf(user) }] : []))
    .sort((a, b) => a.seq - b.seq);
  const pullRequest =
    head.prNumber === null || head.prState === null
      ? null
      : { number: head.prNumber, state: head.prState };
  return { events: claimedEvents, seq: head.seq, pullRequest };
}

/**
 * Mark events as delivered, by id: `runnerId` has put them into the Claude session. Only events
 * it claimed are marked: anything else stays waiting, whatever its place in the feed, and an id
 * already marked, of another canvas or handed to another runner is left alone.
 * `claudeSessionId`, when not null, is stored as the canvas's session in the same statement, so
 * the next runner resumes the session these events went into. Nothing is marked or stored once
 * `runnerId` no longer holds the lease. Answers how many were marked.
 */
export async function markEventsDelivered(
  db: Db,
  {
    canvasId,
    runnerId,
    ids,
    claudeSessionId = null,
    now,
  }: {
    canvasId: string;
    runnerId: string;
    ids: string[];
    claudeSessionId?: string | null;
    /**
     * The API's clock, which the sweep weighs a delivered event's wait for its turn by (against
     * `canvas_runners.said_at`); the database's when absent.
     */
    now?: Date;
  },
): Promise<number> {
  const session = db.$with("session").as(
    db
      .update(canvasRunners)
      .set({ claudeSessionId })
      .where(
        and(
          eq(canvasRunners.canvasId, canvasId),
          eq(canvasRunners.runnerId, runnerId),
          sql`${claudeSessionId}::text is not null`,
        ),
      )
      .returning({ id: canvasRunners.canvasId }),
  );
  if (ids.length === 0) {
    await run(db.with(session).select({ id: session.id }).from(session));
    return 0;
  }
  const delivered = await run(
    db
      .with(session)
      .update(events)
      .set({ deliveredAt: at(now) })
      .where(
        and(
          eq(events.canvasId, canvasId),
          inArray(events.id, ids),
          isNull(events.deliveredAt),
          eq(events.claimedBy, runnerId),
          leaseHeld(db, canvasId, runnerId),
        ),
      )
      .returning({ id: events.id }),
  );
  return delivered.length;
}

/**
 * Of these ids, the canvas's `stop` events, each with the person who stopped the run: what a
 * runner's `stopped` notice names, for the API to say who it was.
 */
export async function findStops(
  db: Db,
  { canvasId, ids }: { canvasId: string; ids: string[] },
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
      .where(and(eq(events.canvasId, canvasId), eq(events.kind, "stop"), inArray(events.id, ids))),
  );
  return rows.map(({ id, user }) => ({ id, from: personOf(user) }));
}

/**
 * Whether the canvas's feed has an event that wakes a sandbox (`now` or `next`) that no runner
 * has put into its session: the pending rule after a sleep (docs/cloud.md, "The sandbox"). What
 * came in while the runner shut down, or what it claimed and never delivered, is the next
 * runner's, and asleep, nothing would wake the canvas for it.
 */
export async function hasPendingEvents(db: Db, canvasId: string): Promise<boolean> {
  const [row] = await run(
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.canvasId, canvasId),
          isNull(events.deliveredAt),
          inArray(events.priority, ["now", "next"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** An event the API stopped waiting on a turn for, and the copy that puts it in again, if any. */
export interface LapsedEvent {
  id: string;
  kind: FeedEvent["kind"];
  /** The event it is itself a copy of, when it is one: such a one is not put in again. */
  retryOf: string | null;
  /** The copy put in the feed for it, or null when it was a copy already. */
  copy: string | null;
}

/**
 * Give up waiting for the turn these delivered events were owed (docs/cloud.md, "A turn that
 * never came"), in one statement: each is marked lapsed, and each that is not itself a copy is
 * put in the feed again as a copy with a new id (`payload.retryOf` naming it), which no runner
 * has seen, so the next claim hands it out and the runner puts it into the session as new. Only
 * events not lapsed already are touched, so of two sweeps one does it. Answers what it lapsed.
 */
export async function lapseEvents(
  db: Db,
  { canvasId, ids, now }: { canvasId: string; ids: string[]; now: Date },
): Promise<LapsedEvent[]> {
  if (ids.length === 0) return [];
  const pairs = JSON.stringify(ids.map((id) => ({ id, copy: newId("evt") })));
  const result = await queryJson<{ rows: LapsedEvent[] }>(
    db,
    sql`
      with pairs as (
        select p.id, p.copy from json_to_recordset(${pairs}::json) as p(id text, copy text)
      ), lapsed as (
        update events e set lapsed_at = ${timeParam(now)}::timestamptz
         where e.canvas_id = ${canvasId} and e.id in (select id from pairs)
           and e.lapsed_at is null and e.delivered_at is not null
        returning e.*
      ), copies as (
        insert into events (id, canvas_id, kind, priority, payload, user_id, posthog_session_id)
        select p.copy, l.canvas_id, l.kind, l.priority,
               l.payload || jsonb_build_object('retryOf', l.id), l.user_id, l.posthog_session_id
          from lapsed l join pairs p on p.id = l.id
         where l.payload->>'retryOf' is null
        returning id, payload->>'retryOf' as of
      )
      select json_build_object('rows', coalesce(json_agg(json_build_object(
        'id', l.id, 'kind', l.kind, 'retryOf', l.payload->>'retryOf', 'copy', c.id
      ) order by l.seq), '[]'::json)) as result
        from lapsed l left join copies c on c.of = l.id
    `,
  );
  return result?.rows ?? [];
}
