import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { devices } from "../schema/index.ts";
import type { User } from "./accounts.ts";
import { queryJson } from "./json.ts";
import { run } from "./run.ts";

/*
 * What pings a person and where (docs/cloud.md, "Notifications"): the toggles of Settings ›
 * Notifications, which live on their row, and the phones that registered a push token. Nothing
 * sends pushes yet; these are what sending will read.
 */

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

export type Device = typeof devices.$inferSelect;

/** How many devices a person keeps. Registering past it forgets the one unseen the longest. */
export const MAX_DEVICES_PER_USER = 20;

export interface DeviceRegistration {
  userId: string;
  platform: Device["platform"];
  pushToken: string;
  pushEnvironment: Device["pushEnvironment"];
  name: string | null;
  appVersion: string | null;
  pingsBlocked: boolean;
}

/**
 * Record a device's push token for a person, as seen now. A token is one install of the app on
 * one phone, so registering one another person registered moves it to this person (the phone
 * signed in as someone else) with pings on, and registering it again updates it in place.
 * Answers the device and whether it is new to this person. In the same statement, the person's
 * devices past `MAX_DEVICES_PER_USER` are forgotten, longest unseen first.
 */
export async function registerDevice(
  db: Db,
  device: DeviceRegistration,
): Promise<{ device: Device; created: boolean }> {
  const result = await queryJson<{ device: Record<string, unknown>; created: boolean }>(
    db,
    sql`
      with prior as (
        select user_id from devices where push_token = ${device.pushToken}
      ),
      registered as (
        insert into devices (id, user_id, platform, push_token, push_environment, name,
                             app_version, pings_blocked, last_seen_at)
        values (${newId("dev")}, ${device.userId}, ${device.platform}, ${device.pushToken},
                ${device.pushEnvironment}, ${device.name}, ${device.appVersion},
                ${device.pingsBlocked}, now())
        on conflict (push_token) do update set
          user_id = excluded.user_id,
          platform = excluded.platform,
          push_environment = excluded.push_environment,
          name = coalesce(excluded.name, devices.name),
          app_version = coalesce(excluded.app_version, devices.app_version),
          pings_blocked = excluded.pings_blocked,
          pings_enabled = devices.pings_enabled or devices.user_id <> excluded.user_id,
          last_seen_at = now()
        returning devices.*
      ),
      forgotten as (
        delete from devices
         where id in (
           select id from devices
            where user_id = ${device.userId} and id <> (select id from registered)
            order by last_seen_at desc, id
            offset ${MAX_DEVICES_PER_USER - 1}
         )
      )
      select json_build_object(
        'device', (select row_to_json(r) from registered r),
        'created', not exists (select 1 from prior where user_id = ${device.userId})
      ) as result
    `,
  );
  return { device: toDevice(result!.device), created: result!.created };
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
 * token another device already holds throws (`devices_push_token_unique`).
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

/** A row as `row_to_json` writes it, back to what Drizzle would have read. */
function toDevice(json: Record<string, unknown>): Device {
  return {
    id: String(json.id),
    userId: String(json.user_id),
    platform: json.platform as Device["platform"],
    pushToken: String(json.push_token),
    pushEnvironment: json.push_environment as Device["pushEnvironment"],
    name: (json.name as string | null) ?? null,
    appVersion: (json.app_version as string | null) ?? null,
    pingsEnabled: Boolean(json.pings_enabled),
    pingsBlocked: Boolean(json.pings_blocked),
    lastSeenAt: new Date(String(json.last_seen_at)),
    createdAt: new Date(String(json.created_at)),
  };
}
