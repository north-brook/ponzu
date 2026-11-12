import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type {
  DeliveryState,
  MemberRole,
  NotificationKind,
  NotificationReadVia,
  RepoPermission,
  WorkspaceKind,
} from "../enums.ts";
import { newId } from "../ids.ts";
import {
  devices,
  memberships,
  type NotificationLink,
  notificationDeliveries,
  notifications,
  users,
  workspaces,
} from "../schema/index.ts";
import type { User } from "./accounts.ts";
import { queryJson, timeParam } from "./json.ts";
import { QueryError, run } from "./run.ts";

/*
 * What pings a person and where (docs/cloud.md, "Notifications"): the toggles of Settings ›
 * Notifications, which live on their row; the devices they use, an iPhone by its Expo push
 * token and a Mac by its install; what Ponzu told them (`notifications`, the inbox); and each
 * push of it to an iPhone (`notification_deliveries`).
 *
 * Every function here that depends on the time takes `now` from its caller.
 */

const at = (time: Date) => sql`${timeParam(time)}::timestamptz`;

/** The events that may ping a person, and the daily email. */
export interface PingPrefs {
  needsYou: boolean;
  replies: boolean;
  prReady: boolean;
  teammateComments: boolean;
  emailDigest: boolean;
}

/** A person's toggles, read from their row as the API already holds it. */
export function pingPrefsOf(user: User): PingPrefs {
  return {
    needsYou: user.pingNeedsYou,
    replies: user.pingReplies,
    prReady: user.pingPrReady,
    teammateComments: user.pingTeammateComments,
    emailDigest: user.emailDigest,
  };
}

/** Change some of a person's toggles; the rest stay. Answers them all as they are now. */
export async function setPingPrefs(
  db: Db,
  { userId, prefs }: { userId: string; prefs: Partial<PingPrefs> },
): Promise<PingPrefs> {
  const result = await queryJson<PingPrefs>(
    db,
    sql`
      with changed as (
        update users set
          ping_needs_you = coalesce(${prefs.needsYou ?? null}::boolean, ping_needs_you),
          ping_replies = coalesce(${prefs.replies ?? null}::boolean, ping_replies),
          ping_pr_ready = coalesce(${prefs.prReady ?? null}::boolean, ping_pr_ready),
          ping_teammate_comments = coalesce(${prefs.teammateComments ?? null}::boolean,
                                            ping_teammate_comments),
          email_digest = coalesce(${prefs.emailDigest ?? null}::boolean, email_digest),
          updated_at = now()
        where id = ${userId}
        returning *
      )
      select json_build_object(
        'needsYou', ping_needs_you, 'replies', ping_replies, 'prReady', ping_pr_ready,
        'teammateComments', ping_teammate_comments, 'emailDigest', email_digest
      ) as result from changed
    `,
  );
  if (!result) throw new Error(`There is no user ${userId}.`);
  return result;
}

/**
 * Keep the time zone a person's app reports (an IANA name, checked by the caller), which the
 * daily email's 9:00 is in. Answers it as kept.
 */
export async function setTimeZone(
  db: Db,
  { userId, timeZone }: { userId: string; timeZone: string },
): Promise<string> {
  const [row] = await run(
    db
      .update(users)
      .set({ timeZone, updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ timeZone: users.timeZone }),
  );
  if (!row) throw new Error(`There is no user ${userId}.`);
  return row.timeZone!;
}

// Devices --------------------------------------------------------------------------------------

export type Device = typeof devices.$inferSelect;

/** How many devices a person keeps. Registering past it forgets the one unseen the longest. */
export const MAX_DEVICES_PER_USER = 20;

/**
 * An Expo push token, as `Expo.isExpoPushToken` takes one: what an iPhone registers. Kept as
 * it is, never lowercased.
 */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;

interface RegistrationBase {
  userId: string;
  /** The app's own random id for this install. A device is an install. */
  installId: string;
  name: string | null;
  appVersion: string | null;
}

export type DeviceRegistration =
  | (RegistrationBase & {
      platform: "ios";
      /** Its Expo push token. */
      pushToken: string;
      pushEnvironment: NonNullable<Device["pushEnvironment"]>;
      pingsBlocked: boolean;
    })
  | (RegistrationBase & { platform: "macos" });

export type DeviceRegistered =
  | {
      status: "registered";
      device: Device;
      created: boolean;
      /** Who held the token until now, when it moved from another person. */
      movedFrom?: string;
    }
  /**
   * Another person holds the token from another install of the app, or from one that never
   * said which it was: nothing changed. `holderId` is who holds it. (Also answered, with the
   * person's own id, for a Mac whose install id is already one of their iPhones', or the reverse.)
   */
  | { status: "taken"; holderId: string };

/**
 * Record one of a person's devices, as seen now, and answer it and whether it is new to them.
 * A device is an install: registering from the same install again updates its one row. In
 * the same statement, the person's devices past `MAX_DEVICES_PER_USER` are forgotten, longest
 * unseen first.
 *
 * An iPhone comes with its push token. A token another person registered moves to this person,
 * with pings on, only when the same install registers it (the phone signed in as someone
 * else); otherwise it stays theirs. A new token from an install that had another one replaces
 * it in place (the token changed).
 *
 * A Mac has no token: it is found by its install.
 */
export async function registerDevice(
  db: Db,
  device: DeviceRegistration,
): Promise<DeviceRegistered> {
  for (let attempt = 1; ; attempt++) {
    try {
      return device.platform === "ios"
        ? await registerPhone(db, device)
        : await registerMac(db, device);
    } catch (error) {
      // Two registrations of one install at once (the app at launch, and its token listener)
      // both found nothing and both inserted; one is refused by a key. Its statement, run again,
      // finds the row the other made and updates it.
      const raced =
        error instanceof QueryError &&
        /devices_user_install_key|devices_push_token_unique/.test(error.message);
      if (!raced || attempt >= 3) throw error;
    }
  }
}

