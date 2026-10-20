import posthog from "posthog-js";

// Through /ingest on this domain (next.config.ts), so blockers that drop third-party analytics don't.
posthog.init("phc_mEVKBf9GwcLquUtegCVaSJ3nzWJBZQjXV9BBkwGaEFi2", {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-08-30",
  // Anonymous visitors: no person profiles, no recordings.
  person_profiles: "identified_only",
  disable_session_recording: true,
  respect_dnt: true,
});

// Every way to get the app: Download buttons (the install steps) and direct DMG links.
document.addEventListener("click", (e) => {
  const link = (e.target as Element | null)?.closest?.("a[href]");
  const href = link?.getAttribute("href");
  if (href && (href.startsWith("/download") || href.endsWith(".dmg")))
    posthog.capture("download clicked", { href, page: location.pathname });
});
