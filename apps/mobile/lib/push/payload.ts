import { linkOfPushData, parsePushData } from "@ponzu/core/push";
import { pathOf, type Route, routeOf } from "../links";

/*
 * What a ping carries, and where a tap on it goes (docs/mobile.md, "Pings"). The API sends
 * through Expo, which puts the ping's `data` (PushData v1, `@ponzu/core/push`: ids only) under
 * `body` in what reaches iOS:
 *
 *   { "aps": { "alert": { "title": "Pricing page", "body": "Ponzu has a question for you." },
 *              "badge": 1, "sound": "default", "thread-id": "cnv_…" },
 *     "body": { "v": 1, "n": "ntf_…", "k": "needs_you", "c": "cnv_…", "w": "ws_…",
 *               "o": "thread", "q": "q_…" },
 *     "experienceId": "…", "scopeKey": "…" }
 *
 * expo-notifications hands a pushed notification's `body` over as `request.content.data`, and
 * the whole of it as `request.trigger.payload`. Either is read here, the content first. Nothing
 * else of a ping is trusted: its words are never read, and a link inside it is never followed.
 * The tap goes where `@ponzu/core/links` sends the data's ids, through lib/links.ts's routes, as
 * every other link in the app does.
 */

/** The parts of an expo-notifications `Notification` read here. */
export interface PingLike {
  request: {
    content: { data?: Record<string, unknown> | null };
    trigger?: unknown;
  };
}

/** The `data` a ping carried, wherever expo-notifications put it; null when there is none. */
export function dataOf(notification: PingLike): unknown {
  const data = notification.request.content.data;
  if (data && typeof data === "object" && Object.keys(data).length > 0) return data;
  const trigger = notification.request.trigger;
  if (trigger && typeof trigger === "object" && (trigger as { type?: unknown }).type === "push") {
    const payload = (trigger as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      const body = (payload as Record<string, unknown>).body;
      if (body && typeof body === "object") return body;
    }
  }
  return null;
}

/** The canvas a ping is about, if it names one well-formed. */
export function canvasOf(notification: PingLike): string | null {
  const link = linkOfPushData(dataOf(notification));
  return link?.kind === "canvas" ? link.canvasId : null;
}

/** What a tap opens: the app's path, the canvas (if any) and the notification to mark read. */
export interface Tap {
  /** Where the app goes. `/canvases` when the ping names nothing this app opens. */
  path: string;
  route: Route | null;
  canvasId: string | null;
  /** The notification to read (`POST /v1/me/notifications/:id/read`, via `ios`). */
  notificationId: string | null;
}

/** The canvas list, with nothing named that this app can open. */
const NOWHERE = "/canvases";

/**
 * Where a tap on `notification` goes. A version 1 ping opens what its `o` says; a ping from a
 * newer API this build can't read opens the canvas it names, if any; anything else opens the
 * canvases. A canvas route carries `ping=<notification id>`, so the canvas screen knows a ping
 * opened it: one the person can't open any more sends them to the canvases with a line saying so.
 */
export function tapOf(notification: PingLike): Tap {
  const raw = dataOf(notification);
  const data = parsePushData(raw);
  const link = linkOfPushData(raw);
  const route = link ? routeOf(link) : null;
  const notificationId = data?.n ?? null;
  if (!route) return { path: NOWHERE, route: null, canvasId: null, notificationId };
  if (route.screen === "canvas") {
    // The notification's id, so a second tap on another ping changes the route's params.
    const pinged: Route = { ...route, params: { ...route.params, ping: notificationId ?? "1" } };
    return { path: pathOf(pinged), route: pinged, canvasId: route.id, notificationId };
  }
  if (route.screen === "settings")
    return { path: pathOf(route), route, canvasId: null, notificationId };
  // A ping never opens setup, sign-in or anything else a link might.
  return { path: NOWHERE, route: null, canvasId: null, notificationId };
}
