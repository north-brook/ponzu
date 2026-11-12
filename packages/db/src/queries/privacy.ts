import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { users } from "../schema/index.ts";
import { run } from "./run.ts";

/*
 * Settings › Account › Share usage data (docs/analytics.md, "Turning it off"): one switch on the
 * person's row, on by default. Off, the API's analytics sink drops what it would send about
 * them, and the agent's turns they begin are not traced.
 */

/**
 * Turns a person's usage sharing on or off. Answers what their row says now, or null when there
 * is no such person.
 */
export async function setShareUsage(
  db: Db,
  { userId, shareUsage }: { userId: string; shareUsage: boolean },
): Promise<{ shareUsage: boolean } | null> {
  const [row] = await run(
    db
      .update(users)
      .set({ shareUsage })
      .where(eq(users.id, userId))
      .returning({ shareUsage: users.shareUsage }),
  );
  return row ?? null;
}

/** The ids of everyone who has turned usage sharing off: what the analytics sink leaves out. */
export async function listUsageOptOuts(db: Db): Promise<string[]> {
  const rows = await run(
    db.select({ id: users.id }).from(users).where(eq(users.shareUsage, false)),
  );
  return rows.map((row) => row.id);
}
