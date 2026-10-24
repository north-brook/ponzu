import type { Mac } from "./mac";

/**
 * Push notifications, not yet wired. The plan (the design's notes): each Mac
 * decides when to notify (only when the phone was the last thing the person
 * used) and posts a content-free push ("something happened in Kettle") to a
 * relay in apps/web, which holds the APNs key. The phone then fetches the
 * details over the tailnet, as it does now when Activity opens.
 *
 * What's missing is the Mac's side: a route to hand it this phone's APNs
 * token, and the relay. Once there is one, `registerPush` asks for permission
 * (after the person has paired, never at launch), reads the token with
 * expo-notifications' `getDevicePushTokenAsync`, and posts it to each
 * answering Mac. A tap on a push opens `ponzu://design/<mac>/<key>?thread=<id>`,
 * which the canvas already handles.
 */
export async function registerPush(_macs: Mac[]): Promise<void> {
  // TODO(push): no server route takes a token yet; see above.
}
