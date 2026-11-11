import "./pz.css";
import "./app/app.css";
import type { AnalyticsSetup } from "@ponzu/desktop/bridge";
import { setupReactErrorHandler } from "@posthog/react/slim";
import { createRoot } from "react-dom/client";
import { type Analytics, type AnalyticsContext, loadAnalytics } from "./app/analytics/analytics.ts";
import { AnalyticsProvider } from "./app/analytics/provider.tsx";
import { App } from "./app/app.tsx";
import { CantStart } from "./app/cant-start.tsx";
import { desktopHost } from "./app/desktop-host.ts";
import type { Host } from "./app/host.ts";

declare global {
  interface Window {
    /** Analytics for the in-memory studio, which the headless test points at its own sink. */
    ponzuAnalyticsSetup?: AnalyticsSetup & { apiUrl: string };
  }
}

/*
 * The studio's entry. Inside the Mac app the shell's bridge is there and the app runs on it. In
 * a plain browser it runs on Ponzu Cloud in memory, but only in development (`vite`) and the
 * headless test's build (`--mode e2e`): a shipped build doesn't carry it at all, so a bridge that
 * failed to load shows that, never a working-looking world that saves nothing.
 */
const inMemory = import.meta.env.MODE === "development" || import.meta.env.MODE === "e2e";

async function host(): Promise<Host | null> {
  if (window.ponzuDesktop) return desktopHost(window.ponzuDesktop);
  // The mode, not DEV: DEV follows NODE_ENV, which a test runner sets for the build too.
  if (inMemory) {
    const { fakeHost } = await import("./app/fake-host.ts");
    return fakeHost();
  }
  return null;
}

/** Whether, and where, this window reports usage: the shell says (docs/analytics.md). */
function analyticsContext(): AnalyticsContext | null {
  const desktop = window.ponzuDesktop;
  if (desktop?.config.analytics) {
    return {
      setup: desktop.config.analytics,
      platform: desktop.platform,
      version: desktop.version,
      apiUrl: desktop.config.apiUrl,
    };
  }
  const local = inMemory ? window.ponzuAnalyticsSetup : undefined;
  return local ? { setup: local, platform: "web", version: "0.0.0", apiUrl: local.apiUrl } : null;
}

/**
 * The launch's own events, once a launch. The shell hands the launch's facts to its first window
 * only, so a window the dock opens again says nothing; a reload after a crash keeps the window's
 * arguments, so this window remembers it has said them.
 */
function launched(analytics: Analytics, setup: AnalyticsSetup | null, version: string) {
  const launch = setup?.launch;
  if (!launch) return;
  try {
    if (sessionStorage.getItem("ponzu.launched")) return;
    sessionStorage.setItem("ponzu.launched", "1");
  } catch {}
  analytics.capture("app opened", { first_launch: launch.first });
  if (launch.updatedFrom) {
    analytics.capture("update installed", {
      from_version: launch.updatedFrom,
      to_version: version,
    });
  }
}

void Promise.all([host(), loadAnalytics(analyticsContext())]).then(([host, analytics]) => {
  const context = analyticsContext();
  launched(analytics, context?.setup ?? null, context?.version ?? "");
  // An error React can't render past goes to PostHog with its component stack, once (in place of
  // React's own report, which autocapture would count again), and still to the console. What
  // the window shows for it is what it showed before.
  const report = analytics.client
    ? setupReactErrorHandler(analytics.client, (_event, error) => console.error(error))
    : undefined;
  createRoot(document.getElementById("root")!, report ? { onUncaughtError: report } : {}).render(
    <AnalyticsProvider analytics={analytics}>
      {host ? <App host={host} /> : <CantStart />}
    </AnalyticsProvider>,
  );
});
