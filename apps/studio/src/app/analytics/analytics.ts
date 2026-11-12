import type { AnalyticsSetup } from "@ponzu/desktop/bridge";
import type { PostHog } from "posthog-js";
import type { AppEventName, AppEvents, View } from "./events.ts";

/*
 * The studio's usage analytics, session replay and error tracking (docs/analytics.md), as the
 * app sees them: a typed catalogue of events and a handful of facts about who and where. Behind
 * it is PostHog (posthog.ts), loaded only when the shell says this build reports and the person
 * hasn't said no; otherwise every call is a no-op and nothing of PostHog is in the window.
 *
 * Nothing here can throw into the app or wait on the network: each call is guarded, and PostHog
 * sends in the background from its own bounded queue.
 */

/** Properties an event must be given, or none for one that takes none. */
type Args<E extends AppEventName> =
  Record<string, never> extends AppEvents[E]
    ? [properties?: AppEvents[E]]
    : [properties: AppEvents[E]];

export interface Workspace {
  id: string;
  /** The GitHub account's login. */
  login: string;
  kind: "personal" | "org";
}

export interface Analytics {
  capture<E extends AppEventName>(event: E, ...args: Args<E>): void;
  /** Where the window is now: a `$pageview` of the view's synthetic URL when it changes. */
  view(view: View): void;
  /** The Ponzu user id the API authenticates. Person properties are the API's to set. */
  identify(userId: string): void;
  /** The workspace in view, as PostHog's `workspace` group. */
  workspace(workspace: Workspace | null): void;
  /** Nobody is signed in: the next person on this computer starts as nobody, not as the last. */
  signedOut(): void;
  /** An error React caught, or another the app means to report. */
  exception(error: unknown, properties?: Record<string, unknown>): void;
  /**
   * Settings › Account › Share usage data: off stops every capture and the recording at once,
   * and is kept in PostHog's own storage, so it holds at the next launch too; on starts
   * capturing again. Whether this window reports at all is `reporting`.
   */
  setSharing(on: boolean): void;
  /** Whether this window loaded PostHog: false when the build or this computer says no. */
  readonly reporting: boolean;
  /** The PostHog client, for @posthog/react's provider; null when nothing is reported. */
  readonly client: PostHog | null;
}

export const noAnalytics: Analytics = {
  capture() {},
  view() {},
  identify() {},
  workspace() {},
  signedOut() {},
  exception() {},
  setSharing() {},
  reporting: false,
  client: null,
};

export interface AnalyticsContext {
  setup: AnalyticsSetup;
  /** The shell's `process.platform`. */
  platform: string;
  version: string;
  /** Requests to it carry PostHog's session headers, which tie a recording to the API's events. */
  apiUrl: string;
}

/**
 * The analytics for this window: PostHog when `setup` says to report, loaded from the app's own
 * bundle (never the network), or no-ops. A PostHog that fails to start is no-ops too.
 */
export async function loadAnalytics(context: AnalyticsContext | null): Promise<Analytics> {
  if (!context) return noAnalytics;
  try {
    const { startPosthog } = await import("./posthog.ts");
    return startPosthog(context);
  } catch {
    return noAnalytics;
  }
}

/** `fn`, made unable to throw into whatever called it. */
export function guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch {}
  };
}
