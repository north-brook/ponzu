import type { PostHog } from "posthog-js";
import { shouldCapture, signalsOf } from "./consent";
import { watchHealth } from "./health";

/*
 * The site's analytics, started once by instrumentation-client.ts. A function of what it touches
 * (the window, PostHog, the key), so site-analytics.test.ts can run it against fakes.
 *
 * Without a key, or when the browser sends Do Not Track or Global Privacy Control, nothing runs:
 * PostHog is never initialised, no click is listened to, and the crash marker is never written.
 */

/** The PostHog calls the site makes. */
export type SiteAnalyticsClient = Pick<
  PostHog,
  "init" | "capture" | "has_opted_out_capturing" | "on"
>;

/** What `init` is given: exported so the test can hold it to the privacy policy. */
export const POSTHOG_CONFIG = {
  // Through /ingest on this domain (next.config.ts), so blockers that drop third-party analytics
  // don't.
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-08-30",
  // No cookies, localStorage or sessionStorage of PostHog's: visits are told apart by a hash
  // PostHog makes on its servers, so the site needs no cookie banner. PostHog drops these events
  // until the project's "Enable cookieless tracking" setting is on (a founder step).
  cookieless_mode: "always",
  // Pageviews (and the scroll depth on leaving them), download clicks, errors, web vitals and the
  // crash signal (health.ts): no autocapture, person profiles or recordings.
  autocapture: false,
  person_profiles: "never",
  disable_session_recording: true,
  // Uncaught errors and unhandled rejections, with their stack traces. app/error.tsx and
  // app/global-error.tsx report the ones React catches.
  capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true },
  capture_performance: { web_vitals: true, network_timing: false },
} as const satisfies Parameters<PostHog["init"]>[1];

/** Starts the site's analytics; answers whether it did. */
export function startSiteAnalytics(
  win: Window,
  posthog: SiteAnalyticsClient,
  key: string | undefined,
): boolean {
  if (!key || !shouldCapture(signalsOf(win))) return false;
  posthog.init(key, POSTHOG_CONFIG);

  // Every way to get the app: Download buttons (the install steps) and direct DMG links.
  win.document.addEventListener("click", (e) => {
    const link = (e.target as Element | null)?.closest?.("a[href]");
    const href = link?.getAttribute("href");
    if (href && (href.startsWith("/download") || href.endsWith(".dmg")))
      posthog.capture("download clicked", { href, page: win.location.pathname });
  });

  // The crash signal keeps its own marker in the tab's session storage, which the privacy policy
  // names. It runs only while PostHog does.
  if (!posthog.has_opted_out_capturing()) {
    const mark = watchHealth((event, properties) => posthog.capture(event, properties), win);
    // Pages change without a load; the marker follows them.
    posthog.on("eventCaptured", (e: { event?: string }) => {
      if (e.event === "$pageview") mark();
    });
  }
  return true;
}
