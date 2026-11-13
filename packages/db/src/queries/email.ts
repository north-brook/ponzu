import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { memberships, notifications, users, workspaces } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { DIGEST_DEFAULT_TIME_ZONE } from "./notifications.ts";
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

// ---------------------------------------------------------------------------------------------
// The Friday recap (docs/cloud.md, "Email"): on Fridays from 15:00 where the person is, the
// pull requests merged that week from canvases they own. `users.recap_sent_on` is the last
// Friday handled, sent or skipped, so it goes at most once a week.
//
// Where a person is: their app's time zone, or `DIGEST_DEFAULT_TIME_ZONE` when it reported none
// or one Postgres does not know (the same guard as `digestsDue`), so one odd zone can never fail
// the query for everyone. A merge is the thread notice `ti_pr-<n>-merged`, which Ponzu writes
// once, when it first sees the merge; its `created_at` stands in for the merge time. The week is
// `[last Friday 15:00, this Friday 15:00)` in the person's zone, computed in Postgres, so it
// follows daylight saving.

/** The local hour on Fridays from which a person's recap may go. */
export const RECAP_HOUR = 15;

/** A person whose recap is due, the Friday it is for (`YYYY-MM-DD`), and the zone it is timed in. */
export interface RecapDue {
  userId: string;
  friday: string;
  /** The zone the week was computed in: the person's own, or the default. */
  timeZone: string;
}

/** A merge notice on a thread, the thread notice id's pattern, for `like … escape '\'`. */
const MERGED_NOTICE = "ti\\_pr-%-merged";

/**
 * The people whose recap is due at `now`, each with the Friday and zone, and whether a merge
 * from a canvas they own landed in that Friday's week. Shared by the two statements below, which
 * must agree exactly on who is due.
 */
function recapsDueSql(now: Date) {
  const at = sql`${timeParam(now)}::timestamptz`;
  return sql`
    zones as (select name from pg_timezone_names),
    placed as (
      select u.id, u.created_at, u.recap_sent_on,
             coalesce(z.name, ${DIGEST_DEFAULT_TIME_ZONE}) as zone,
             (${at} at time zone coalesce(z.name, ${DIGEST_DEFAULT_TIME_ZONE})) as local
        from users u
        left join zones z on z.name = u.time_zone
       where u.email_recap and u.email is not null
    ),
    due as (
      select id, created_at, zone, local::date as friday,
             ((local::date - 7) + time '15:00') at time zone zone as week_from,
             (local::date + time '15:00') at time zone zone as week_until
        from placed
       where extract(isodow from local) = 5
         and extract(hour from local) >= ${RECAP_HOUR}
         and (recap_sent_on is null or recap_sent_on < local::date)
    ),
    marked as (
      select due.*, exists (
               select 1
                 from canvases c
                 join thread_items t on t.canvas_id = c.id
                where c.owner_id = due.id
                  and t.kind = 'notice'
                  and t.id like ${MERGED_NOTICE} escape '\\'
                  and t.created_at >= due.week_from
                  and t.created_at < due.week_until
             ) as merged
        from due
    )`;
}

/**
 * Stamp, in one statement, every person whose recap is due at `now` and who has nothing to be
 * sent: no canvas they own had a merge in their week. Most people in most weeks are these, so
 * they never take a place in the batch of real sends. Answers how many were stamped.
 */
export async function stampQuietRecaps(db: Db, { now }: { now: Date }): Promise<number> {
  const result = await queryJson<{ count: number }>(
    db,
    sql`
      with ${recapsDueSql(now)},
      stamped as (
        update users u
           set recap_sent_on = greatest(u.recap_sent_on, marked.friday), updated_at = now()
          from marked
         where u.id = marked.id and not marked.merged
        returning u.id
      )
      select json_build_object('count', count(*)) as result from stamped
    `,
  );
  return Number(result?.count ?? 0);
}

/**
 * Up to `limit` people whose recap is due at `now` and who have a merge in their week, oldest
 * accounts first. Someone whose recap job is already waiting (of kind `job.kind`, keyed
 * `<job.keyPrefix>:<user>:<friday>`) is left to it, so a job Resend held back does not take a
 * place in the next batch.
 */
