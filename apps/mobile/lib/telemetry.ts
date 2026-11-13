import type { GesturePerf } from "../canvas/protocol";

/**
 * Usage events. Off in this version of the app: the 1.x reporting (identity from a paired
 * Mac's Tailscale owner) went with pairing, and the cloud app's analytics (a typed catalogue,
 * the person's identity, the workspace group, error tracking, scrubbed of secrets) come with
 * their own slice in lib/analytics, keyed on EXPO_PUBLIC_POSTHOG_KEY. Until then nothing is
 * sent, whatever the build's environment holds.
 */
export type Event =
  | ["app opened", Record<string, never>?]
  /** A sample of gestures on the canvas: how the canvas's frames kept up (lib/canvas-perf.ts). */
  | ["canvas gesture", GesturePerf]
  /** Another account holds this phone's push token from another install: never the token. */
  | ["device token conflict", Record<string, never>?];

/** Whether this build could send anything: not yet. */
export const canTrack = false;

export function track(..._event: Event) {}
