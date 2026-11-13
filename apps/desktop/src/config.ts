/*
 * Where this build talks to, and what it lets a developer do. A packaged build talks to the
 * environment scripts/build.ts baked into it from infra/environments.json, and nowhere else; a
 * test build may be pointed elsewhere at launch (PONZU_ENVIRONMENT_OVERRIDE); a development
 * build (`bun run start`) can be pointed elsewhere, and can load the studio from Vite's dev
 * server.
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
  /**
   * The environment this build talks to, as infra/environments.json names it (`dev`,
   * `production`), a test build's override's name, or `custom` for Ponzu Local pointed at an
   * API or sign-in of a developer's own. Every analytics event carries it.
   */
  environment: string;
  /** The commit the build was made from, in full, or `unknown`. */
  commit: string;
  apiUrl: string;
  /** The WorkOS environment's client id: public, the app ships it. */
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
   * Whether the studio runs on Ponzu Cloud in memory instead of the service (`fakeBackend`):
   * only a test build or a run from a checkout, given PONZU_FAKE_BACKEND=1. Never a release.
   */
  fakeBackend: boolean;
  /**
   * The PostHog project this build reports to, or null: no key, a test build, or a key or host
   * that doesn't parse. The person's own choice (telemetry-consent.ts) is applied on top.
   */
  posthog: PosthogConfig | null;
}

/**
 * Where a build talks to: one environment of infra/environments.json, which scripts/build.ts
 * bakes in (`bakeEnvironment`). Public values only. The window's policy allows exactly these
 * realtime and assets hosts (csp.ts).
 */
export interface BuildEnvironment {
  /** `dev` or `production`; a test build's override names its own. */
  name: string;
  apiUrl: string;
  /** The WorkOS environment's client id: public, the app ships it. */
  workosClientId: string;
  realtimeUrl: string;
  assetsUrl: string;
}

/** The fields of an environment a desktop build bakes in, as infra/environments.json names them. */
export const BAKED_FIELDS = ["apiUrl", "workosClientId", "realtimeUrl", "assetsUrl"] as const;
type BakedField = (typeof BAKED_FIELDS)[number];

/**
 * infra/environments.json as a build reads it: only what it bakes. scripts/build.ts hands it the
 * file as scripts/prod/desired.ts has checked it.
 */
export interface EnvironmentsFile {
  release: string;
  environments: Record<string, { [field in BakedField]: string | null }>;
}

/**
 * The environment a build of `of` bakes in: a release takes the one the file's `release` names
 * (production), Ponzu Dev always takes dev's. A field that is still
 * `null` (not created yet) fails the build, one line a field, so no build goes out half pointed
 * somewhere. The fields the app never reads (buckets, the Neon branch, the Vercel project) are
 * release.yml's to check (`desired.ts assert-release production`), not the build's.
 */
export function bakeEnvironment(file: EnvironmentsFile, of: Variant): BuildEnvironment {
  const name = of === "release" ? file.release : "dev";
  const chosen = file.environments[name];
  if (!chosen) throw new Error(`infra/environments.json has no environment "${name}"`);
  const missing = BAKED_FIELDS.filter((field) => typeof chosen[field] !== "string");
  if (missing.length) {
    throw new Error(
      missing.map((field) => `${name}.${field} is not set in infra/environments.json`).join("\n"),
    );
  }
  const value = (field: BakedField) => chosen[field] as string;
  return {
    name,
    apiUrl: value("apiUrl"),
    workosClientId: value("workosClientId"),
    realtimeUrl: value("realtimeUrl"),
    assetsUrl: value("assetsUrl"),
  };
}

/** Set by scripts/build.ts: the environment, and the commit the build was made from. */
declare const PONZU_ENVIRONMENT: BuildEnvironment;
declare const PONZU_COMMIT: string;

/** What scripts/build.ts compiled into this main process. */
export interface Build {
  test: boolean;
  variant: Variant;
  posthog: { key: string; host: string; replay: string };
  /** Null only when this module runs unbuilt and is handed none: `configFor` then refuses. */
  environment: BuildEnvironment | null;
  /** The full commit hash, or `unknown` when the build had none. */
  commit: string;
}

export const BAKED: Build = {
  test: testBuild,
  variant,
  posthog: BAKED_POSTHOG,
  environment: typeof PONZU_ENVIRONMENT === "object" ? PONZU_ENVIRONMENT : null,
  commit: typeof PONZU_COMMIT === "string" ? PONZU_COMMIT : "unknown",
};

