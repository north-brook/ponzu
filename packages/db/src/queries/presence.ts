import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { presence, users } from "../schema/index.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

/** A client refreshes its row every 30 seconds; one not refreshed for this long is gone. */
export const PRESENCE_TTL_SECONDS = 75;

/**
 * Whether a row was last refreshed more than `ttlSeconds` before `now`. The time is the
 * caller's, not Postgres's, so the API's clock decides who is still here.
 */
const stale = (now: Date, ttlSeconds: number) =>
  sql`${presence.seenAt} < ${timeParam(new Date(now.getTime() - ttlSeconds * 1000))}::timestamptz`;

/**
 * Say a person has a canvas open, as of `now`. Call it on opening and every 30 seconds after.
 *
 * `pageId` is the page they are on; leave it out to say only "still here", and the page they
 * were on stands. Someone whose row had gone stale is arriving again, not still here, so they
 * join afresh.
 *
 * `focused` says whether their window is focused and showing the canvas: true marks it focused
 * as of `now`, false clears it, and leaving it out keeps what it was. Nobody is pinged about a
 * canvas they are looking at.
 */
export async function touchPresence(
  db: Db,
  {
    canvasId,
    userId,
    pageId,
    focused,
    now,
  }: { canvasId: string; userId: string; pageId?: string | null; focused?: boolean; now: Date },
): Promise<void> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const focusedAt = focused === undefined ? undefined : focused ? at : null;
  await run(
    db
      .insert(presence)
      .values({
        canvasId,
        userId,
        pageId,
        joinedAt: at,
        seenAt: at,
        ...(focusedAt === undefined ? {} : { focusedAt }),
      })
      .onConflictDoUpdate({
        target: [presence.canvasId, presence.userId],
        set: {
          ...(pageId === undefined ? {} : { pageId }),
          ...(focusedAt === undefined ? {} : { focusedAt }),
          joinedAt: sql`case when ${stale(now, PRESENCE_TTL_SECONDS)} then ${at} else ${presence.joinedAt} end`,
          seenAt: at,
        },
      }),
  );
}

/**
 * When each of these people last had this canvas focused, for those whose row says so. A row
 * past the TTL as of `now` counts as not here.
 */
export async function focusedPresence(
  db: Db,
  { canvasId, userIds, now }: { canvasId: string; userIds: readonly string[]; now: Date },
): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await run(
    db
      .select({ userId: presence.userId, focusedAt: presence.focusedAt })
      .from(presence)
      .where(
        and(
          eq(presence.canvasId, canvasId),
          inArray(presence.userId, [...userIds]),
          sql`${presence.focusedAt} is not null`,
          sql`not ${stale(now, PRESENCE_TTL_SECONDS)}`,
        ),
      ),
  );
  return new Map(rows.map((row) => [row.userId, row.focusedAt!]));
}

export interface PresentUser {
  userId: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  pageId: string | null;
  joinedAt: Date;
  seenAt: Date;
}

/** Who has a canvas open as of `now`, longest here first. Rows past the TTL are left out. */
export function listPresence(
  db: Db,
  {
    canvasId,
    now,
    ttlSeconds = PRESENCE_TTL_SECONDS,
  }: { canvasId: string; now: Date; ttlSeconds?: number },
): Promise<PresentUser[]> {
  return run(
    db
      .select({
        userId: presence.userId,
        githubLogin: users.githubLogin,
        name: users.name,
        avatarUrl: users.avatarUrl,
        pageId: presence.pageId,
        joinedAt: presence.joinedAt,
        seenAt: presence.seenAt,
      })
      .from(presence)
      .innerJoin(users, eq(users.id, presence.userId))
      .where(and(eq(presence.canvasId, canvasId), sql`not ${stale(now, ttlSeconds)}`))
      .orderBy(presence.joinedAt, presence.userId),
  );
}

/** Say a person closed a canvas, so they leave at once and not when their row goes stale. */
export async function removePresence(
  db: Db,
  { canvasId, userId }: { canvasId: string; userId: string },
): Promise<void> {
  await run(
    db.delete(presence).where(and(eq(presence.canvasId, canvasId), eq(presence.userId, userId))),
  );
}

/**
 * Delete rows past the TTL as of `now`, for the sweeper. A live query cannot compare against
 * the clock, so a watcher only sees someone leave when their row does. Answers how many went.
 */
export async function deleteStalePresence(
  db: Db,
  { now, ttlSeconds = PRESENCE_TTL_SECONDS }: { now: Date; ttlSeconds?: number },
): Promise<number> {
  const gone = await run(
    db.delete(presence).where(stale(now, ttlSeconds)).returning({ userId: presence.userId }),
  );
  return gone.length;
}