async function registerPhone(
  db: Db,
  device: Extract<DeviceRegistration, { platform: "ios" }>,
): Promise<DeviceRegistered> {
  const id = newId("dev");
  // Each branch writes at most one row: the token's own row moves to this install (`moved`),
  // or this install's row takes the new token (`rotated`), or a new row is made (`inserted`).
  // When the token's row moves here and this install also had a row of its own, that row goes
  // first (`dropped`): `moved` reads `dropped`, which makes Postgres finish the delete before
  // the update, so the one-row-per-install key never sees both.
  const result = await queryJson<{
    device: Record<string, unknown> | null;
    priorUserId: string | null;
    created: boolean;
  }>(
    db,
    sql`
      with prior as (
        select id, user_id, install_id from devices where push_token = ${device.pushToken}
         for update
      ),
      mine as (
        select id from devices
         where user_id = ${device.userId} and install_id = ${device.installId}
           and platform = 'ios' and push_token is distinct from ${device.pushToken}
         for update
      ),
      allowed as (
        select not exists (
          select 1 from prior
           where user_id <> ${device.userId} and install_id is distinct from ${device.installId}
        )
        -- An install id the person's Mac already has is not this phone's to take.
        and not exists (
          select 1 from devices
           where user_id = ${device.userId} and install_id = ${device.installId}
             and platform = 'macos'
        ) as ok
      ),
      dropped as (
        delete from devices
         where id in (select id from mine)
           and exists (select 1 from prior) and (select ok from allowed)
        returning id
      ),
      moved as (
        update devices d set
          user_id = ${device.userId},
          push_environment = ${device.pushEnvironment},
          install_id = ${device.installId},
          name = coalesce(${device.name}, d.name),
          app_version = coalesce(${device.appVersion}, d.app_version),
          pings_blocked = ${device.pingsBlocked},
          pings_enabled = d.pings_enabled or d.user_id <> ${device.userId},
          last_seen_at = now()
          from (select count(*) from dropped) as gone
         where d.id = (select id from prior) and (select ok from allowed)
        returning d.*
      ),
      rotated as (
        update devices d set
          push_token = ${device.pushToken},
          push_environment = ${device.pushEnvironment},
          name = coalesce(${device.name}, d.name),
          app_version = coalesce(${device.appVersion}, d.app_version),
          pings_blocked = ${device.pingsBlocked},
          last_seen_at = now()
         where d.id = (select id from mine) and not exists (select 1 from prior)
        returning d.*
      ),
      inserted as (
        insert into devices (id, user_id, platform, push_token, push_environment, install_id,
                             name, app_version, pings_blocked, last_seen_at)
        select ${id}, ${device.userId}, 'ios', ${device.pushToken}, ${device.pushEnvironment},
               ${device.installId}, ${device.name}, ${device.appVersion}, ${device.pingsBlocked},
               now()
         where not exists (select 1 from prior) and not exists (select 1 from mine)
           and (select ok from allowed)
        -- Another registration of the same token got there first: as if it had been here.
        on conflict (push_token) do update set
          user_id = excluded.user_id,
          push_environment = excluded.push_environment,
          install_id = excluded.install_id,
          name = coalesce(excluded.name, devices.name),
          app_version = coalesce(excluded.app_version, devices.app_version),
          pings_blocked = excluded.pings_blocked,
          pings_enabled = devices.pings_enabled or devices.user_id <> excluded.user_id,
          last_seen_at = now()
        where devices.user_id = excluded.user_id or devices.install_id = excluded.install_id
        returning devices.*
      ),
      registered as (
        select * from moved union all select * from rotated union all select * from inserted
      ),
      forgotten as (
        delete from devices
         where id in (
           select id from devices
            where user_id = ${device.userId}
              and exists (select 1 from registered)
              and id <> (select id from registered)
              and id not in (select id from dropped)
            order by last_seen_at desc, id
            offset ${MAX_DEVICES_PER_USER - 1}
         )
      )
      select json_build_object(
        'device', (select row_to_json(r) from registered r),
        'priorUserId', (select user_id from prior),
        'created', exists (select 1 from inserted where id = ${id})
                   or exists (select 1 from prior where user_id <> ${device.userId})
      ) as result
    `,
  );
  const prior = result?.priorUserId ?? null;
  if (!result?.device) return { status: "taken", holderId: prior ?? device.userId };
  return {
    status: "registered",
    device: toDevice(result.device),
    created: result.created,
    ...(prior && prior !== device.userId ? { movedFrom: prior } : {}),
  };
}

async function registerMac(
  db: Db,
  device: Extract<DeviceRegistration, { platform: "macos" }>,
): Promise<DeviceRegistered> {
  const id = newId("dev");
  const result = await queryJson<{ device: Record<string, unknown> | null }>(
    db,
    sql`
      with registered as (
        insert into devices (id, user_id, platform, install_id, name, app_version, last_seen_at)
        values (${id}, ${device.userId}, 'macos', ${device.installId}, ${device.name},
                ${device.appVersion}, now())
        on conflict (user_id, install_id) where install_id is not null do update set
          name = coalesce(excluded.name, devices.name),
          app_version = coalesce(excluded.app_version, devices.app_version),
          last_seen_at = now()
        where devices.platform = 'macos'
        returning devices.*
      ),
      forgotten as (
        delete from devices
         where id in (
           select id from devices
            where user_id = ${device.userId}
              and exists (select 1 from registered)
              and id <> (select id from registered)
            order by last_seen_at desc, id
            offset ${MAX_DEVICES_PER_USER - 1}
         )
      )
      select json_build_object('device', (select row_to_json(r) from registered r)) as result
    `,
  );
  if (!result?.device) return { status: "taken", holderId: device.userId };
  const registered = toDevice(result.device);
  return { status: "registered", device: registered, created: registered.id === id };
}

export interface DeviceChanges {
  pingsEnabled?: boolean;
  pingsBlocked?: boolean;
  name?: string | null;
  pushToken?: string;
  appVersion?: string | null;
}

/**
 * Change one of the person's devices, as seen now. Null when they have no such device. A push
 * token another device already holds throws (`devices_push_token_unique`), and so does a token
 * for a Mac (`devices_push_token_check`).
 */
export async function updateDevice(
  db: Db,
  { userId, id, changes }: { userId: string; id: string; changes: DeviceChanges },
): Promise<Device | null> {
  const [row] = await run(
    db
      .update(devices)
      .set({ ...changes, lastSeenAt: sql`now()` })
      .where(and(eq(devices.id, id), eq(devices.userId, userId)))
      .returning(),
  );
  return row ?? null;
}

