import type { Db } from "@ponzu/db";
import { createTestDb } from "@ponzu/db/testing";
import type { RunnerBundle } from "@ponzu/runner/bundle";
import { FakeClock, FakeSandboxes } from "@ponzu/sandbox";
import { createAnalytics } from "../analytics/analytics.ts";
import type { PosthogConfig } from "../analytics/posthog.ts";
import { DocCache } from "../canvases/doc-cache.ts";
import { createApp } from "../create-app.ts";
import { createBackground } from "../deps/background.ts";
import { createGithub } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { CLAUDE_SONNET } from "../deps/model.ts";
import type { RateLimit } from "../deps/rate-limit.ts";
import type { RealtimeSealer } from "../deps/realtime.ts";
import type { ObjectStorage } from "../deps/storage.ts";
import { createWorkos } from "../deps/workos.ts";
import type { SandboxConfig } from "../env.ts";
import { FEATURES_OFF, type Features } from "../features.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { createLogger, type LogLine } from "../http/log.ts";
import { GitTokens } from "../runner/git-credential.ts";
import { createVault } from "../vault/vault.ts";
import { MemoryAnalytics } from "./fake-analytics.ts";
import { FakeGithub, type FakeGithubUser } from "./fake-github.ts";
import { FakeModel } from "./fake-model.ts";
import { FakePush } from "./fake-push.ts";
import { FakeRateLimit } from "./fake-rate-limit.ts";
import { FakeWorkos, type FakeWorkosUser } from "./fake-workos.ts";
import { FakeAnthropic, FakePoke, FakeSealer, MemoryStorage } from "./fakes.ts";

export { type CapturedEvent, MemoryAnalytics } from "./fake-analytics.ts";
export { FakeGithub, type FakeInstallation, type FakeRepository } from "./fake-github.ts";
export {
  FAKE_IDEAS,
  FakeModel,
  type FakeReply,
  PASSING_VERDICT,
  verdict,
} from "./fake-model.ts";
export {
  type FakePull,
  type FakeRepoAccess,
  MERGEABLE_AFTER_MS,
} from "./fake-pull-requests.ts";
export { FakePush } from "./fake-push.ts";
export { FakeRateLimit } from "./fake-rate-limit.ts";
export { FakeWorkos } from "./fake-workos.ts";
export { FakeAnthropic, FakePoke, FakeSealer, MemoryStorage } from "./fakes.ts";

/** The image the test app's sandboxes run, as current.json names one. */
export const TEST_IMAGE = `ponzu-runner@sha256:${"a".repeat(64)}`;
/** The runner bundle the test app serves and names at every start. */
export const TEST_BUNDLE: RunnerBundle = {
  sha256: "b".repeat(64),
  requires: { claude: "2.1.322", playwrightCore: "1.64.1" },
  tgz: Buffer.from("not really a tgz").toString("base64"),
};
/** Where the test app tells a sandbox's runner the API is. */
export const TEST_API_URL = "https://api.test";
/** The scope the test app's sandbox names carry (`pz-<scope>-…`): its database's, as a deployment's would. */
export const TEST_SCOPE = "7e57000000a0";

/** 32 bytes of nothing secret, in base64url: the vault key every test app seals with. */
export const TEST_VAULT_KEY = Buffer.alloc(32, 7).toString("base64url");
/** What the test app's cron route takes as its bearer token. */
export const TEST_CRON_SECRET = "test_cron_secret_".padEnd(40, "x");
/** Where the test app says canvases' files are served from. */
export const TEST_ASSETS_URL = "https://assets.test";
/** The test App's bot, who commits are committed by. */
export const TEST_BOT_USER_ID = 9_000_001;

/** Someone to sign in as. Everything has a default; `login` is what tells two people apart. */
export interface Person {
  login: string;
  name: string | null;
  email: string;
  /** Whether WorkOS already counts the email as verified. A first sign-in never does. */
  emailVerifiedAtWorkos: boolean;
  /** Whether GitHub says the email is verified. */
  emailVerifiedAtGithub: boolean;
  /** False to act out WorkOS not handing GitHub's tokens back. */
  returnsGithubTokens: boolean;
}

/** The browser half of a sign-in, finished: what an app would now post to `/v1/auth/exchange`. */
export interface StartedSignIn {
  code: string;
  codeVerifier: string;
  github: FakeGithubUser;
  workos: FakeWorkosUser;
}

