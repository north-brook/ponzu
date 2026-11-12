import { and, desc, eq, gt, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { designs, events, threadItems } from "../schema/index.ts";
import { run } from "./run.ts";

/*
 * What started the turn a design's agent is in, as the API reads it from the design's feed, and
 * what the agent has done to the design's pull request lately (docs/cloud.md, "The agent's pull
 * request"). The agent acts on its pull request as a person; these say which one, and whether
 * that person's words are the last outside words the agent took in.
 */

/** The kinds of event a person in Ponzu sends: their message, their answer, their comment. */
export const PERSON_KINDS = ["message", "answer", "comment"] as const;
/** The kinds of event whose words came from GitHub: a failed check, a review. */
export const GITHUB_KINDS = ["check", "review"] as const;

export interface TurnOrigin {
  /**
   * The event the runner named as the one that began the turn, when it is one of the design's
   * that this runner (`runnerId`) was handed. Null for none, for one the design never had, and
   * for one an earlier runner was handed: a turn picked up after a restart, or an old event a
   * runner token in other hands could name from the feed.
   */
  event: { id: string; kind: string; userId: string | null } | null;
  /**
   * Whether a check or a review later in the feed than that event was handed to a runner: GitHub's
   * words may have gone in after the person's, in the turn or since. Handed, not only delivered,
   * so an acknowledgement still on its way never lets them through.
   */
  githubSince: boolean;
  /**
   * Whether a message, answer or comment from anyone but that event's person, later in the feed,
   * was handed to a runner: someone else spoke in the turn, or since, so what lands is no longer
   * one person's request.
   */
  othersSince: boolean;
  /** The person whose message, answer or comment last went into the session, if any did. */
  lastPerson: string | null;
  /** The design's owner, unless their account is gone. */
  ownerId: string | null;
}

/**
 * Where the turn `eventId` began stands, for the design: the event itself, whether GitHub has
 * spoken since, and who the agent works for when no person began the turn. Null when there is
 * no such design.
 */
export async function getTurnOrigin(
  db: Db,
  {
    designId,
    eventId,
    runnerId = null,
  }: { designId: string; eventId: string | null; runnerId?: string | null },
): Promise<TurnOrigin | null> {
  const [design] = await run(
    db.select({ ownerId: designs.ownerId }).from(designs).where(eq(designs.id, designId)),
  );
  if (!design) return null;
  const [event] = eventId
    ? await run(
        db
          .select({ id: events.id, kind: events.kind, userId: events.userId, seq: events.seq })
          .from(events)
          .where(
            and(
              eq(events.designId, designId),
              eq(events.id, eventId),
              runnerId ? eq(events.claimedBy, runnerId) : isNotNull(events.claimedBy),
            ),
          ),
      )
    : [];
  /** Whether an event matching `which`, later than the turn's, was handed to a runner. */
  const handedSince = async (which: SQL | undefined): Promise<boolean> => {
    if (!event) return false;
    const [found] = await run(
      db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.designId, designId),
            gt(events.seq, event.seq),
            isNotNull(events.claimedBy),
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
          eq(events.designId, designId),
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
    ownerId: design.ownerId,
  };
}

/**
 * How many times the design's agent did `action` to its pull request since `since`, as its
 * thread's notices of it say (`pull_request_agent`, by the `at` the API wrote in each): what
 * its limits count.
 */
export async function countAgentPullRequestActions(
  db: Db,
  { designId, action, since }: { designId: string; action: string; since: Date },
): Promise<number> {
  const [row] = await run(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(threadItems)
      .where(
        and(
          eq(threadItems.designId, designId),
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
