/*
 * Where this build talks to, and what it lets a developer do. A packaged build always talks to
 * Ponzu Cloud; a development build (`bun run start`) can be pointed elsewhere, and can load the
 * studio from Vite's dev server.
 */

/** Set by scripts/build.ts: true only in a build made for spare or CI to drive, never a release. */
declare const PONZU_TEST_BUILD: boolean;
export const testBuild = typeof PONZU_TEST_BUILD === "boolean" && PONZU_TEST_BUILD;

/**
 * Which packaged app this is. `release` is Ponzu, what ponzu.design ships. `dev` is Ponzu Dev
 * (`bun run package:dev`): the release under a name of its own, for running the cloud app on a
 * Mac that still uses Ponzu 1.x. Set by scripts/build.ts from PONZU_VARIANT.
 */
export type Variant = "release" | "dev";
declare const PONZU_VARIANT: Variant;
export const variant: Variant = typeof PONZU_VARIANT === "string" ? PONZU_VARIANT : "release";

/**
 * The links a packaged app answers: Ponzu's, and Ponzu Dev's. The API's setup page links back to
 * these (apps/api), and still to `ponzu-preview` for a Ponzu Preview built before the rename.
 */
export type LinkScheme = "ponzu" | "ponzu-dev";

/** What each app goes by. A run from a checkout is Ponzu Local, never an installed app. */
export const APP_NAMES = { release: "Ponzu", dev: "Ponzu Dev", local: "Ponzu Local" } as const;

/**
 * Which PostHog project this build reports to (docs/analytics.md): public values, baked in by
 * scripts/build.ts from PONZU_POSTHOG_KEY, PONZU_POSTHOG_HOST and PONZU_POSTHOG_REPLAY, so the
 * environment a build was made for decides the project. Empty strings when the build had none.
 */
declare const PONZU_POSTHOG: { key: string; host: string; replay: string };
const BAKED_POSTHOG =
  typeof PONZU_POSTHOG === "object" ? PONZU_POSTHOG : { key: "", host: "", replay: "" };

/**
 * What session replay may show (docs/analytics.md, "Session replay"): `full`, everything a person
 * sees; `private`, the chrome and how it is used, with canvases, the thread and the composer
 * blocked or masked. `private` unless a build is told otherwise.
 */
export type ReplayMode = "full" | "private";

