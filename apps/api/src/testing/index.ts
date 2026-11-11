import type { Db } from "@ponzu/db";
import { createTestDb } from "@ponzu/db/testing";
import { FakeClock, FakeProvider } from "@ponzu/sandbox";
import { createApp } from "../create-app.ts";
import { createBackground } from "../deps/background.ts";
import { createGithub } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import type { RealtimeSealer } from "../deps/realtime.ts";
import type { ObjectStorage } from "../deps/storage.ts";
import { createWorkos } from "../deps/workos.ts";
import { DocCache } from "../designs/doc-cache.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { createLogger, type LogLine } from "../http/log.ts";
import { GitTokens } from "../runner/git-credential.ts";
import { createVault } from "../vault/vault.ts";
import { FakeGithub, type FakeGithubUser } from "./fake-github.ts";
import { FakeWorkos, type FakeWorkosUser } from "./fake-workos.ts";
import { FakePoke, FakeSealer, MemoryStorage } from "./fakes.ts";

export { FakeGithub, type FakeInstallation, type FakeRepository } from "./fake-github.ts";
export { FakeWorkos } from "./fake-workos.ts";
export { FakePoke, FakeSealer, MemoryStorage } from "./fakes.ts";

/** 32 bytes of nothing secret, in base64url: the vault key every test app seals with. */
export const TEST_VAULT_KEY = Buffer.alloc(32, 7).toString("base64url");
/** What the test app's cron route takes as its bearer token. */
export const TEST_CRON_SECRET = "test_cron_secret_".padEnd(40, "x");
/** Where the test app says design files are served from. */
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
 * WorkOS and GitHub served from memory through the API's real clients, the in-memory sandbox
 * provider, storage and sealer, and a clock that moves only when the test moves it. Nothing a
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
  const clock = new FakeClock();
  const workos = new FakeWorkos(clock);
  const github = new FakeGithub(clock);
  const sandbox = new FakeProvider(clock);
  const storage = new MemoryStorage(clock);
  const poke = new FakePoke();
  const sealer = new FakeSealer(clock);
  /** Every line the app logged, oldest first. */
  const logs: LogLine[] = [];
  let requests = 0;
  const log = createLogger((line) => logs.push(line));
  const background: Promise<void>[] = [];

  const deps: Deps = {
    db,
    clock,
    ids: { requestId: () => `req_test_${++requests}` },
    log,
    background: createBackground(log, (work) => background.push(work)),
    vault: createVault({ key: TEST_VAULT_KEY }),
    workos: createWorkos({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      fetch: workos.fetch,
      clock,
    }),
    github: createGithub({ ...github.credentials, fetch: github.fetch, clock }),
    sandbox,
    storage: options.storage ?? storage,
    poke: poke.poke,
    realtime: options.live?.realtime ?? sealer,
    docs: new DocCache(),
    gitTokens: new GitTokens(),
    config: {
      build: { version: "0.0.0-test", commit: options.commit ?? "testcommit" },
      minimumClientVersions: options.minimumClientVersions ?? {},
      assetsUrl: options.assetsUrl ?? TEST_ASSETS_URL,
      githubApp: {
        slug: "ponzu-test",
        webhookSecret: github.credentials.webhookSecret,
        botUserId: TEST_BOT_USER_ID,
      },
      cronSecret: TEST_CRON_SECRET,
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
    sandbox,
    storage,
    poke,
    realtime: sealer,
    logs,
    startSignIn,
    signInAs,
    backgroundDone,
    close: async () => {
      await local?.$client.close();
    },
  };
}
