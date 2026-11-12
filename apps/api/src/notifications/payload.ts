import { z } from "zod";
import { TITLE_MAX, titleOf } from "./copy.ts";
import { NOTIFICATION_KINDS, NOTIFICATION_OPENS, type NotificationKind } from "./kinds.ts";
import { PUSH_TTL_S } from "./plan.ts";

/*
 * One ping as the Expo push service takes it (docs/cloud.md, "Notifications"). Its words come
 * from copy.ts; its `data` is `PushData` v1, ids only, which the phone turns into a link. Pure:
 * the push seam (deps/push.ts) sends what this builds.
 *
 * `PushMessage` and `PushData` are declared here until the push seam and the shared link
 * grammar (`@ponzu/core/push`) land, which then own them; the shapes are the same.
 *
 * Expo and Apple refuse a notification past 4096 bytes. The whole message is measured as UTF-8
 * JSON, which is more than Apple counts, and a title that would pass the limit is clipped
 * further. Nothing in `data` is ever clipped: it holds only ids, which are short.
 */

export const PUSH_MAX_BYTES = 4096;

/** One message to one phone, in the shape `expo-server-sdk` sends. */
export interface PushMessage {
  to: string;
  title?: string;
  body?: string;
  sound?: "default";
  badge?: number;
  threadId?: string;
  collapseId?: string;
  priority: "high";
  interruptionLevel: "active";
  ttl: number;
  data?: PushData;
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * What a ping carries for the app to act on: which notification (`n`) of which kind (`k`), the
 * canvas (`c`) or workspace (`w`), where it opens (`o`), and the page (`p`), artboard (`a`),
 * comment thread (`t`) or question (`q`) it opens on. Ids only, never words.
 */
export const PushData = z.strictObject({
  v: z.literal(1),
  n: Id,
  k: z.enum(NOTIFICATION_KINDS),
  c: Id.optional(),
  w: Id.optional(),
  o: z.enum(NOTIFICATION_OPENS),
  p: Id.optional(),
  a: Id.optional(),
  t: Id.optional(),
  q: Id.optional(),
});
export type PushData = z.infer<typeof PushData>;

/** Where a notification opens, as its row keeps it. */
export interface NotificationLink {
  open: PushData["o"];
  pageId?: string | null;
  artboardId?: string | null;
  commentThreadId?: string | null;
  questionId?: string | null;
}

/** A notification, as far as its push needs it. */
export interface PushNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  canvasId: string | null;
  workspaceId: string | null;
  link: NotificationLink;
}

/** The size Expo and Apple measure, over-counted: the message as UTF-8 JSON. */
export function messageBytes(message: PushMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/** `data` for a notification: checked, so anything that is not an id is refused here. */
export function pushData(notification: PushNotification): PushData {
  const { link } = notification;
  const data: Record<string, unknown> = { v: 1, n: notification.id, k: notification.kind };
  if (notification.canvasId) data.c = notification.canvasId;
  if (notification.workspaceId) data.w = notification.workspaceId;
  data.o = link.open;
  if (link.pageId) data.p = link.pageId;
  if (link.artboardId) data.a = link.artboardId;
  if (link.commentThreadId) data.t = link.commentThreadId;
  if (link.questionId) data.q = link.questionId;
  return PushData.parse(data);
}

/**
 * The message that pings one phone. `badge` is the person's open needs-you count. A canvas's
 * pings are grouped by its id (a billing ping's by the workspace's), and a teammate's comments
 * replace one another on the phone (`collapseIdOf`).
 */
export function pushMessage(
  to: string,
  notification: PushNotification,
  badge: number,
): PushMessage {
  const group = notification.canvasId ?? notification.workspaceId ?? undefined;
  const message: PushMessage = {
    to,
    title: notification.title,
    body: notification.body,
    sound: "default",
    badge,
    ...(group ? { threadId: group } : {}),
    collapseId: collapseIdOf(notification),
    priority: "high",
    interruptionLevel: "active",
    ttl: PUSH_TTL_S,
    data: pushData(notification),
  };
  return fit(message);
}

/**
 * What a later ping replaces this one by on the phone. A teammate's comments on a canvas replace
 * one another. Every other ping collapses by its own notification's id: Expo delivers at least
 * once, so a ping it hands Apple twice shows once.
 */
export function collapseIdOf(notification: Pick<PushNotification, "id" | "kind" | "canvasId">) {
  return notification.kind === "teammate_comment" && notification.canvasId
    ? `${notification.canvasId}:comments`
    : notification.id;
}

/** A push that only sets the app's badge: no words, no sound. */
export function badgeMessage(to: string, badge: number): PushMessage {
  return fit({ to, badge, priority: "high", interruptionLevel: "active", ttl: PUSH_TTL_S });
}

/** The message within `PUSH_MAX_BYTES`, clipping its title shorter until it is; else it throws. */
function fit(message: PushMessage): PushMessage {
  if (messageBytes(message) <= PUSH_MAX_BYTES) return message;
  const title = message.title ?? "";
  for (let max = Math.min([...title].length - 1, TITLE_MAX); max >= 1; max -= 1) {
    const shorter = { ...message, title: titleOf(title, max) };
    if (messageBytes(shorter) <= PUSH_MAX_BYTES) return shorter;
  }
  throw new Error(
    `A push message is more than ${PUSH_MAX_BYTES} bytes even with its title clipped.`,
  );
}
