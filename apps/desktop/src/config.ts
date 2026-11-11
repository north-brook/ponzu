/*
 * Where this build talks to, and what it lets a developer do. A packaged build always talks to
 * Ponzu Cloud; a development build (`bun run start`) can be pointed elsewhere, and can load the
 * studio from Vite's dev server.
 */

/** Set by scripts/build.ts: true only in a build made for spare or CI to drive, never a release. */
declare const PONZU_TEST_BUILD: boolean;
export const testBuild = typeof PONZU_TEST_BUILD === "boolean" && PONZU_TEST_BUILD;

/**
 * Which packaged app this is. `release` is Ponzu, what ponzu.design ships. `preview` is Ponzu
 * Preview (`bun run package:preview`): the release under a name of its own, for running the cloud
 * app on a Mac that still uses Ponzu 1.x. Set by scripts/build.ts from PONZU_VARIANT.
 */
export type Variant = "release" | "preview";
declare const PONZU_VARIANT: Variant;
export const variant: Variant = typeof PONZU_VARIANT === "string" ? PONZU_VARIANT : "release";

/** The links each app answers. The API's setup page links back to exactly these (apps/api). */
export type LinkScheme = "ponzu" | "ponzu-preview" | "ponzu-dev";

export interface Config {
  /**
   * `Ponzu`, `Ponzu Preview` or `Ponzu Dev`: the name the data folder, keychain item and instance
   * lock go by.
   */
  appName: string;
  apiUrl: string;
  /** The WorkOS environment's client id: public, the app ships it. Staging until cutover. */
  workosClientId: string;
  /**
   * The origins the window may reach beyond the API: Neon Realtime and a design's files, as the
   * API's environment names them. Null in a development build, which may reach any of each kind.
   */
  realtimeUrl: string | null;
  assetsUrl: string | null;
  /** Vite's dev server, when a development build loads the studio from it. */
  studioDevUrl: string | null;
  /**
   * `ponzu`, or `ponzu-preview` and `ponzu-dev`, so a preview or a development build never takes
   * an installed Ponzu's links.
   */
  linkScheme: LinkScheme;
  /** Whether this build removes what Ponzu 1.x left on the computer (legacy.ts): a release only. */
  cleansUpLegacy: boolean;
  /** Whether this build looks for updates of itself: a release only, the one with a feed. */
  updates: boolean;
  /** A developer's saved session to run on instead of the keychain (session-file.ts). */
  sessionFile: string | null;
  /** Whether a remote debugging port may be opened on this build's windows. */
  remoteDebugging: boolean;
}

const API_URL = "https://api.ponzu.design";
const WORKOS_CLIENT_ID = "client_01M72Y00K1VV63G6V5D25YCE6K";
/** What api.ponzu.design hands clients until cutover (docs/cloud.md, "Environments"). */
const REALTIME_URL = "https://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech";
const ASSETS_URL = "https://assets-dev.ponzu.cloud";

export function configFor(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
  test = testBuild,
  of: Variant = variant,
): Config {
  // A test build is the real app with two doors a developer's tools need, and nothing else.
  const developer = { sessionFile: env.PONZU_SESSION_FILE || null, remoteDebugging: true };
  if (packaged) {
    const release = of === "release";
    return {
      // A preview is the release in all but who it is: it never touches Ponzu 1.x (its folders,
      // its keychain item, its ponzu:// links), and with no feed of its own it never updates.
      appName: release ? "Ponzu" : "Ponzu Preview",
      apiUrl: API_URL,
      workosClientId: WORKOS_CLIENT_ID,
      realtimeUrl: REALTIME_URL,
      assetsUrl: ASSETS_URL,
      studioDevUrl: null,
      linkScheme: release ? "ponzu" : "ponzu-preview",
      cleansUpLegacy: release,
      updates: release,
      ...(test ? developer : { sessionFile: null, remoteDebugging: false }),
    };
  }
  return {
    appName: "Ponzu Dev",
    apiUrl: localOrHttps(env.PONZU_API_URL) ?? API_URL,
    workosClientId: env.PONZU_WORKOS_CLIENT_ID || WORKOS_CLIENT_ID,
    realtimeUrl: null,
    assetsUrl: null,
    studioDevUrl: localOrHttps(env.PONZU_STUDIO_URL),
    linkScheme: "ponzu-dev",
    cleansUpLegacy: false,
    updates: false,
    ...developer,
  };
}

/** An https URL, or http on this computer; anything else is ignored. Without a trailing slash. */
function localOrHttps(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}

/**
 * Why a packaged app must not start, or null. Which bundle this is (its name, bundle id and link
 * scheme) is electron-builder's doing; which app the main process thinks it is (`variant`, and so
 * its data folder, keychain item and whether it removes Ponzu 1.x) was fixed when scripts/build.ts
 * compiled it. A bundle named "Ponzu Preview" running a release's main process would take
 * Ponzu's folder and clean up 1.x, so a mismatch stops it before anything reads either.
 * `bundleName` is `app.name` before the app renames itself: the bundle's productName.
 */
export function bundleMismatch(
  packaged: boolean,
  bundleName: string,
  config: Config,
): string | null {
  if (!packaged || bundleName === config.appName) return null;
  return `This app is "${bundleName}", but its main process was built for "${config.appName}". Build it again with its own command (bun run package, or bun run package:preview).`;
}

/**
 * How this build registers its link scheme with the system, if it does. A packaged app declares
 * its scheme in its bundle (Info.plist on a Mac, the .desktop file on Linux) and claims it as the
 * default at launch. A development build points the scheme at this checkout, except on a Mac,
 * where it runs inside node_modules' Electron.app, which declares no schemes. The smoke check
 * claims nothing: registering writes the person's LaunchServices or xdg settings, and would make
 * a copy in a build folder the one their links open.
 */
export function schemeRegistration(
  packaged: boolean,
  platform: NodeJS.Platform,
  smoke: boolean,
): "bundle" | "checkout" | null {
  if (smoke) return null;
  if (packaged) return "bundle";
  return platform === "darwin" ? null : "checkout";
}
