import posthog from "posthog-js";

/**
 * Sends an error a React error boundary caught (app/error.tsx, app/global-error.tsx) to PostHog.
 * React doesn't rethrow those, so exception autocapture never sees them. Without a key
 * (instrumentation-client.ts) PostHog never started and nothing is sent.
 */
export function reportError(error: unknown, boundary: "page" | "root") {
  if (posthog.__loaded) posthog.captureException(error, { boundary });
}
