import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PrivacySignals, shouldCapture, signalsOf } from "./consent.ts";
import { MARKER } from "./health.ts";
import { POSTHOG_CONFIG, type SiteAnalyticsClient, startSiteAnalytics } from "./site-analytics.ts";

test("Do Not Track or Global Privacy Control means no capture; anything else allows it", () => {
  const cases: [PrivacySignals, boolean][] = [
    [{}, true],
    [{ doNotTrack: null, globalPrivacyControl: false }, true],
    [{ doNotTrack: "0" }, true],
    [{ doNotTrack: "unspecified" }, true],
    [{ doNotTrack: "1" }, false],
    [{ globalPrivacyControl: true }, false],
    [{ doNotTrack: "1", globalPrivacyControl: true }, false],
  ];
  for (const [signals, allowed] of cases)
    expect([signals, shouldCapture(signals)]).toEqual([signals, allowed]);
});

/** A tab with the signals given, a document that records its listeners, and session storage. */
function browser(nav: Record<string, unknown> = {}, legacyDnt?: string) {
  const store = new Map<string, string>();
  const listeners: string[] = [];
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    readyState: "loading",
  });
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (type: string, ...rest: [EventListenerOrEventListenerObject | null]) => {
    listeners.push(type);
    add(type, ...rest);
  };
  const win = Object.assign(new EventTarget(), {
    navigator: nav,
    doNotTrack: legacyDnt,
    document: doc,
    location: { pathname: "/" },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return { win: win as unknown as Window, store, listeners };
}

function fakePosthog() {
  const calls: string[] = [];
  const client: SiteAnalyticsClient = {
    init: ((key: string, config: unknown) => {
      calls.push(`init ${key} ${JSON.stringify(config)}`);
    }) as unknown as SiteAnalyticsClient["init"],
    capture: ((event: string) => {
      calls.push(`capture ${event}`);
    }) as unknown as SiteAnalyticsClient["capture"],
    has_opted_out_capturing: () => false,
    on: (() => () => {}) as SiteAnalyticsClient["on"],
  };
  return { client, calls };
}

test("under Do Not Track or Global Privacy Control nothing starts: no PostHog, no listener, no marker", () => {
  for (const [nav, legacy] of [
    [{ doNotTrack: "1" }, undefined],
    [{ globalPrivacyControl: true }, undefined],
    // Older browsers keep Do Not Track on window.
    [{}, "1"],
  ] as const) {
    const { win, store, listeners } = browser(nav, legacy);
    const { client, calls } = fakePosthog();
    expect(startSiteAnalytics(win, client, "phc_test")).toBe(false);
    expect(calls).toEqual([]);
    expect(listeners).toEqual([]);
    expect(store.has(MARKER)).toBe(false);
  }
});

test("without a key nothing starts either", () => {
  const { win, store, listeners } = browser();
  const { client, calls } = fakePosthog();
  expect(startSiteAnalytics(win, client, undefined)).toBe(false);
  expect([calls, listeners, store.size]).toEqual([[], [], 0]);
});

test("otherwise PostHog starts cookieless, with no person profiles, and the download listener attaches", () => {
  const { win, store, listeners } = browser({ doNotTrack: "0", globalPrivacyControl: false });
  const { client, calls } = fakePosthog();
  expect(startSiteAnalytics(win, client, "phc_test")).toBe(true);
  expect(calls).toEqual([`init phc_test ${JSON.stringify(POSTHOG_CONFIG)}`]);
  expect(listeners).toContain("click");
  // The crash marker, which the privacy policy names.
  expect(store.has(MARKER)).toBe(true);
});

test("the config never stores PostHog data in the browser and records nothing", () => {
  expect(POSTHOG_CONFIG).toMatchObject({
    cookieless_mode: "always",
    person_profiles: "never",
    autocapture: false,
    disable_session_recording: true,
    api_host: "/ingest",
  });
  // shouldCapture replaces PostHog's own Do Not Track handling.
  expect("respect_dnt" in POSTHOG_CONFIG).toBe(false);
});

test("instrumentation-client.ts starts the site's analytics this way and no other", () => {
  const source = readFileSync(join(import.meta.dir, "..", "instrumentation-client.ts"), "utf8");
  expect(source).toContain(
    "startSiteAnalytics(window, posthog, process.env.NEXT_PUBLIC_POSTHOG_KEY)",
  );
  expect(source).not.toContain("posthog.init");
  expect(source).not.toContain("addEventListener");
});

test("signals are read from navigator, and window for older browsers", () => {
  expect(signalsOf(browser({ doNotTrack: "1" }).win)).toEqual({
    doNotTrack: "1",
    globalPrivacyControl: undefined,
  });
  expect(signalsOf(browser({ globalPrivacyControl: true }).win)).toEqual({
    doNotTrack: null,
    globalPrivacyControl: true,
  });
  expect(signalsOf(browser({}, "1").win).doNotTrack).toBe("1");
  // A navigator that says something other than "1" does not hide a window that says "1".
  expect(signalsOf(browser({ doNotTrack: "unspecified" }, "1").win).doNotTrack).toBe("1");
  expect(signalsOf(browser({ doNotTrack: "0" }, "1").win).doNotTrack).toBe("1");
  expect(signalsOf(browser({ doNotTrack: "0" }).win).doNotTrack).toBe("0");
});
