import { KIND_TOGGLE, type NotificationKind, RATE_EXEMPT_KINDS } from "./kinds.ts";

/*
 * The quiet rules, in one place (docs/cloud.md, "Notifications"). Pure: the job reads the facts,
 * these answer what to do with them.
 *
 * 1. Never the actor (recipients.ts).
 * 2. Never what you are looking at: a focused presence on the canvas within `LOOKING_MS` marks
 *    the notification read (`looking`) and sends nothing.
 * 3. At a Mac now (a Mac of theirs active within `MAC_ACTIVE_MS`): the Mac shows it at once, and
 *    the phone waits `MAC_DEFER_MS`, cancelled if it is read meanwhile.
 * 4. Toggle off: the inbox row only (`muted`), no banner and no push.
 * 5. At most `PUSHES_PER_HOUR` pushes to a person in any hour, needs-you and billing aside
 *    (they neither count nor wait). Past that, the Mac only.
 * 6. A teammate's comments collapse per canvas within `COMMENT_COLLAPSE_MS`. A pull request is
 *    ready at most once per canvas per person per `PR_READY_EVERY_MS`.
 * 7. A push more than `STALE_MS` late is not sent; Expo and Apple keep one `PUSH_TTL_S` at most.
 * 8. No quiet hours of Ponzu's own: iOS and macOS Focus do that.
 *
 * Every "within" includes its edge: a presence focused exactly 75 seconds ago is still looking,
 * a Mac active exactly 120 seconds ago is still in use, and a phone seen exactly 90 days ago
 * still gets pings. "In the past hour" and "per 30 minutes" are windows of that length that end
 * now and do not include their start: a push sent exactly an hour ago no longer counts, and a
 * pull request ready exactly 30 minutes after the last ping pings again. "More than 30 minutes
 * late" is strict: a push exactly 30 minutes old still goes.
 */

export const LOOKING_MS = 75_000;
export const MAC_ACTIVE_MS = 120_000;
export const MAC_DEFER_MS = 120_000;
export const PUSHES_PER_HOUR = 20;
export const HOUR_MS = 60 * 60_000;
export const DEVICE_FRESH_MS = 90 * 24 * HOUR_MS;
export const STALE_MS = 30 * 60_000;
export const COMMENT_COLLAPSE_MS = 10 * 60_000;
export const PR_READY_EVERY_MS = 30 * 60_000;
export const PUSH_TTL_S = 3600;

/** One of the person's devices, as `devices` keeps it. */
export interface DeviceFacts {
  id: string;
  platform: "ios" | "macos";
  pingsEnabled: boolean;
  pingsBlocked: boolean;
  hasToken: boolean;
  lastSeenAt: Date;
  /** When this install last had the person at it, or null. */
  activeAt: Date | null;
}

/** What is known when a notification for one person is planned. */
export interface PlanFacts {
  kind: NotificationKind;
  /** The person's toggle for the kind; ignored for the kinds that are always on. */
  toggleOn: boolean;
  /** When their presence on this canvas was last focused, or null (or no canvas). */
  focusedAt: Date | null;
  /** The pushes sent to them lately, by kind and when. */
  recentPushes: readonly { kind: NotificationKind; at: Date }[];
  devices: readonly DeviceFacts[];
}

export type Suppressed = "pref_off" | "looking" | "rate" | "no_device";

export interface DeliveryPlan {
  muted: boolean;
  readNow: "looking" | null;
  pushes: { deviceId: string; sendAt: Date }[];
  suppressed: Suppressed | null;
}

const ago = (now: Date, at: Date) => now.getTime() - at.getTime();

/** Whether a focused presence at `focusedAt` means the person is looking now. */
export function isLooking(focusedAt: Date | null, now: Date): boolean {
  return focusedAt !== null && ago(now, focusedAt) <= LOOKING_MS;
}

/** Whether a Mac active at `activeAt` has the person at it now. */
export function isAtMac(device: DeviceFacts, now: Date): boolean {
  return (
    device.platform === "macos" &&
    device.activeAt !== null &&
    ago(now, device.activeAt) <= MAC_ACTIVE_MS
  );
}

