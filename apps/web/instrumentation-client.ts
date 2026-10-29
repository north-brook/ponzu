import posthog from "posthog-js";
import { watchHealth } from "@/components/health";

// Set on Vercel for ponzu.design; local and fork builds send nothing.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  // Through /ingest on this domain (next.config.ts), so blockers that drop third-party analytics don't.
  posthog.init(key, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-08-30",
    // Pageviews (and the scroll depth on leaving them), download clicks, errors, web vitals and
    // the crash signal (components/health.ts): no autocapture, person profiles or recordings.
    autocapture: false,
    person_profiles: "identified_only",
    disable_session_recording: true,
    respect_dnt: true,
    // Uncaught errors and unhandled rejections, with their stack traces. app/error.tsx and
    // app/global-error.tsx report the ones React catches.
    capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true },
    capture_performance: { web_vitals: true, network_timing: false },
  });

  // Every way to get the app: Download buttons (the install steps) and direct DMG links.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element | null)?.closest?.("a[href]");
    const href = link?.getAttribute("href");
    if (href && (href.startsWith("/download") || href.endsWith(".dmg")))
      posthog.capture("download clicked", { href, page: location.pathname });
  });

  // Do Not Track turns capture off; then the crash signal doesn't run either.
  if (!posthog.has_opted_out_capturing()) {
    const mark = watchHealth((event, properties) => posthog.capture(event, properties));
    // Pages change without a load; the marker follows them.
    posthog.on("eventCaptured", (e: { event?: string }) => {
      if (e.event === "$pageview") mark();
    });
  }
}
