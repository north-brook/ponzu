import { PostHogProvider } from "@posthog/react/slim";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { type Analytics, noAnalytics } from "./analytics.ts";
import { type View, viewUrl } from "./events.ts";

/*
 * The analytics at the root of the window. Components ask for it with `useAnalytics` (no-ops
 * outside a provider: the gallery, a test), and say which view they are with `useView`. Under
 * it, @posthog/react's own provider holds the client, for its hooks; its slim entry, since the
 * client is the bundle analytics.ts loaded, not posthog-js's default one.
 */

const AnalyticsContext = createContext<Analytics>(noAnalytics);

export function AnalyticsProvider({
  analytics,
  children,
}: {
  analytics: Analytics;
  children: ReactNode;
}) {
  const inner = analytics.client ? (
    <PostHogProvider client={analytics.client}>{children}</PostHogProvider>
  ) : (
    children
  );
  return <AnalyticsContext.Provider value={analytics}>{inner}</AnalyticsContext.Provider>;
}

export function useAnalytics(): Analytics {
  return useContext(AnalyticsContext);
}

/** Says the window is showing `view` while it is, and again whenever it changes. Null: nothing. */
export function useView(view: View | null): void {
  const analytics = useAnalytics();
  const key = view ? `${viewUrl(view).url} ${JSON.stringify(viewUrl(view).properties)}` : null;
  // Keyed by what the view says, not by the object, which is new each render.
  useEffect(() => {
    if (view) analytics.view(view);
  }, [analytics, key]);
}
