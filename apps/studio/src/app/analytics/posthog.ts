import { scrubSecrets } from "@ponzu/client";
import type { CaptureResult, PostHogConfig } from "posthog-js";
// The bundle with every extension PostHog would otherwise fetch from its CDN built in (the
// recorder, exception autocapture, tracing headers, heatmaps, dead clicks) and no script loader:
// the window's policy runs no script but the studio's own.
import posthog from "posthog-js/full/no-external";
import { type Analytics, type AnalyticsContext, guarded, type Workspace } from "./analytics.ts";
import { VIEW_ORIGIN, type View, viewUrl } from "./events.ts";
import {
  placeOnView,
  replayPrivacy,
  scrubLocalPathsDeep,
  scrubNetworkUrl,
  type ViewPlace,
} from "./privacy.ts";

/*
 * PostHog in the studio (docs/analytics.md). Loaded by analytics.ts only when there is a project
 * to report to. Everything an Electron window needs that a website doesn't:
 *
 * - No remote script: the no-external bundle, with loading external dependencies switched off.
 * - Persistence in localStorage under the studio's own origin, which outlives restarts (there
 *   are no cookies on `ponzu-studio://`). Signing out clears it, and resets PostHog first.
 * - No location: the page is `ponzu-studio://app/` in a release and a dev server elsewhere, so
 *   every event and recording says the view's synthetic URL instead (`ponzu://app/canvas`), and
 *   a `$pageview` is captured when the view changes, not when the page loads.
 * - The session id reaches the API on every request to it (`tracing_headers`), so the API can
 *   put `$session_id` on what it captures and a recording links to its server events.
 */

/** The PostHog defaults this configuration was written against. */
const DEFAULTS = "2026-08-30";

export function startPosthog(
  context: AnalyticsContext,
  overrides: Partial<PostHogConfig> = {},
): Analytics {
  const { setup } = context;
  const pageOrigin = window.location.origin;
  // A development build loads the studio from Vite, whose URLs can name the checkout.
  const development = !pageOrigin.startsWith("ponzu-studio:");
  let place: ViewPlace = { url: `${VIEW_ORIGIN}/`, path: "/", host: "app" };
  let lastView: string | null = null;
  let groupKey: string | null = null;

  const scrub = (event: CaptureResult): CaptureResult => {
    const placed: CaptureResult = {
      ...event,
      properties: placeOnView(event.properties, place, true),
      ...(event.$set ? { $set: placeOnView(event.$set, place, false) } : {}),
      ...(event.$set_once ? { $set_once: placeOnView(event.$set_once, place, false) } : {}),
    };
    // A recording's frames are compressed bytes, and its network timing is scrubbed as it is
    // recorded (`maskCapturedNetworkRequestFn`); everything else goes through the last pass for
    // URL queries and credentials (an exception's message can name a link with a code in it).
    const sent =
      event.event === "$snapshot"
        ? { ...placed, properties: placeSnapshot(placed.properties, place) }
        : scrubSecrets(placed);
    return development ? scrubLocalPathsDeep(sent) : sent;
  };

  const client = posthog.init(setup.key, {
    api_host: setup.host,
    defaults: DEFAULTS,
    disable_external_dependency_loading: true,
    persistence: "localStorage",
    person_profiles: "identified_only",
    // Pageviews are views, captured by `view`; a desktop window has no pages to leave.
    capture_pageview: false,
    capture_pageleave: false,
    save_referrer: false,
    // Clicks, changes and submits, for heatmaps and paths; never an element's text nor its
    // attributes, which are so often a canvas's name or someone's words (a sidebar row's
    // `aria-label` names its canvas, repo and branch; a board's `title` is its name). What is
    // left is the elements' tags and places, which is what heatmaps and dead clicks need.
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_heatmaps: true,
    capture_dead_clicks: true,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    // Network timing for replay: the address (scrubbed) and how long, never headers or bodies.
    capture_performance: { network_timing: true, web_vitals: false },
    enable_recording_console_log: true,
    disable_session_recording: false,
    session_recording: {
      ...replayPrivacy(setup.replay),
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: scrubNetworkUrl(request.name, {
          origin: pageOrigin,
          replacement: place.url,
          api: context.apiUrl,
        }),
      }),
    },
    tracing_headers: [new URL(context.apiUrl).hostname],
    // Nothing of these is used, so nothing of them is asked for.
    advanced_disable_feature_flags: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    // A development build on localhost is still a person using Ponzu Dev, not a test user.
    internal_or_test_user_hostname: null,
    get_current_url: () => place.url,
    before_send: (event) => (event ? scrub(event) : null),
    ...overrides,
  });
  // `init` hands back the instance it made, or undefined if it had one already.
  const ph = client ?? posthog;
  ph.register({
    app_version: context.version,
    channel: setup.channel,
    platform: context.platform,
    os_version: setup.osVersion,
  });

  return {
    client: ph,
    capture: guarded((event: string, properties?: object) => {
      ph.capture(event, { ...properties });
    }) as Analytics["capture"],
    view: guarded((view: View) => {
      const { url, path, properties } = viewUrl(view);
      const key = `${url} ${JSON.stringify(properties)}`;
      if (key === lastView) return;
      lastView = key;
      place = { url, path, host: "app" };
      ph.capture("$pageview", { ...properties, $current_url: url, $pathname: path });
    }),
    identify: guarded((userId: string) => {
      if (ph.get_distinct_id() !== userId) ph.identify(userId);
    }),
    workspace: guarded((workspace: Workspace | null) => {
      if (!workspace) {
        if (groupKey) ph.resetGroups();
        groupKey = null;
        return;
      }
      if (workspace.id === groupKey) return;
      groupKey = workspace.id;
      ph.group("workspace", workspace.id, {
        name: workspace.login,
        kind: workspace.kind === "org" ? "organization" : "user",
      });
    }),
    signedOut: guarded(() => {
      groupKey = null;
      // Only someone identified is forgotten: a launch signed out keeps its anonymous id.
      if (ph.get_property("$user_state") === "identified") ph.reset();
    }),
    exception: guarded((error: unknown, properties?: Record<string, unknown>) => {
      ph.captureException(error, properties);
    }),
  };
}

/**
 * A recording's batch with the page's address out of it: rrweb's meta event (type 4) carries
 * `location.href`, which becomes the view's URL.
 */
function placeSnapshot(properties: Record<string, unknown>, place: ViewPlace) {
  const data = properties.$snapshot_data;
  if (!Array.isArray(data)) return properties;
  return {
    ...properties,
    $snapshot_data: data.map((entry: { type?: number; data?: { href?: string } }) =>
      entry?.type === 4 && entry.data && typeof entry.data.href === "string"
        ? { ...entry, data: { ...entry.data, href: place.url } }
        : entry,
    ),
  };
}
