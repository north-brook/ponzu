import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { presence, users } from "../schema/index.ts";

/** A client refreshes its row every 30 seconds; one not refreshed for this long is gone. */
export const PRESENCE_TTL_SECONDS = 75;

const stale = (ttlSeconds: number) =>
  sql`${presence.seenAt} < now() - make_interval(secs => ${ttlSeconds})`;

/** Say a person has a design open, now. Call it on opening and every 30 seconds after. */
export async function touchPresence(
  db: Db,
  { designId, userId, pageId = null }: { designId: string; userId: string; pageId?: string | null },
): Promise<void> {
  await db
    .insert(presence)
    .values({ designId, userId, pageId })
    .onConflictDoUpdate({
      target: [presence.designId, presence.userId],
      set: { pageId, seenAt: sql`now()` },
    });
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

/** Who has a design open, longest here first. Rows past the TTL are left out. */
export function listPresence(
  db: Db,
  { designId, ttlSeconds = PRESENCE_TTL_SECONDS }: { designId: string; ttlSeconds?: number },
): Promise<PresentUser[]> {
  return db
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
    .where(and(eq(presence.designId, designId), sql`not ${stale(ttlSeconds)}`))
    .orderBy(presence.joinedAt, presence.userId);
}

/** Say a person closed a design, so they leave at once and not when their row goes stale. */
export async function removePresence(
  db: Db,
  { designId, userId }: { designId: string; userId: string },
): Promise<void> {
  await db
    .delete(presence)
    .where(and(eq(presence.designId, designId), eq(presence.userId, userId)));
}

/**
 * Delete rows past the TTL, for the sweeper. A live query cannot compare against the clock, so
 * a watcher only sees someone leave when their row does. Answers how many went.
 */
export async function deleteStalePresence(
  db: Db,
  ttlSeconds: number = PRESENCE_TTL_SECONDS,
): Promise<number> {
  const gone = await db
    .delete(presence)
    .where(stale(ttlSeconds))
    .returning({ userId: presence.userId });
  return gone.length;
}