/** Forget one of the person's devices: it signed out. False when they have no such device. */
export async function deleteDevice(
  db: Db,
  { userId, id }: { userId: string; id: string },
): Promise<boolean> {
  const deleted = await run(
    db
      .delete(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, userId)))
      .returning({ id: devices.id }),
  );
  return deleted.length > 0;
}

/** Forget devices by id, whoever has them: Expo said their tokens are dead. Answers how many. */
export async function forgetDevices(db: Db, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await run(
    db
      .delete(devices)
      .where(inArray(devices.id, [...ids]))
      .returning({ id: devices.id }),
  );
  return deleted.length;
}

/**
 * Forget iPhones whose push token Expo just said is dead, each only while it still holds the
 * token that was sent to: a phone whose token changed in place since keeps its row and its new
 * token. Answers how many went.
 */
export async function forgetDeadTokens(
  db: Db,
  dead: readonly { id: string; pushToken: string }[],
): Promise<number> {
  if (dead.length === 0) return 0;
  const result = await queryJson<{ count: number }>(
    db,
    sql`
      with gone as (
        delete from devices d
         using json_to_recordset(${JSON.stringify(dead.map((row) => ({ id: row.id, token: row.pushToken })))}::json)
               as u(id text, token text)
         where d.id = u.id and d.push_token = u.token
        returning d.id
      )
      select json_build_object('count', (select count(*) from gone)) as result
    `,
  );
  return Number(result?.count ?? 0);
}

/**
 * Forget iPhones a receipt said are dead, each only if nothing has registered or touched it
 * since `sentAt`, the send the receipt is about: the receipt comes minutes later, and by then
 * the phone may have registered a new token on the same row. One seen since stays; a later
 * send's ticket says plainly whether its token is dead. Answers how many went.
 */
export async function forgetDevicesUnseenSince(
  db: Db,
  dead: readonly { id: string; sentAt: Date }[],
): Promise<number> {
  if (dead.length === 0) return 0;
  const result = await queryJson<{ count: number }>(
    db,
    sql`
      with gone as (
        delete from devices d
         using json_to_recordset(${JSON.stringify(dead.map((row) => ({ id: row.id, sent_at: row.sentAt.toISOString() })))}::json)
               as u(id text, sent_at timestamptz)
         where d.id = u.id and d.last_seen_at <= u.sent_at
        returning d.id
      )
      select json_build_object('count', (select count(*) from gone)) as result
    `,
  );
  return Number(result?.count ?? 0);
}

/** A person's devices, the one seen last first. */
export function listDevices(db: Db, userId: string): Promise<Device[]> {
  return run(
    db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.lastSeenAt), devices.id),
  );
}

/** A heartbeat this soon after the last one is not written. */
export const DEVICE_ACTIVE_WRITE_EVERY_MS = 30_000;

/**
 * Say the person is at one of their devices now: it moves `active_at` and `last_seen_at`.
 * Answers `missing` when they have no such device, and `fresh`, writing nothing, when it was
 * marked active less than `DEVICE_ACTIVE_WRITE_EVERY_MS` ago.
 */
export async function touchDeviceActive(
  db: Db,
  { userId, id, now }: { userId: string; id: string; now: Date },
): Promise<"touched" | "fresh" | "missing"> {
  const result = await queryJson<{ found: boolean; touched: boolean }>(
    db,
    sql`
      with target as (
        select id, active_at from devices where id = ${id} and user_id = ${userId}
      ),
      touched as (
        update devices set active_at = ${at(now)}, last_seen_at = ${at(now)}
         where id = (select id from target)
           and (active_at is null
                or active_at <= ${at(new Date(now.getTime() - DEVICE_ACTIVE_WRITE_EVERY_MS))})
        returning id
      )
      select json_build_object(
        'found', exists (select 1 from target),
        'touched', exists (select 1 from touched)
      ) as result
    `,
  );
  if (!result?.found) return "missing";
  return result.touched ? "touched" : "fresh";
}

/**
 * Forget devices nobody has used in a long while: an iPhone unseen since `iosUnseenBefore`, a
 * Mac unseen since `macUnseenBefore`. Answers how many went.
 */
export async function pruneDevices(
  db: Db,
  { iosUnseenBefore, macUnseenBefore }: { iosUnseenBefore: Date; macUnseenBefore: Date },
): Promise<number> {
  const deleted = await run(
    db
      .delete(devices)
      .where(
        sql`(${devices.platform} = 'ios' and ${devices.lastSeenAt} < ${at(iosUnseenBefore)})
         or (${devices.platform} = 'macos' and ${devices.lastSeenAt} < ${at(macUnseenBefore)})`,
      )
      .returning({ id: devices.id }),
  );
  return deleted.length;
}

/** A row as `row_to_json` writes it, back to what Drizzle would have read. */
function toDevice(json: Record<string, unknown>): Device {
  return {
    id: String(json.id),
    userId: String(json.user_id),
    platform: json.platform as Device["platform"],
    pushToken: (json.push_token as string | null) ?? null,
    pushEnvironment: (json.push_environment as Device["pushEnvironment"]) ?? null,
    installId: (json.install_id as string | null) ?? null,
    name: (json.name as string | null) ?? null,
    appVersion: (json.app_version as string | null) ?? null,
    pingsEnabled: Boolean(json.pings_enabled),
    pingsBlocked: Boolean(json.pings_blocked),
    lastSeenAt: new Date(String(json.last_seen_at)),
    activeAt: json.active_at ? new Date(String(json.active_at)) : null,
    createdAt: new Date(String(json.created_at)),
  };
}

// Notifications --------------------------------------------------------------------------------

export type Notification = typeof notifications.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;

/** One notification to write, for one person. */
export interface NewNotification {
  id?: string;
  userId: string;
  workspaceId: string | null;
  canvasId: string | null;
  kind: NotificationKind;
  dedupeKey: string;
  title: string;
  subtitle?: string | null;
  body: string;
  link: NotificationLink;
  sourceId?: string | null;
  people?: string[];
  muted: boolean;
  /** Read as it is made: the person was looking at the canvas. */
  readVia?: "looking";
}