/** Whether a phone takes pings: on, not blocked by iOS, with a token, seen within 90 days. */
export function takesPings(device: DeviceFacts, now: Date): boolean {
  return (
    device.platform === "ios" &&
    device.pingsEnabled &&
    !device.pingsBlocked &&
    device.hasToken &&
    ago(now, device.lastSeenAt) <= DEVICE_FRESH_MS
  );
}

/** How many pushes the hourly limit counts now: those of kinds it does not exempt. */
export function pushesThisHour(recent: PlanFacts["recentPushes"], now: Date): number {
  return recent.filter((push) => !RATE_EXEMPT_KINDS.has(push.kind) && ago(now, push.at) < HOUR_MS)
    .length;
}

/** What to do with one person's notification: muted or not, read at once, and which pushes. */
export function planDelivery(facts: PlanFacts, now: Date): DeliveryPlan {
  const alwaysOn = KIND_TOGGLE[facts.kind] === null;
  if (!alwaysOn && !facts.toggleOn) {
    return { muted: true, readNow: null, pushes: [], suppressed: "pref_off" };
  }
  if (isLooking(facts.focusedAt, now)) {
    return { muted: false, readNow: "looking", pushes: [], suppressed: "looking" };
  }
  if (
    !RATE_EXEMPT_KINDS.has(facts.kind) &&
    pushesThisHour(facts.recentPushes, now) >= PUSHES_PER_HOUR
  ) {
    return { muted: false, readNow: null, pushes: [], suppressed: "rate" };
  }
  const phones = facts.devices.filter((device) => takesPings(device, now));
  if (phones.length === 0) {
    return { muted: false, readNow: null, pushes: [], suppressed: "no_device" };
  }
  const atMac = facts.devices.some((device) => isAtMac(device, now));
  const sendAt = new Date(now.getTime() + (atMac ? MAC_DEFER_MS : 0));
  return {
    muted: false,
    readNow: null,
    pushes: phones.map((device) => ({ deviceId: device.id, sendAt })),
    suppressed: null,
  };
}

/** Why a waiting push is not sent after all, or null to send it. */
export type CancelReason =
  | "read"
  | "resolved"
  | "pref_off"
  | "device_off"
  | "access"
  | "stale"
  | "push_off";

/** Whether a notification made at `createdAt` is too late to push now. */
export function isStale(createdAt: Date, now: Date): boolean {
  return ago(now, createdAt) > STALE_MS;
}

/**
 * At send time, whether a waiting push still goes. The first that holds wins, in this order:
 * pushing is off, the notification was read, a needs-you was resolved, the toggle was turned
 * off, the phone is gone, off or blocked, the person can no longer read the canvas, or it is
 * more than `STALE_MS` late.
 */
export function cancelReason(
  facts: {
    pushEnabled: boolean;
    kind: NotificationKind;
    createdAt: Date;
    readAt: Date | null;
    resolvedAt: Date | null;
    toggleOn: boolean;
    /** The phone as it is now, or null when it is gone. */
    device: DeviceFacts | null;
    canRead: boolean;
  },
  now: Date,
): CancelReason | null {
  if (!facts.pushEnabled) return "push_off";
  if (facts.readAt !== null) return "read";
  if (facts.kind === "needs_you" && facts.resolvedAt !== null) return "resolved";
  if (KIND_TOGGLE[facts.kind] !== null && !facts.toggleOn) return "pref_off";
  if (facts.device === null || !takesPings(facts.device, now)) return "device_off";
  if (!facts.canRead) return "access";
  if (isStale(facts.createdAt, now)) return "stale";
  return null;
}

/** Whether a new comment folds into the person's unread comment ping made at `createdAt`. */
export function collapsesInto(createdAt: Date, now: Date): boolean {
  return ago(now, createdAt) <= COMMENT_COLLAPSE_MS;
}

/** Whether a pull request ready now is held back by the last ready ping at `lastAt`. */
export function prReadyHeld(lastAt: Date | null, now: Date): boolean {
  return lastAt !== null && ago(now, lastAt) < PR_READY_EVERY_MS;
}
