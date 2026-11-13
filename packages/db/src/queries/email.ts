import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { memberships, notifications, users, workspaces } from "../schema/index.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * What Ponzu's emails read and write besides the notifications themselves (docs/cloud.md,
 * "Email"): a person's address and switches, read when an email is sent rather than when it was
 * queued, and the stamps that make each automatic email go at most once.
 *
 * Every function here that depends on the time takes `now` from its caller.
 */

/** A person as an email needs them, read at send time. */
export interface EmailRecipient {
  email: string | null;
  emailDigest: boolean;
  emailTeam: boolean;
  emailRecap: boolean;
}

/** The person's address and email switches as they are now, or null when there is no such person. */
export async function emailRecipient(db: Db, userId: string): Promise<EmailRecipient | null> {
  const [row] = await run(
    db
      .select({
        email: users.email,
        emailDigest: users.emailDigest,
        emailTeam: users.emailTeam,
        emailRecap: users.emailRecap,
      })
      .from(users)
      .where(eq(users.id, userId)),
  );
  return row ?? null;
}

/**
 * Whether the "people joined" email could reach the person at all: they are an admin of at
 * least one organisation's workspace. Settings shows its switch only then.
 */
export async function teamEmailAvailable(db: Db, userId: string): Promise<boolean> {
  const [row] = await run(
    db
      .select({ one: sql<number>`1` })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.role, "admin"),
          eq(workspaces.kind, "org"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/**
 * Record that a notification's email is done with: sent, or found stale, held or paused when its
 * job ran. The first stamp stays. Answers whether this call made it.
 */
export async function stampNotificationEmailed(
  db: Db,
  { notificationId, now }: { notificationId: string; now: Date },
): Promise<boolean> {
  const stamped = await run(
    db
      .update(notifications)
      .set({ emailedAt: sql`${timeParam(now)}::timestamptz` })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.emailedAt)))
      .returning({ id: notifications.id }),
  );
  return stamped.length > 0;
}
