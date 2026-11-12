import { createHash } from "node:crypto";
import type { Device, Notification, NotifyCanvasFacts, PingPrefs } from "@ponzu/db";
import { KIND_TOGGLE, type NotificationKind } from "./kinds.ts";
import type { PushNotification } from "./payload.ts";
import type { DeviceFacts } from "./plan.ts";
import type { CanvasFacts } from "./recipients.ts";

/*
 * The database's rows, as the pure rules (plan.ts, recipients.ts, payload.ts) take them.
 */

/** A canvas's facts as `recipients.ts` reads them. A canvas whose owner is gone has none. */
export function canvasFactsOf(facts: NotifyCanvasFacts): CanvasFacts {
  return {
    ownerId: facts.ownerId ?? "",
    scratch: facts.repoId === null,
    people: new Map(
      facts.people.map((person) => [
        person.userId,
        {
          userId: person.userId,
          member: true,
          permission: person.permission,
          checkedAt: person.checkedAt,
        },
      ]),
    ),
  };
}

/** One device as `plan.ts` reads it. */
export function deviceFactsOf(
  device: Pick<
    Device,
    "id" | "platform" | "pingsEnabled" | "pingsBlocked" | "pushToken" | "lastSeenAt" | "activeAt"
  >,
): DeviceFacts {
  return {
    id: device.id,
    platform: device.platform,
    pingsEnabled: device.pingsEnabled,
    pingsBlocked: device.pingsBlocked,
    hasToken: device.pushToken !== null,
    lastSeenAt: device.lastSeenAt,
    activeAt: device.activeAt,
  };
}

/** Whether the person's toggle for `kind` is on; the kinds that are always on always are. */
export function toggleOn(kind: NotificationKind, prefs: PingPrefs): boolean {
  const toggle = KIND_TOGGLE[kind];
  return toggle === null || prefs[toggle];
}

/** A notification row as its push is built from it. */
export function pushNotificationOf(row: Notification): PushNotification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    canvasId: row.canvasId,
    workspaceId: row.workspaceId,
    link: row.link,
  };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * The id the `notify` job `jobId` gives the notification it makes for one person and dedupe
 * key: the same on every attempt of that job, so an attempt run again after the row was
 * written knows the row as its own and plans its pushes, and a row some other job made is never
 * pushed twice. It has the shape `newId("ntf")` makes.
 */
export function notificationIdFor(jobId: string, userId: string, dedupeKey: string): string {
  const digest = createHash("sha256").update(`${jobId}\n${userId}\n${dedupeKey}`).digest();
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ALPHABET[digest[i]! & 31];
  return `ntf_${tail}`;
}
