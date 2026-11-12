/*
 * Whether the site may count this visit at all. A browser that sends Do Not Track or Global
 * Privacy Control gets nothing: PostHog is never initialised, the download listener is never
 * attached and the crash marker is never written (instrumentation-client.ts). Pure, so it is
 * tested without a browser.
 */

/** The parts of `navigator` (and `window`, for older browsers' Do Not Track) that say no. */
export interface PrivacySignals {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

export function shouldCapture(nav: PrivacySignals): boolean {
  return nav.doNotTrack !== "1" && nav.globalPrivacyControl !== true;
}

/**
 * The signals a browser sends, read where each browser keeps them. Either place saying "1" is a
 * no: a navigator that says "unspecified" must not hide a window that says "1".
 */
export function signalsOf(win: Window): PrivacySignals {
  const nav = win.navigator as Navigator & { globalPrivacyControl?: boolean };
  const legacy = win as Window & { doNotTrack?: string | null };
  const said = [nav.doNotTrack, legacy.doNotTrack];
  return {
    doNotTrack: said.includes("1") ? "1" : (said.find((v) => v != null) ?? null),
    globalPrivacyControl: nav.globalPrivacyControl,
  };
}
