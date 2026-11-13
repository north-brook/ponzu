import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
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
 * least one organisation's workspace that they reach on GitHub as its owner or a member. An
 * outside collaborator made an admin in Ponzu is never sent it (the members of an organisation
 * are not theirs to see), so Settings does not show them its switch.
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
          inArray(memberships.githubAccess, ["owner", "member"]),
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

// ---------------------------------------------------------------------------------------------
// People joined (docs/cloud.md, "Email"): who joined an organisation's workspace, rolled up and
// sent to its admins at most once a day. `workspaces.members_announced_at` is where the next
// email's window starts; nobody whose membership is older is ever announced.

/** How a member reaches the organisation, for the people-joined email to name or reach them. */
const TEAM_ACCESS = ["owner", "member"] as const;

/** A workspace as the people-joined email reads it. */
export interface TeamEmailWorkspace {
  id: string;
  name: string;
  kind: "personal" | "org";
  installedByUserId: string | null;
  /** Where the next email's window starts. */
  membersAnnouncedAt: Date;
}

/** The workspace as the people-joined email reads it now, or null when it is gone. */
export async function teamEmailWorkspace(
  db: Db,
  workspaceId: string,
): Promise<TeamEmailWorkspace | null> {
  const [row] = await run(
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        installedByUserId: workspaces.installedByUserId,
        membersAnnouncedAt: workspaces.membersAnnouncedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  );
  return row ?? null;
}

/** Someone the people-joined email may name. */
export interface Joiner {
  userId: string;
  name: string | null;
  login: string;
  joinedAt: Date;
}

/**
 * The people who joined a workspace after `after` (and at or before `until`, when given) whom the
 * email may name, oldest join first: their membership still exists, they reach the organisation
 * on GitHub as its owner or a member (never as an outside collaborator), and they are not the
 * person who installed the App. At most `limit`.
 */
export async function teamJoiners(
  db: Db,
  {
    workspaceId,
    after,
    until,
    installedByUserId,
    limit = 1000,
  }: {
    workspaceId: string;
    after: Date;
    until?: Date;
    installedByUserId: string | null;
    limit?: number;
  },
): Promise<Joiner[]> {
  return run(
    db
      .select({
        userId: memberships.userId,
        name: users.name,
        login: users.githubLogin,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          gt(memberships.createdAt, sql`${timeParam(after)}::timestamptz`),
          until ? lte(memberships.createdAt, sql`${timeParam(until)}::timestamptz`) : undefined,
          inArray(memberships.githubAccess, TEAM_ACCESS),
          installedByUserId ? ne(memberships.userId, installedByUserId) : undefined,
        ),
      )
      .orderBy(asc(memberships.createdAt), asc(memberships.userId))
      .limit(limit),
  );
}

/** How many people reach the workspace as its owner or a member and had joined by `until`. */
export async function teamSize(
  db: Db,
  { workspaceId, until }: { workspaceId: string; until: Date },
): Promise<number> {
  const [row] = await run(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          inArray(memberships.githubAccess, TEAM_ACCESS),
          lte(memberships.createdAt, sql`${timeParam(until)}::timestamptz`),
        ),
      ),
  );
  return Number(row?.count ?? 0);
}

/**
 * Who the people-joined email goes to: the workspace's admins who reach the organisation as its
 * owner or a member. An outside collaborator an admin promoted is never one, because the members
 * of an organisation are not theirs to see. Their address and switch are read when it is sent.
 */
export async function teamEmailAdmins(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await run(
    db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.role, "admin"),
          inArray(memberships.githubAccess, TEAM_ACCESS),
        ),
      )
      .orderBy(asc(memberships.userId)),
  );
  return rows.map((row) => row.userId);
}

/**
 * Move where the workspace's next people-joined email starts to `until`, never back. Answers
 * whether it moved.
 */
export async function stampMembersAnnounced(
  db: Db,
  { workspaceId, until }: { workspaceId: string; until: Date },
): Promise<boolean> {
  const moved = await run(
    db
      .update(workspaces)
      .set({ membersAnnouncedAt: sql`${timeParam(until)}::timestamptz` })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          lt(workspaces.membersAnnouncedAt, sql`${timeParam(until)}::timestamptz`),
        ),
      )
      .returning({ id: workspaces.id }),
  );
  return moved.length > 0;
}

/**
 * Move every workspace's people-joined window to start at `now`, never back: run once before the
 * email is first released in an environment, so only people who join from then on are
 * announced. Answers how many workspaces moved.
 */
export async function stampAllMembersAnnounced(db: Db, { now }: { now: Date }): Promise<number> {
  const moved = await run(
    db
      .update(workspaces)
      .set({ membersAnnouncedAt: sql`${timeParam(now)}::timestamptz` })
      .where(lt(workspaces.membersAnnouncedAt, sql`${timeParam(now)}::timestamptz`))
      .returning({ id: workspaces.id }),
  );
  return moved.length;
}