export async function recapsDue(
  db: Db,
  { now, limit = 20, job }: { now: Date; limit?: number; job: { kind: string; keyPrefix: string } },
): Promise<RecapDue[]> {
  const result = await queryJson<RecapDue[]>(
    db,
    sql`
      with ${recapsDueSql(now)}
      select coalesce(json_agg(json_build_object(
               'userId', id, 'friday', to_char(friday, 'YYYY-MM-DD'), 'timeZone', zone
             ) order by created_at, id), '[]') as result
        from (
          select * from marked
           where merged
             and not exists (
               select 1 from jobs j
                where j.kind = ${job.kind}
                  and j.key = ${job.keyPrefix} || ':' || marked.id || ':' || to_char(marked.friday, 'YYYY-MM-DD')
                  and j.completed_at is null and j.failed_at is null
             )
           order by created_at, id
           limit ${limit}
        ) picked
    `,
  );
  return result ?? [];
}

/** One merge in a person's week, from a canvas they own. */
export interface RecapMerge {
  canvasId: string;
  canvasName: string;
  workspaceId: string;
  workspaceName: string;
  /** The pull request's number. */
  number: number;
  /** When Ponzu first saw the merge. */
  mergedAt: Date;
}

/**
 * The merges in the week that ends on `friday` at 15:00 in `timeZone` (the default zone when
 * Postgres does not know it), from canvases `userId` owns now, newest first. Numbers and names
 * only: never the pull request's title, which the agent wrote.
 */
export async function recapMerges(
  db: Db,
  { userId, friday, timeZone }: { userId: string; friday: string; timeZone: string },
): Promise<RecapMerge[]> {
  const rows = await queryJson<
    {
      canvas_id: string;
      canvas_name: string;
      workspace_id: string;
      workspace_name: string;
      number: number;
      merged_at: string;
    }[]
  >(
    db,
    sql`
      with zone as (
        select coalesce(
                 (select name from pg_timezone_names where name = ${timeZone}),
                 ${DIGEST_DEFAULT_TIME_ZONE}
               ) as name
      ),
      week as (
        select ((${friday}::date - 7) + time '15:00') at time zone zone.name as week_from,
               (${friday}::date + time '15:00') at time zone zone.name as week_until
          from zone
      )
      select coalesce(json_agg(json_build_object(
               'canvas_id', c.id, 'canvas_name', c.name,
               'workspace_id', w.id, 'workspace_name', w.name,
               'number', (t.payload->>'number')::int, 'merged_at', t.created_at
             ) order by t.created_at desc, c.id, t.id), '[]') as result
        from canvases c
        join workspaces w on w.id = c.workspace_id
        join thread_items t on t.canvas_id = c.id
        cross join week
       where c.owner_id = ${userId}
         and t.kind = 'notice'
         and t.id like ${MERGED_NOTICE} escape '\\'
         and t.payload->>'number' ~ '^[0-9]{1,9}$'
         and t.created_at >= week.week_from
         and t.created_at < week.week_until
    `,
  );
  return (rows ?? []).map((row) => ({
    canvasId: row.canvas_id,
    canvasName: row.canvas_name,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    number: Number(row.number),
    mergedAt: new Date(row.merged_at),
  }));
}

/** What the recap's job reads of its person, or null when there is no such person. */
export interface RecapPerson {
  /** The last Friday handled, `YYYY-MM-DD`. */
  recapSentOn: string | null;
  /** When the first real recap went; null until then. */
  recapFirstSentAt: Date | null;
}

export async function recapPerson(db: Db, userId: string): Promise<RecapPerson | null> {
  const [row] = await run(
    db
      .select({ recapSentOn: users.recapSentOn, recapFirstSentAt: users.recapFirstSentAt })
      .from(users)
      .where(eq(users.id, userId)),
  );
  return row ?? null;
}

/**
 * Record that the recap for `friday` is handled: sent, or found to have nothing to say. An
 * earlier Friday than the one kept changes nothing, so a late retry cannot send twice. `sent`
 * also sets when the first recap went, once.
 */
export async function stampRecapSent(
  db: Db,
  { userId, friday, sent, now }: { userId: string; friday: string; sent: boolean; now: Date },
): Promise<void> {
  await run(
    db
      .update(users)
      .set({
        recapSentOn: sql`greatest(${users.recapSentOn}, ${friday}::date)`,
        ...(sent
          ? {
              recapFirstSentAt: sql`coalesce(${users.recapFirstSentAt}, ${timeParam(now)}::timestamptz)`,
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId)),
  );
}
