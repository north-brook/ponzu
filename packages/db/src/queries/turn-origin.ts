import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { canvases, events, threadItems } from "../schema/index.ts";
import { run } from "./run.ts";

/*
 * What started the turn a canvas's agent is in, as the API reads it from the canvas's feed, and
 * what the agent has done to the canvas's pull request lately (docs/cloud.md, "The agent's pull
 * request"). The agent acts on its pull request as a person; these say which one, and whether
 * that person's words are the last outside words the agent took in.
 */

/** The kinds of event a person in Ponzu sends: their message, their answer, their comment. */
export const PERSON_KINDS = ["message", "answer", "comment"] as const;
/** The kinds of event whose words came from GitHub: a failed check, a review. */
export const GITHUB_KINDS = ["check", "review"] as const;

export interface TurnOrigin {
  /**
   * The event the runner named as the one that began the turn, when it is one of the canvas's
   * that this runner (`runnerId`) was handed. Null for none, for one the canvas never had, and
   * for one an earlier runner was handed: a turn picked up after a restart, or an old event a
   * runner token in other hands could name from the feed.
   */
  event: { id: string; kind: string; userId: string | null } | null;
  /**
   * Whether a check or a review went into the session after that event, or may yet: one handed
   * to a runner and not acknowledged, or acknowledged no earlier than that event was. By when it
   * went in, not its place in the feed, since a runner holds an older event back behind a newer
   * one; held, not only delivered, so an acknowledgement still on its way never lets it through.
   */
  githubSince: boolean;
  /**
   * Whether a message, answer or comment from anyone but that event's person went into the
   * session after that event, or may yet, by the same rule: someone else spoke in the turn, or
   * since, so what lands is no longer one person's request.
   */
  othersSince: boolean;
  /** The person whose message, answer or comment last went into the session, if any did. */
  lastPerson: string | null;
  /** The canvas's owner, unless their account is gone. */
  ownerId: string | null;
}

/**
 * Where the turn `eventId` began stands, for the canvas: the event itself, whether GitHub has
 * spoken since, and who the agent works for when no person began the turn. Null when there is
 * no such canvas.
 */
export async function getTurnOrigin(
  db: Db,
  {
    canvasId,
    eventId,
    runnerId = null,
  }: { canvasId: string; eventId: string | null; runnerId?: string | null },
): Promise<TurnOrigin | null> {
  const [canvas] = await run(
    db.select({ ownerId: canvases.ownerId }).from(canvases).where(eq(canvases.id, canvasId)),
  );
  if (!canvas) return null;
  const [event] = eventId
    ? await run(
        db
          .select({
            id: events.id,
            kind: events.kind,
            userId: events.userId,
            deliveredAt: events.deliveredAt,
          })
          .from(events)
          .where(
            and(
              eq(events.canvasId, canvasId),
              eq(events.id, eventId),
              runnerId ? eq(events.claimedBy, runnerId) : isNotNull(events.claimedBy),
            ),
          ),
      )
    : [];
  /**
   * Whether an event matching `which` went into the session after the turn's, or may yet. Handoff
   * order is the order the session took events in, which acknowledgements keep (`delivered_at`,
   * by the API's clock): not the feed's, since a runner puts a `now` event in ahead of an older
   * `next` one it holds. So it counts when it was handed to a runner and is not acknowledged (it
   * may still go in), or was acknowledged no earlier than the turn's event: the same moment is
   * one batch of acknowledgements, whose order is not known, so it counts. Before the turn's own
   * acknowledgement arrives, one already acknowledged went in ahead of it.
   */
  const handedSince = async (which: SQL | undefined): Promise<boolean> => {
    if (!event) return false;
    const after = event.deliveredAt
      ? or(isNull(events.deliveredAt), gte(events.deliveredAt, event.deliveredAt))
      : isNull(events.deliveredAt);
    const [found] = await run(
      db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.canvasId, canvasId),
            ne(events.id, event.id),
            isNotNull(events.claimedBy),
            after,
            which,
          ),
        )
        .limit(1),
    );
    return found !== undefined;
  };
  const githubSince = await handedSince(inArray(events.kind, [...GITHUB_KINDS]));
  const othersSince = await handedSince(
    and(
      inArray(events.kind, [...PERSON_KINDS]),
      sql`${events.userId} is distinct from ${event?.userId ?? null}`,
    ),
  );
  const [last] = await run(
    db
      .select({ userId: events.userId })
      .from(events)
      .where(
        and(
          eq(events.canvasId, canvasId),
          inArray(events.kind, [...PERSON_KINDS]),
          isNotNull(events.userId),
          isNotNull(events.deliveredAt),
        ),
      )
      .orderBy(desc(events.seq))
      .limit(1),
  );
  return {
    event: event ? { id: event.id, kind: event.kind, userId: event.userId } : null,
    githubSince,
    othersSince,
    lastPerson: last?.userId ?? null,
    ownerId: canvas.ownerId,
  };
}

/**
 * How many times the canvas's agent did `action` to its pull request since `since`, as its
 * thread's notices of it say (`pull_request_agent`, by the `at` the API wrote in each): what
 * its limits count.
 */
export async function countAgentPullRequestActions(
  db: Db,
  { canvasId, action, since }: { canvasId: string; action: string; since: Date },
): Promise<number> {
  const [row] = await run(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(threadItems)
      .where(
        and(
          eq(threadItems.canvasId, canvasId),
          eq(threadItems.kind, "notice"),
          sql`${threadItems.payload}->>'type' = 'pull_request_agent'`,
          sql`${threadItems.payload}->>'action' = ${action}`,
          // By the API's clock, which wrote it there.
          sql`(${threadItems.payload}->>'at')::timestamptz > ${since.toISOString()}::timestamptz`,
        ),
      ),
  );
  return row?.count ?? 0;
}