/**
 * Write notifications, as of `now`, in one statement. One whose person already has its dedupe
 * key is left out, even one written at the same moment by another statement. Answers the rows
 * written.
 */
export async function insertNotifications(
  db: Db,
  { rows, now }: { rows: readonly NewNotification[]; now: Date },
): Promise<Notification[]> {
  if (rows.length === 0) return [];
  return run(
    db
      .insert(notifications)
      .values(
        rows.map((row) => ({
          id: row.id ?? newId("ntf"),
          userId: row.userId,
          workspaceId: row.workspaceId,
          canvasId: row.canvasId,
          kind: row.kind,
          dedupeKey: row.dedupeKey,
          title: row.title,
          subtitle: row.subtitle ?? null,
          body: row.body,
          link: row.link,
          sourceId: row.sourceId ?? null,
          people: row.people ?? [],
          muted: row.muted,
          createdAt: now,
          updatedAt: now,
          readAt: row.readVia ? now : null,
          readVia: row.readVia ?? null,
        })),
      )
      .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
      .returning(),
  );
}

export type Collapsed =
  /** Folded into the person's unread row: it now stands for one thing more. */
  | { status: "collapsed"; notification: Notification }
  /** This comment was already told, as its own row or folded into one. Nothing changed. */
  | { status: "already"; notification: Notification }
  /** No unread row to fold into: write a row of its own. */
  | null;

/**
 * Fold a teammate's comment into the person's unread `teammate_comment` row for the canvas made
 * since `since`, if there is one: its count goes up by one, the commenter's first name joins its
 * people, and its body becomes `bodyFor(people, count)`. The row keeps its id and its place.
 *
 * Each statement is one: the row is read, then changed only if nobody changed it meanwhile, and
 * read again if they did.
 */
export async function collapseCommentNotification(
  db: Db,
  {
    userId,
    canvasId,
    dedupeKey,
    person,
    since,
    now,
    bodyFor,
  }: {
    userId: string;
    canvasId: string;
    /** This comment's own key, `comment:<canvas>:<message>`. */
    dedupeKey: string;
    /** The commenter's first name. */
    person: string;
    since: Date;
    now: Date;
    bodyFor: (people: readonly string[], count: number) => string;
  },
): Promise<Collapsed> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await queryJson<{
      already: Record<string, unknown> | null;
      target: Record<string, unknown> | null;
    }>(
      db,
      sql`
        select json_build_object(
          'already', (select row_to_json(n) from notifications n
                       where n.user_id = ${userId}
                         and (n.dedupe_key = ${dedupeKey} or ${dedupeKey} = any(n.merged_keys))
                       limit 1),
          'target', (select row_to_json(n) from notifications n
                      where n.user_id = ${userId} and n.canvas_id = ${canvasId}
                        and n.kind = 'teammate_comment' and n.read_at is null
                        and n.created_at >= ${at(since)}
                      order by n.created_at desc, n.id desc
                      limit 1)
        ) as result
      `,
    );
    if (found?.already) return { status: "already", notification: toNotification(found.already) };
    if (!found?.target) return null;
    const target = toNotification(found.target);
    const people = target.people.includes(person) ? target.people : [...target.people, person];
    const count = target.count + 1;
    const [changed] = await run(
      db
        .update(notifications)
        .set({
          count,
          people,
          mergedKeys: sql`array_append(${notifications.mergedKeys}, ${dedupeKey})`,
          body: bodyFor(people, count),
          updatedAt: now,
        })
        .where(
          and(
            eq(notifications.id, target.id),
            eq(notifications.count, target.count),
            sql`${notifications.readAt} is null`,
          ),
        )
        .returning(),
    );
    if (changed) return { status: "collapsed", notification: changed };
  }
  throw new Error("A teammate's comment could not be folded in: its row kept changing.");
}

/**
 * Mark a person's unread notifications read, as of `now`, by `via`: the ones named by `ids`, or
 * by `dedupeKeys`, or every one about `canvasId`, or (with none of these) all of them. Only
 * those made by `now` are read, so one made a moment later still shows. Reading again is safe.
 * Answers the ids read.
 */
export async function markNotificationsRead(
  db: Db,
  {
    userId,
    ids,
    dedupeKeys,
    canvasId,
    now,
    via,
  }: {
    userId: string;
    ids?: readonly string[];
    dedupeKeys?: readonly string[];
    canvasId?: string;
    now: Date;
    via: NotificationReadVia;
  },
): Promise<string[]> {
  if (ids && ids.length === 0) return [];
  if (dedupeKeys && dedupeKeys.length === 0) return [];
  const read = await run(
    db
      .update(notifications)
      .set({ readAt: now, readVia: via, updatedAt: now })
      .where(
        and(
          eq(notifications.userId, userId),
          sql`${notifications.readAt} is null`,
          sql`${notifications.createdAt} <= ${at(now)}`,
          ids ? inArray(notifications.id, [...ids]) : undefined,
          dedupeKeys ? inArray(notifications.dedupeKey, [...dedupeKeys]) : undefined,
          canvasId ? eq(notifications.canvasId, canvasId) : undefined,
        ),
      )
      .returning({ id: notifications.id }),
  );
  return read.map((row) => row.id);
}

/**
 * Resolve the needs-you notifications of a canvas's questions that closed (answered, withdrawn,
 * cancelled). Answers the people whose badge went down, each once.
 */
export async function resolveNeedsYou(
  db: Db,
  { canvasId, questionIds, now }: { canvasId: string; questionIds: readonly string[]; now: Date },
): Promise<string[]> {
  if (questionIds.length === 0) return [];
  const resolved = await run(
    db
      .update(notifications)
      .set({ resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.canvasId, canvasId),
          eq(notifications.kind, "needs_you"),
          inArray(notifications.sourceId, [...questionIds]),
          sql`${notifications.resolvedAt} is null`,
        ),
      )
      .returning({ userId: notifications.userId }),
  );
  return [...new Set(resolved.map((row) => row.userId))];
}

/**
 * The sweep behind `resolveNeedsYou`: resolve up to `limit` needs-you notifications whose
 * question is no longer open, or is gone. Answers the people whose badge went down, each once.
 */