/** What this app is, from what was baked into it (`BAKED`) and, as allowed, its environment. */
export function configFor(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
  build: Partial<Build> = {},
): Config {
  const { test, variant: of, posthog: baked, environment, commit } = { ...BAKED, ...build };
  if (!environment) {
    throw new Error(
      "This build has no environment: scripts/build.ts bakes one in from infra/environments.json.",
    );
  }
  // A test build is the real app with the doors a developer's tools need, and nothing else.
  const developer = {
    sessionFile: env.PONZU_SESSION_FILE || null,
    remoteDebugging: true,
    fakeBackend: fakeBackend(env),
  };
  if (packaged) {
    // A packaged build reports to the project it was built for; a test build, which spare and CI
    // drive, to none.
    const posthog = test ? null : posthogFrom(baked.key, baked.host, baked.replay);
    const release = of === "release";
    // Only a test build may be pointed elsewhere at launch. A release, or Ponzu Dev, talks to
    // what it was built for, whatever its environment says.
    const where = (test ? environmentOverride(env) : null) ?? environment;
    return {
      // Ponzu Dev is the release in all but who it is: it never touches Ponzu 1.x (its folders,
      // its keychain item, its ponzu:// links), and with no feed of its own it never updates.
      appName: release ? APP_NAMES.release : APP_NAMES.dev,
      environment: where.name,
      commit,
      apiUrl: where.apiUrl,
      workosClientId: where.workosClientId,
      realtimeUrl: where.realtimeUrl,
      assetsUrl: where.assetsUrl,
      studioDevUrl: null,
      linkScheme: release ? "ponzu" : "ponzu-dev",
      cleansUpLegacy: release,
      updates: release,
      ...(test ? developer : { sessionFile: null, remoteDebugging: false, fakeBackend: false }),
      posthog,
    };
  }
  const apiUrl = localOrHttps(env.PONZU_API_URL) ?? environment.apiUrl;
  const workosClientId = env.PONZU_WORKOS_CLIENT_ID || environment.workosClientId;
  const elsewhere = apiUrl !== environment.apiUrl || workosClientId !== environment.workosClientId;
  return {
    // A run from a checkout: neither installed app, so it never shares their folder, keychain
    // item or lock, and an installed Ponzu Dev can run beside it.
    appName: APP_NAMES.local,
    // Pointed at an API or sign-in of a developer's own, it is no environment infra/ names.
    environment: elsewhere ? "custom" : environment.name,
    commit,
    apiUrl,
    workosClientId,
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

/**
 * `PONZU_ENVIRONMENT_OVERRIDE`, which only a test build reads: a whole environment as JSON
 * (`{"name","apiUrl","workosClientId","realtimeUrl","assetsUrl"}`), for spare or CI to drive a
 * test build against a stack of its own. Unset, null: the baked one. Set but unusable, it throws,
 * so the app refuses to start rather than quietly talk to the baked environment instead.
 */
export function environmentOverride(env: NodeJS.ProcessEnv): BuildEnvironment | null {
  const raw = env.PONZU_ENVIRONMENT_OVERRIDE;
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PONZU_ENVIRONMENT_OVERRIDE is not JSON.");
  }
  const fields = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const text = (field: string) => (typeof fields[field] === "string" ? fields[field] : "");
  const name = text("name");
  const workosClientId = text("workosClientId");
  const apiUrl = localOrHttps(text("apiUrl"));
  const realtimeUrl = localOrHttps(text("realtimeUrl"));
  const assetsUrl = localOrHttps(text("assetsUrl"));
  const wrong = Object.entries({
    name: /^[a-z][a-z0-9-]*$/.test(name),
    apiUrl,
    workosClientId,
    realtimeUrl,
    assetsUrl,
  })
    .filter(([, ok]) => !ok)
    .map(([field]) => field);
  if (wrong.length || !apiUrl || !realtimeUrl || !assetsUrl) {
    throw new Error(`PONZU_ENVIRONMENT_OVERRIDE has no usable ${wrong.join(", ")}.`);
  }
  return { name, apiUrl, workosClientId, realtimeUrl, assetsUrl };
}

/**
 * `PONZU_FAKE_BACKEND=1`, which only a test build or a run from a checkout reads: the window
 * runs the studio on Ponzu Cloud in memory (apps/studio's fake host), apart from the person's
 * data, keychain, links and network (main.ts), so spare can measure the packaged app on a
 * canvas of its own without an account. The studio takes it only when it was built with the
 * fake in it (`--mode e2e`, or Vite's development server); a release's studio has none.
 */
export function fakeBackend(env: NodeJS.ProcessEnv): boolean {
  return env.PONZU_FAKE_BACKEND === "1";
}

/**
 * What the About panel says after the version, `abc1234 · production`, so a Mac's panel reads
 * "Version 2.0.0 (abc1234 · production)": the build, its commit and where it talks to.
 */
export function aboutVersion(config: Pick<Config, "commit" | "environment">): string {
  const commit = /^[0-9a-f]{7,40}$/.test(config.commit) ? config.commit.slice(0, 7) : "unknown";
  return `${commit} · ${config.environment}`;
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