/** A person who has signed in through the real exchange route. */
export interface SignedInPerson {
  /** Spread into a request: `app.request("/v1/me", { headers: person.headers })`. */
  headers: { authorization: string };
  /** The person's id in the database (`usr_…`). */
  userId: string;
  accessToken: string;
  refreshToken: string;
  github: FakeGithubUser;
  workos: FakeWorkosUser;
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/**
 * The real app on an in-process Postgres, with a fake for everything outside the process:
 * WorkOS and GitHub served from memory through the API's real clients, Vercel's sandboxes in
 * memory (`FakeSandboxes`), storage and sealer, and a clock that moves only when the test moves it. Nothing a
 * test does through this can reach the network: no part of it holds the real `fetch`.
 *
 * Call the app with `app.request(path, init)` so routing, validation, auth and serialization
 * all run. Close it with `close()` when the file is done.
 */
export async function createTestApp(
  options: {
    minimumClientVersions?: MinimumVersions;
    commit?: string | null;
    /**
     * A real database and Realtime, for an opt-in test against the Neon `dev` branch. Without
     * them everything stays in this process.
     */
    live?: { db: Db; realtime: RealtimeSealer };
    /** Real storage and where it serves from, for an opt-in test against the R2 bucket. */
    storage?: ObjectStorage;
    assetsUrl?: string;
    /** How sandboxes are made, over the test's own. */
    sandbox?: Partial<SandboxConfig>;
    /**
     * Another test app's sandboxes and clock, to act out two deployments sharing one Vercel
     * project. Give each its own `sandbox.scope`.
     */
    shared?: { sandboxes: FakeSandboxes; clock: FakeClock };
    /** What the runner is told to report its turns to PostHog with; none by default. */
    posthog?: PosthogConfig;
    /** False to run with push off, as a deployment without EXPO_ACCESS_TOKEN does. On by default. */
    push?: boolean;
    /** Rate limits other than the fake's, such as the real seam on a scripted SDK call. */
    rateLimit?: RateLimit;
    /**
     * Feature switches over the defaults, which are every switch off as in an environment that
     * sets none, except `push`, which follows the option above.
     */
    features?: Partial<Features>;
  } = {},
) {
  const local = options.live ? null : await createTestDb();
  const db: Db = options.live?.db ?? local!;
  // The deployed API reaches Postgres over Neon's HTTP driver, which has no transactions.
  // PGlite has them, so a route that used one would pass here and fail in production; this
  // makes it fail here, the way that driver does.
  db.transaction = () => {
    throw new Error("No transactions support in neon-http driver");
  };
  const clock = options.shared?.clock ?? new FakeClock();
  const workos = new FakeWorkos(clock);
  const github = new FakeGithub(clock);
  const sandboxes = options.shared?.sandboxes ?? new FakeSandboxes(clock);
  const anthropic = new FakeAnthropic();
  const storage = new MemoryStorage(clock);
  const poke = new FakePoke();
  const sealer = new FakeSealer(clock);
  const model = new FakeModel();
  const reviewer = new FakeModel(CLAUDE_SONNET);
  const push = new FakePush({ enabled: options.push ?? true });
  const rateLimit = new FakeRateLimit(clock);
  /** Every line the app logged, oldest first. */
  const logs: LogLine[] = [];
  let requests = 0;
  const log = createLogger((line) => logs.push(line));
  const background: Promise<void>[] = [];
  const keep = (work: Promise<void>) => background.push(work);
  const analytics = new MemoryAnalytics();
  const tracked = createAnalytics({ sink: analytics, keep, log });

  const deps: Deps = {
    db,
    clock,
    ids: { requestId: () => `req_test_${++requests}` },
    log,
    analytics: tracked,
    background: createBackground(log, keep, (name, error) =>
      tracked.exception(error, { background: name }),
    ),
    vault: createVault({ key: TEST_VAULT_KEY }),
    workos: createWorkos({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      fetch: workos.fetch,
      clock,
    }),
    github: createGithub({ ...github.credentials, fetch: github.fetch, clock }),
    sandboxes,
    runnerBundle: () => TEST_BUNDLE,
    anthropic,
    storage: options.storage ?? storage,
    archives: options.storage ?? storage,
    poke: poke.poke,
    realtime: options.live?.realtime ?? sealer,
    model,
    reviewer,
    docs: new DocCache(),
    gitTokens: new GitTokens(),
    push,
    rateLimit: options.rateLimit ?? rateLimit,
    features: { ...FEATURES_OFF, push: options.push ?? true, ...options.features },
    config: {
      build: { version: "0.0.0-test", commit: options.commit ?? "testcommit" },
      minimumClientVersions: options.minimumClientVersions ?? {},
      assetsUrl: options.assetsUrl ?? TEST_ASSETS_URL,
      posthog: options.posthog ?? null,
      githubApp: {
        slug: "ponzu-test",
        webhookSecret: github.credentials.webhookSecret,
        botUserId: TEST_BOT_USER_ID,
      },
      cronSecret: TEST_CRON_SECRET,
      sandbox: {
        image: TEST_IMAGE,
        apiUrl: TEST_API_URL,
        idleSeconds: 300,
        // Higher than a deployment's, since a test file keeps many canvases awake at once.
        limits: { perWorkspace: 100, perOwner: 100 },
        scope: TEST_SCOPE,
        vercel: null,
        ...options.sandbox,
      },
    },
  };
  const app = createApp(deps);

  const people = new Map<string, { github: FakeGithubUser; workos: FakeWorkosUser }>();
  let nextGithubId = 1001;

  /** The person behind `login` at both services, made on first mention. */
  function person(who: Person) {
    const known = people.get(who.login);
    if (known) {
      // The API deleted their WorkOS user (it vouched for the address and then turned them
      // away). WorkOS makes a new one when they come back, unverified like any new user.
      if (!workos.hasUser(known.workos.id)) {
        known.workos = workos.addUser({ email: known.workos.email, emailVerified: false });
      }
      return known;
    }
    const made = {
      github: github.addUser({
        id: nextGithubId++,
        login: who.login,
        name: who.name,
        avatarUrl: `https://avatars.example/${who.login}`,
        emails: [{ email: who.email, primary: true, verified: who.emailVerifiedAtGithub }],
      }),
      workos: workos.addUser({ email: who.email, emailVerified: who.emailVerifiedAtWorkos }),
    };
    people.set(who.login, made);
    return made;
  }

  /**
   * Everything a sign-in does before the app calls the API: the person exists at GitHub and
   * WorkOS, and the browser has come back with a code. Post the result to
   * `/v1/auth/exchange` yourself to test the exchange; otherwise use `signInAs`.
   */
  async function startSignIn(who: Partial<Person> = {}): Promise<StartedSignIn> {
    const login = who.login ?? "bryce";
    const full: Person = {
      login,
      name: login[0]!.toUpperCase() + login.slice(1),
      email: `${login}@example.com`,
      emailVerifiedAtWorkos: true,
      emailVerifiedAtGithub: true,
      returnsGithubTokens: true,
      ...who,
    };
    const identity = person(full);
    const codeVerifier = `verifier-${login}-`.padEnd(43, "x");
    const code = await workos.authorize(identity.workos.id, {
      codeVerifier,
      oauthTokens: full.returnsGithubTokens ? github.issueTokens(identity.github.id) : null,
    });
    return { code, codeVerifier, ...identity };
  }

  /**
   * Signs a person in through the real `POST /v1/auth/exchange`, so their row and their
   * stored GitHub token exist exactly as a real sign-in leaves them, and waits for the sync
   * with GitHub the sign-in starts. Signing the same login in again is the same person with a
   * new session.
   */
  async function signInAs(who: Partial<Person> = {}): Promise<SignedInPerson> {
    const started = await startSignIn(who);
    const response = await app.request("/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code, code_verifier: started.codeVerifier }),
    });
    if (response.status !== 200) {
      throw new Error(
        `signInAs: the exchange answered ${response.status} ${await response.text()}`,
      );
    }
    const session = (await response.json()) as {
      user: { id: string };
      access_token: string;
      refresh_token: string;
    };
    await backgroundDone();
    return {
      headers: { authorization: `Bearer ${session.access_token}` },
      userId: session.user.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      github: started.github,
      workos: started.workos,
    };
  }

  /**
   * Waits for everything handed to `deps.background` so far, and for whatever that work
   * starts in turn. A failure in it does not throw here: it is a `background_failed` line in
   * `logs`, as in a deployment.
   */
  async function backgroundDone(): Promise<void> {
    while (background.length > 0) await background.shift();
  }

  return {
    app,
    deps,
    db,
    clock,
    workos,
    github,
    sandboxes,
    anthropic,
    storage,
    poke,
    realtime: sealer,
    model,
    reviewer,
    /** Every ping the app sent to a phone, and how Expo answers the next ones. */
    push,
    /** Every rate-limit check the app made, and the limits it counts to (none until a test sets one). */
    rateLimit,
    /** Every event, profile and exception the app captured, as PostHog would be handed them. */
    analytics,
    logs,
    startSignIn,
    signInAs,
    backgroundDone,
    close: async () => {
      await local?.$client.close();
    },
  };
}