export async function resolveClosedQuestions(
  db: Db,
  { now, limit = 500 }: { now: Date; limit?: number },
): Promise<string[]> {
  const resolved = await run(
    db
      .update(notifications)
      .set({ resolvedAt: now, updatedAt: now })
      .where(
        sql`${notifications.id} in (
          select n.id from notifications n
           where n.kind = 'needs_you' and n.resolved_at is null
             and not exists (
               select 1 from questions q
                where q.canvas_id = n.canvas_id and q.id = n.source_id and q.status = 'open'
             )
           limit ${limit}
        )`,
      )
      .returning({ userId: notifications.userId }),
  );
  return [...new Set(resolved.map((row) => row.userId))];
}

/**
 * The number on a person's badge, on the dock and the phone's icon: their open needs-you
 * questions across every workspace, read or not, pinged or muted.
 */
export async function badgeCount(db: Db, userId: string): Promise<number> {
  const result = await queryJson<{ count: number }>(
    db,
    sql`
      select json_build_object('count', count(*)) as result
        from notifications
       where user_id = ${userId} and kind = 'needs_you' and resolved_at is null
    `,
  );
  return Number(result?.count ?? 0);
}

/**
 * The pushes handed to Expo for these people since `since`, by kind and when, for the hourly
 * limit. A send whose answer was lost counts: it may have gone.
 */
export async function recentPushes(
  db: Db,
  { userIds, since }: { userIds: readonly string[]; since: Date },
): Promise<{ userId: string; kind: NotificationKind; at: Date }[]> {
  if (userIds.length === 0) return [];
  const rows = await run(
    db
      .select({
        userId: notifications.userId,
        kind: notifications.kind,
        at: notificationDeliveries.sentAt,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(
        and(
          inArray(notifications.userId, [...userIds]),
          sql`${notificationDeliveries.sentAt} > ${at(since)}`,
        ),
      )
      .orderBy(notificationDeliveries.sentAt),
  );
  return rows.map((row) => ({ ...row, at: row.at! }));
}

/**
 * A person's notifications made since `since` that they have not read, or that were muted, for
 * the daily email: by canvas (the ones about none last), oldest first within each.
 */
export function listRecentForDigest(
  db: Db,
  { userId, since }: { userId: string; since: Date },
): Promise<Notification[]> {
  return run(
    db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          sql`${notifications.createdAt} >= ${at(since)}`,
          sql`(${notifications.readAt} is null or ${notifications.muted})`,
        ),
      )
      .orderBy(
        sql`${notifications.canvasId} nulls last`,
        notifications.createdAt,
        notifications.id,
      ),
  );
}

/** How long an unread notification stays in the inbox before the sweep reads it as `expired`. */
export const NOTIFICATION_EXPIRES_MS = 3 * 24 * 60 * 60_000;
/** How long a notification is kept at all. */
export const NOTIFICATION_KEPT_MS = 30 * 24 * 60 * 60_000;

/**
 * The sweep, as of `now`, up to `limit` rows each way: unread notifications made before
 * `expireBefore` are read as `expired`, and notifications made before `deleteBefore` are
 * deleted, with their deliveries. A needs-you whose question is still open is never deleted.
 * Answers how many of each.
 */
export async function pruneNotifications(
  db: Db,
  {
    now,
    expireBefore,
    deleteBefore,
    limit = 1000,
  }: { now: Date; expireBefore: Date; deleteBefore: Date; limit?: number },
): Promise<{ expired: number; deleted: number }> {
  const result = await queryJson<{ expired: number; deleted: number }>(
    db,
    sql`
      with expired as (
        update notifications set read_at = ${at(now)}, read_via = 'expired', updated_at = ${at(now)}
         where id in (
           select id from notifications
            where read_at is null
              and created_at < ${at(expireBefore)}
              -- Not one the delete below may take: one statement changes a row once.
              and (created_at >= ${at(deleteBefore)} or (kind = 'needs_you' and resolved_at is null))
            limit ${limit}
         )
        returning id
      ),
      deleted as (
        delete from notifications
         where id in (
           select id from notifications
            where created_at < ${at(deleteBefore)}
              and not (kind = 'needs_you' and resolved_at is null)
            limit ${limit}
         )
        returning id
      )
      select json_build_object(
        'expired', (select count(*) from expired),
        'deleted', (select count(*) from deleted)
      ) as result
    `,
  );
  return { expired: Number(result?.expired ?? 0), deleted: Number(result?.deleted ?? 0) };
}

/** A notification as `row_to_json` writes it, back to what Drizzle would have read. */
function toNotification(json: Record<string, unknown>): Notification {
  const time = (value: unknown) => (value ? new Date(String(value)) : null);
  return {
    id: String(json.id),
    userId: String(json.user_id),
    workspaceId: (json.workspace_id as string | null) ?? null,
    canvasId: (json.canvas_id as string | null) ?? null,
    kind: json.kind as NotificationKind,
    dedupeKey: String(json.dedupe_key),
    title: String(json.title),
    subtitle: (json.subtitle as string | null) ?? null,
    body: String(json.body),
    link: json.link as NotificationLink,
    sourceId: (json.source_id as string | null) ?? null,
    count: Number(json.count),
    people: (json.people as string[]) ?? [],
    mergedKeys: (json.merged_keys as string[]) ?? [],
    muted: Boolean(json.muted),
    createdAt: new Date(String(json.created_at)),
    updatedAt: new Date(String(json.updated_at)),
    readAt: time(json.read_at),
    readVia: (json.read_via as NotificationReadVia | null) ?? null,
    resolvedAt: time(json.resolved_at),
  };
}

// Deliveries -----------------------------------------------------------------------------------

/**
 * Plan pushes, one per notification and iPhone. One already planned for that pair is left as
 * it is. Answers the rows written.
 */
