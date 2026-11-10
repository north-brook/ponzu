import { eq, getTableColumns } from "drizzle-orm";
import type { Db } from "../client.ts";
import { sessions, users } from "../schema/index.ts";
import type { User } from "./accounts.ts";
import { run } from "./run.ts";

/**
 * Record that a WorkOS session belongs to a person the sign-in exchange let in. Admitting the
 * same session again changes nothing, and never moves it to someone else.
 */
export async function admitSession(db: Db, session: { id: string; userId: string }): Promise<void> {
  await run(db.insert(sessions).values(session).onConflictDoNothing());
}

/** The person an admitted session belongs to, or null if the API never let that session in. */
export async function getSessionUser(db: Db, sessionId: string): Promise<User | null> {
  const [user] = await run(
    db
      .select(getTableColumns(users))
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionId)),
  );
  return user ?? null;
}

/** Forget a session, as on sign-out: its access tokens stop being honored at once. */
export async function endSession(db: Db, sessionId: string): Promise<void> {
  await run(db.delete(sessions).where(eq(sessions.id, sessionId)));
}