export interface PosthogConfig {
  /** The project token, `phc_…`: safe in client code. */
  key: string;
  /** The ingestion host's origin. */
  host: string;
  replay: ReplayMode;
}

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export interface Config {
  /**
   * `Ponzu`, `Ponzu Dev` or `Ponzu Local`: the name the data folder, keychain item ("Ponzu Dev
   * Safe Storage") and instance lock go by.
   */
  appName: string;
  apiUrl: string;
  /** The WorkOS environment's client id: public, the app ships it. Staging until cutover. */
  workosClientId: string;
  /**
   * The origins the window may reach beyond the API: Neon Realtime and a canvas's files, as the
   * API's environment names them. Null in a development build, which may reach any of each kind.
   */
  realtimeUrl: string | null;
  assetsUrl: string | null;
  /** Vite's dev server, when a development build loads the studio from it. */
  studioDevUrl: string | null;
  /**
   * `ponzu`, or Ponzu Dev's `ponzu-dev`, so it never takes an installed Ponzu's links. Null for
   * Ponzu Local, which takes none: on a Mac it runs inside node_modules' Electron.app, which can't
   * declare a scheme, and a scheme of its own elsewhere would only differ from the Mac's.
   */
  linkScheme: LinkScheme | null;
  /** Whether this build removes what Ponzu 1.x left on the computer (legacy.ts): a release only. */
  cleansUpLegacy: boolean;
  /** Whether this build looks for updates of itself: a release only, the one with a feed. */
  updates: boolean;
  /** A developer's saved session to run on instead of the keychain (session-file.ts). */
  sessionFile: string | null;
  /** Whether a remote debugging port may be opened on this build's windows. */
  remoteDebugging: boolean;
  /**
   * The PostHog project this build reports to, or null: no key, a test build, or a key or host
   * that doesn't parse. The person's own choice (telemetry-consent.ts) is applied on top.
   */
  posthog: PosthogConfig | null;
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
  baked: { key: string; host: string; replay: string } = BAKED_POSTHOG,
): Config {
  // A test build is the real app with two doors a developer's tools need, and nothing else.
  const developer = { sessionFile: env.PONZU_SESSION_FILE || null, remoteDebugging: true };
  if (packaged) {
    // A packaged build reports to the project it was built for; a test build, which spare and CI
    // drive, to none.
    const posthog = test ? null : posthogFrom(baked.key, baked.host, baked.replay);
    const release = of === "release";
    return {
      // Ponzu Dev is the release in all but who it is: it never touches Ponzu 1.x (its folders,
      // its keychain item, its ponzu:// links), and with no feed of its own it never updates.
      appName: release ? APP_NAMES.release : APP_NAMES.dev,
      apiUrl: API_URL,
      workosClientId: WORKOS_CLIENT_ID,
      realtimeUrl: REALTIME_URL,
      assetsUrl: ASSETS_URL,
      studioDevUrl: null,
      linkScheme: release ? "ponzu" : "ponzu-dev",
      cleansUpLegacy: release,
      updates: release,
      ...(test ? developer : { sessionFile: null, remoteDebugging: false }),
      posthog,
    };
  }
  return {
    // A run from a checkout: neither installed app, so it never shares their folder, keychain
    // item or lock, and an installed Ponzu Dev can run beside it.
    appName: APP_NAMES.local,
    apiUrl: localOrHttps(env.PONZU_API_URL) ?? API_URL,
    workosClientId: env.PONZU_WORKOS_CLIENT_ID || WORKOS_CLIENT_ID,
    realtimeUrl: null,
    assetsUrl: null,
    studioDevUrl: localOrHttps(env.PONZU_STUDIO_URL),
    linkScheme: null,
    cleansUpLegacy: false,
    updates: false,
    ...developer,
    // A developer may point a development build at a project of their own, or at a local sink.
    posthog: posthogFrom(
      env.PONZU_POSTHOG_KEY || baked.key,
      env.PONZU_POSTHOG_HOST || baked.host,
      env.PONZU_POSTHOG_REPLAY || baked.replay,
    ),
  };
}

/** A project token and host that parse, or null: nothing is half switched on. */
export function posthogFrom(key: string, host: string, replay: string): PosthogConfig | null {
  if (!/^phc_[A-Za-z0-9_-]+$/.test(key.trim())) return null;
  const origin = localOrHttps(host.trim() || DEFAULT_POSTHOG_HOST);
  if (!origin) return null;
  return { key: key.trim(), host: origin, replay: replay.trim() === "full" ? "full" : "private" };
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
 * compiled it. A bundle named "Ponzu Dev" running a release's main process would take Ponzu's
 * folder and clean up 1.x, so a mismatch stops it before anything reads either.
 * `bundleName` is `app.name` before the app renames itself: the bundle's productName.
 */
export function bundleMismatch(
  packaged: boolean,
  bundleName: string,
  config: Config,
): string | null {
  if (!packaged || bundleName === config.appName) return null;
  return `This app is "${bundleName}", but its main process was built for "${config.appName}". Build it again with its own command (bun run package:dir, or bun run package:dev).`;
}

/**
 * Whether this build claims its link scheme as the system's default at launch. A packaged app
 * does, for the scheme its bundle declares (Info.plist on a Mac, the .desktop file on Linux).
 * Ponzu Local has no scheme to claim. The smoke check claims nothing: registering writes the
 * person's LaunchServices or xdg settings, and would make a copy in a build folder the one their
 * links open.
 */
export function claimsScheme(config: Pick<Config, "linkScheme">, smoke: boolean): boolean {
  return !smoke && config.linkScheme !== null;
}