export async function insertDeliveries(
  db: Db,
  {
    rows,
    now,
  }: { rows: readonly { notificationId: string; deviceId: string; sendAt: Date }[]; now: Date },
): Promise<NotificationDelivery[]> {
  if (rows.length === 0) return [];
  return run(
    db
      .insert(notificationDeliveries)
      .values(
        rows.map((row) => ({
          id: newId("ndl"),
          notificationId: row.notificationId,
          deviceId: row.deviceId,
          sendAt: row.sendAt,
          createdAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [notificationDeliveries.notificationId, notificationDeliveries.deviceId],
      })
      .returning(),
  );
}

/** A delivery due to go, with what sending it needs to check. */
export interface DueDelivery {
  id: string;
  sendAt: Date;
  attempts: number;
  /**
   * The iPhone, or null when it was forgotten or now belongs to someone else (the phone signed
   * in as another person since the push was planned). Either way it is not sent.
   */
  device: {
    id: string;
    userId: string;
    platform: Device["platform"];
    pushToken: string | null;
    pingsEnabled: boolean;
    pingsBlocked: boolean;
    lastSeenAt: Date;
    activeAt: Date | null;
  } | null;
}

/**
 * A notification's waiting deliveries due by `now`, and when the next one still waiting after
 * that is due (null when none is).
 */
export async function dueDeliveries(
  db: Db,
  { notificationId, now }: { notificationId: string; now: Date },
): Promise<{ due: DueDelivery[]; nextSendAt: Date | null }> {
  const result = await queryJson<{
    due: {
      id: string;
      send_at: string;
      attempts: number;
      device: {
        id: string;
        user_id: string;
        platform: Device["platform"];
        push_token: string | null;
        pings_enabled: boolean;
        pings_blocked: boolean;
        last_seen_at: string;
        active_at: string | null;
      } | null;
    }[];
    next: string | null;
  }>(
    db,
    sql`
      select json_build_object(
        'due', coalesce((
          select json_agg(json_build_object(
                   'id', d.id, 'send_at', d.send_at, 'attempts', d.attempts,
                   'device', case when v.id is null then null else json_build_object(
                     'id', v.id, 'user_id', v.user_id, 'platform', v.platform,
                     'push_token', v.push_token, 'pings_enabled', v.pings_enabled,
                     'pings_blocked', v.pings_blocked, 'last_seen_at', v.last_seen_at,
                     'active_at', v.active_at
                   ) end
                 ) order by d.send_at, d.id)
            from notification_deliveries d
            join notifications n on n.id = d.notification_id
            -- A phone that moved to another person (signed in as them) since this was planned
            -- is not this person's any more: it counts as gone.
            left join devices v on v.id = d.device_id and v.user_id = n.user_id
           where d.notification_id = ${notificationId} and d.state = 'waiting'
             and d.send_at <= ${at(now)}
        ), '[]'::json),
        'next', (
          select min(send_at) from notification_deliveries
           where notification_id = ${notificationId} and state = 'waiting'
             and send_at > ${at(now)}
        )
      ) as result
    `,
  );
  return {
    due: (result?.due ?? []).map((row) => ({
      id: row.id,
      sendAt: new Date(row.send_at),
      attempts: Number(row.attempts),
      device: row.device
        ? {
            id: row.device.id,
            userId: row.device.user_id,
            platform: row.device.platform,
            pushToken: row.device.push_token,
            pingsEnabled: row.device.pings_enabled,
            pingsBlocked: row.device.pings_blocked,
            lastSeenAt: new Date(row.device.last_seen_at),
            activeAt: row.device.active_at ? new Date(row.device.active_at) : null,
          }
        : null,
    })),
    nextSendAt: result?.next ? new Date(result.next) : null,
  };
}

/** One delivery's move to a new state. */
export type DeliveryUpdate =
  /** About to be handed to Expo, at `sentAt`. Only from waiting; it counts an attempt. */
  | { id: string; state: "sending"; sentAt: Date }
  /**
   * Back to wait for `sendAt`, only from sending: Expo said plainly that it took nothing (a 429,
   * or the request never left), so it may go again. Never for a timeout or a 5xx, whose send may
   * have been taken; those stay sending until `settleLostSends`. Its attempt still counts.
   */
  | { id: string; state: "waiting"; sendAt: Date }
  /** Expo took it and gave `ticketId`. From waiting or sending. */
  | { id: string; state: "sent"; sentAt: Date; ticketId: string }
  /** Not sent, and why. Only from waiting. */
  | { id: string; state: "cancelled"; outcome: string }
  /** Refused, with Expo's code. From waiting, sending or sent; `receiptCheckedAt` if by receipt. */
  | { id: string; state: "failed"; outcome: string; receiptCheckedAt?: Date }
  /** Its receipt says Apple took it. Only from sent. */
  | { id: string; state: "delivered"; receiptCheckedAt: Date }
  /** No answer or receipt came in time. From sending or sent. */
  | { id: string; state: "unknown"; outcome?: string; receiptCheckedAt: Date };

/** The states each new state may be reached from. A settled delivery never moves again. */
const MOVES_FROM: Record<DeliveryState, readonly DeliveryState[]> = {
  waiting: ["sending"],
  sending: ["waiting"],
  sent: ["waiting", "sending"],
  cancelled: ["waiting"],
  failed: ["waiting", "sending", "sent"],
  delivered: ["sent"],
  unknown: ["sending", "sent"],
};

/**
 * Move deliveries to new states in one statement. A move from a state it may not come from is
 * left out (a delivery sent once is never marked to send again, and a settled one never moves).
 * Answers the ids moved.
 */
export async function markDeliveries(
  db: Db,
  updates: readonly DeliveryUpdate[],
): Promise<string[]> {
  if (updates.length === 0) return [];
  const rows = updates.map((update) => ({
    id: update.id,
    state: update.state,
    from: MOVES_FROM[update.state],
    sent_at: "sentAt" in update ? update.sentAt.toISOString() : null,
    send_at: "sendAt" in update ? update.sendAt.toISOString() : null,
    ticket_id: "ticketId" in update ? update.ticketId : null,
    outcome: "outcome" in update ? (update.outcome ?? null) : null,
    receipt_checked_at:
      "receiptCheckedAt" in update && update.receiptCheckedAt
        ? update.receiptCheckedAt.toISOString()
        : null,
  }));
  const moved = await queryJson<{ ids: string[] | null }>(
    db,
    sql`
      with moved as (
        update notification_deliveries d set
          state = u.state,
          -- One back to waiting was not sent: it leaves the hourly count until it goes.
          sent_at = case when u.state = 'waiting' then null else coalesce(u.sent_at, d.sent_at) end,
          send_at = coalesce(u.send_at, d.send_at),
          ticket_id = coalesce(u.ticket_id, d.ticket_id),
          outcome = coalesce(u.outcome, d.outcome),
          receipt_checked_at = coalesce(u.receipt_checked_at, d.receipt_checked_at),
          attempts = d.attempts + case when u.state = 'sending' then 1 else 0 end
          from json_to_recordset(${JSON.stringify(rows)}::json) as u(
            id text, state text, "from" text[], sent_at timestamptz, send_at timestamptz, ticket_id text,
            outcome text, receipt_checked_at timestamptz
          )
         where d.id = u.id and d.state = any(u."from")
        returning d.id
      )
      select json_build_object('ids', (select json_agg(id) from moved)) as result
    `,
  );
  return moved?.ids ?? [];
}

/**
 * Up to `limit` sent deliveries whose receipt is to read: sent at or before `before`, and not
 * read yet. Oldest first.
 */
export async function receiptsDue(
  db: Db,
  { before, limit = 1000 }: { before: Date; limit?: number },
): Promise<
  {
    id: string;
    notificationId: string;
    deviceId: string | null;
    ticketId: string;
    sentAt: Date;
    kind: NotificationKind;
  }[]
> {
  const rows = await run(
    db
      .select({
        id: notificationDeliveries.id,
        notificationId: notificationDeliveries.notificationId,
        deviceId: notificationDeliveries.deviceId,
        ticketId: notificationDeliveries.ticketId,
        sentAt: notificationDeliveries.sentAt,
        kind: notifications.kind,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(
        and(
          eq(notificationDeliveries.state, "sent"),
          sql`${notificationDeliveries.receiptCheckedAt} is null`,
          sql`${notificationDeliveries.sentAt} <= ${at(before)}`,
        ),
      )
      .orderBy(notificationDeliveries.sentAt, notificationDeliveries.id)
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, ticketId: row.ticketId!, sentAt: row.sentAt! }));
}

/**
 * Settle sends whose answer was lost: deliveries handed to Expo at or before `before` that never
 * came back as sent or failed. They may have gone, so they are not sent again; they are marked
 * `unknown`, as of `now`. Answers how many.
 */
export async function settleLostSends(
  db: Db,
  { before, now }: { before: Date; now: Date },
): Promise<number> {
  const settled = await run(
    db
      .update(notificationDeliveries)
      .set({ state: "unknown", outcome: "no_answer", receiptCheckedAt: now })
      .where(
        and(
          eq(notificationDeliveries.state, "sending"),
          sql`${notificationDeliveries.sentAt} <= ${at(before)}`,
        ),
      )
      .returning({ id: notificationDeliveries.id }),
  );
  return settled.length;
}

// What the pipeline reads ---------------------------------------------------------------------

/** One notification by its id, or null. */
export async function getNotification(db: Db, id: string): Promise<Notification | null> {
  const [row] = await run(db.select().from(notifications).where(eq(notifications.id, id)));
  return row ?? null;
}

/** Notifications by id, whoever's: for a job that made them and is run again. */
export function listNotificationsByIds(db: Db, ids: readonly string[]): Promise<Notification[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return run(
    db
      .select()
      .from(notifications)
      .where(inArray(notifications.id, [...ids])),
  );
}

/**
 * Plan pushes again for notifications that changed after they were pushed: a teammate's comment
 * folded into a row someone was already pinged about. One per notification and iPhone: a new
 * pair is written, and one already settled (sent, delivered, failed, cancelled, unknown) waits
 * again for `sendAt`, its earlier send forgotten. One still waiting or being sent is left as it
 * is: it goes with the row's new words when it goes. Answers the ids that now wait.
 */
export async function repushDeliveries(
  db: Db,
  {
    rows,
    now,
  }: { rows: readonly { notificationId: string; deviceId: string; sendAt: Date }[]; now: Date },
): Promise<string[]> {
  if (rows.length === 0) return [];
  const changed = await run(
    db
      .insert(notificationDeliveries)
      .values(
        rows.map((row) => ({
          id: newId("ndl"),
          notificationId: row.notificationId,
          deviceId: row.deviceId,
          sendAt: row.sendAt,
          createdAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [notificationDeliveries.notificationId, notificationDeliveries.deviceId],
        set: {
          state: "waiting",
          sendAt: sql`excluded.send_at`,
          sentAt: null,
          ticketId: null,
          receiptCheckedAt: null,
          outcome: null,
        },
        setWhere: sql`${notificationDeliveries.state} not in ('waiting', 'sending')`,
      })
      .returning({ id: notificationDeliveries.id }),
  );
  return changed.map((row) => row.id);
}

/**
 * When each of these people was last told `kind` about a canvas: for a kind that pings at most
 * so often (a pull request ready). Someone never told is left out.
 */
export async function lastNotifiedAt(
  db: Db,
  {
    canvasId,
    kind,
    userIds,
    exceptDedupeKey,
  }: {
    canvasId: string;
    kind: NotificationKind;
    userIds: string[];
    /** Leave out rows with this key: the one being told now, written by an earlier attempt. */
    exceptDedupeKey?: string;
  },
): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await run(
    db
      .select({ userId: notifications.userId, at: sql<string>`max(${notifications.createdAt})` })
      .from(notifications)
      .where(
        and(
          eq(notifications.canvasId, canvasId),
          eq(notifications.kind, kind),
          inArray(notifications.userId, userIds),
          exceptDedupeKey ? sql`${notifications.dedupeKey} <> ${exceptDedupeKey}` : undefined,
        ),
      )
      .groupBy(notifications.userId),
  );
  return new Map(rows.map((row) => [row.userId, new Date(row.at)]));
}

/** What a billing ping about a workspace needs: its name, its kind, its period and its members. */
export interface NotifyWorkspaceFacts {
  id: string;
  name: string;
  kind: WorkspaceKind;
  billingPeriodAnchor: Date;
  members: { userId: string; role: MemberRole }[];
}

/** A workspace's facts for a billing ping, or null when there is no such workspace. */
export async function notifyWorkspaceFacts(
  db: Db,
  workspaceId: string,
): Promise<NotifyWorkspaceFacts | null> {
  const [workspace] = await run(
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        billingPeriodAnchor: workspaces.billingPeriodAnchor,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  );
  if (!workspace) return null;
  const members = await run(
    db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(memberships.userId),
  );
  return { ...workspace, members };
}

/** One member of a canvas's workspace, and the kept answer for the canvas's repo. */
export interface NotifyPerson {
  userId: string;
  /** Their GitHub login, to match a pull request's author or reviewer to them. */
  login: string;
  /** `users.name`, for the most of them a ping may say (a first name). */
  name: string | null;
  role: MemberRole;
  /** The kept `repo_access` answer for the canvas's repo, or null when there is none (or no repo). */
  permission: RepoPermission | null;
  checkedAt: Date | null;
}

/** What choosing who hears about a canvas needs, read in one statement. */
export interface NotifyCanvasFacts {
  id: string;
  workspaceId: string;
  repoId: string | null;
  ownerId: string | null;
  name: string;
  /** Whose Claude account the canvas runs on, if it names one. */
  claudeAccountId: string | null;
  claudeUserId: string | null;
  /** The event asked about, when it is the canvas's. */
  event: { kind: string; userId: string | null } | null;
  /** The person behind the newest delivered message, answer or comment: who is driving it. */
  driverId: string | null;
  /**
   * The person behind the newest message, answer or comment, delivered or not: whose words wait
   * when a wake gives up before any runner took them.
   */
  waitingFor: string | null;
  /** How many of its questions are open. */
  openQuestions: number;
  /** Everyone who has opened it (a `canvas_reads` row). */
  openedBy: string[];
  /** Every member of its workspace, with their kept answer for its repo. */
  people: NotifyPerson[];
}

/**
 * The facts about a canvas that the `notify` job and a delivery's access check read: the canvas,
 * the event a turn began with (`eventId`), who is driving it, its open questions, who has opened
 * it, and its workspace's members with their kept answers for its repo. Null when there is no
 * such canvas.
 */
export async function notifyCanvasFacts(
  db: Db,
  { canvasId, eventId = null }: { canvasId: string; eventId?: string | null },
): Promise<NotifyCanvasFacts | null> {
  const result = await queryJson<{
    canvas: {
      id: string;
      workspace_id: string;
      repo_id: string | null;
      owner_id: string | null;
      name: string;
      claude_account_id: string | null;
      claude_user_id: string | null;
    } | null;
    event: { kind: string; user_id: string | null } | null;
    driver_id: string | null;
    waiting_for: string | null;
    open_questions: number;
    opened_by: string[];
    people: {
      user_id: string;
      login: string;
      name: string | null;
      role: NotifyPerson["role"];
      permission: NotifyPerson["permission"];
      checked_at: string | null;
    }[];
  }>(
    db,
    sql`
      select json_build_object(
        'canvas', (
          select json_build_object(
                   'id', c.id, 'workspace_id', c.workspace_id, 'repo_id', c.repo_id,
                   'owner_id', c.owner_id, 'name', c.name,
                   'claude_account_id', c.claude_account_id, 'claude_user_id', ca.user_id)
            from canvases c left join claude_accounts ca on ca.id = c.claude_account_id
           where c.id = ${canvasId}
        ),
        'event', (
          select json_build_object('kind', e.kind, 'user_id', e.user_id)
            from events e where e.canvas_id = ${canvasId} and e.id = ${eventId}::text
        ),
        'driver_id', (
          select e.user_id from events e
           where e.canvas_id = ${canvasId} and e.kind in ('message', 'answer', 'comment')
             and e.delivered_at is not null and e.user_id is not null
           order by e.seq desc limit 1
        ),
        'waiting_for', (
          select e.user_id from events e
           where e.canvas_id = ${canvasId} and e.kind in ('message', 'answer', 'comment')
             and e.user_id is not null
           order by e.seq desc limit 1
        ),
        'open_questions', (
          select count(*) from questions where canvas_id = ${canvasId} and status = 'open'
        ),
        'opened_by', coalesce((
          select json_agg(r.user_id) from canvas_reads r where r.canvas_id = ${canvasId}
        ), '[]'::json),
        'people', coalesce((
          select json_agg(json_build_object(
                   'user_id', m.user_id, 'login', u.github_login, 'name', u.name, 'role', m.role,
                   'permission', ra.permission, 'checked_at', ra.checked_at))
            from canvases c
            join memberships m on m.workspace_id = c.workspace_id
            join users u on u.id = m.user_id
            left join repo_access ra on ra.user_id = m.user_id and ra.repo_id = c.repo_id
           where c.id = ${canvasId}
        ), '[]'::json)
      ) as result
    `,
  );
  const canvas = result?.canvas;
  if (!result || !canvas) return null;
  return {
    id: canvas.id,
    workspaceId: canvas.workspace_id,
    repoId: canvas.repo_id,
    ownerId: canvas.owner_id,
    name: canvas.name,
    claudeAccountId: canvas.claude_account_id,
    claudeUserId: canvas.claude_user_id,
    event: result.event ? { kind: result.event.kind, userId: result.event.user_id } : null,
    driverId: result.driver_id,
    waitingFor: result.waiting_for,
    openQuestions: Number(result.open_questions),
    openedBy: result.opened_by,
    people: result.people.map((person) => ({
      userId: person.user_id,
      login: person.login,
      name: person.name,
      role: person.role,
      permission: person.permission,
      checkedAt: person.checked_at ? new Date(person.checked_at) : null,
    })),
  };
}

/** A person a notification may go to: their toggles and their devices. */
export interface NotifyRecipient {
  userId: string;
  prefs: PingPrefs;
  devices: Device[];
}

/** The people among `userIds` who exist, with their toggles and devices. */
export async function listNotifyRecipients(
  db: Db,
  userIds: readonly string[],
): Promise<NotifyRecipient[]> {
  if (userIds.length === 0) return [];
  const [people, owned] = await Promise.all([
    run(
      db
        .select()
        .from(users)
        .where(inArray(users.id, [...userIds])),
    ),
    run(
      db
        .select()
        .from(devices)
        .where(inArray(devices.userId, [...userIds])),
    ),
  ]);
  return people.map((user) => ({
    userId: user.id,
    prefs: pingPrefsOf(user),
    devices: owned.filter((device) => device.userId === user.id),
  }));
}
