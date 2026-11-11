import { createDb, type Db } from "@ponzu/db";
import { BoatProvider, type Clock, type SandboxProvider, systemClock } from "@ponzu/sandbox";
import manifest from "../../package.json" with { type: "json" };
import { DocCache } from "../designs/doc-cache.ts";
import type { Env } from "../env.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { consoleSink, createLogger, type Logger } from "../http/log.ts";
import { GitTokens } from "../runner/git-credential.ts";
import { createVault, type Vault } from "../vault/vault.ts";
import { type Background, createBackground, waitUntil } from "./background.ts";
import type { Fetch } from "./fetch.ts";
import { createGithub, type Github } from "./github.ts";
import { createPoke, type Poke } from "./poke.ts";
import { createRealtimeSealer, type RealtimeSealer } from "./realtime.ts";
import { createR2Storage, type ObjectStorage } from "./storage.ts";
import { createWorkos, type Workos } from "./workos.ts";

/**
 * Everything the API reaches outside its own code. It is made once, here, and handed down:
 * a handler reads `c.var.deps`, and a function below a handler takes the parts it uses as an
 * argument. Nothing imports a client, a clock or the database as a module-level value, which
 * is what lets `createTestApp` run the whole app on fakes.
 */
export interface Deps {
  /**
   * Neon over HTTP: one statement per call and no transactions (`db.transaction` throws, in
   * tests too). Every statement has `DATABASE_TIMEOUT_MS` to answer.
   */
  db: Db;
  clock: Clock;
  ids: Ids;
  log: Logger;
  background: Background;
  vault: Vault;
  workos: Workos;
  github: Github;
  sandbox: SandboxProvider;
  /** Cloudflare R2: the bytes of designs' files, previews and exports. */
  storage: ObjectStorage;
  /** Tells an awake runner there may be events to claim. */
  poke: Poke;
  realtime: RealtimeSealer;
  /** The design documents this instance has built lately. */
  docs: DocCache;
  /** The git tokens this instance hands runners, kept while they may be reused. */
  gitTokens: GitTokens;
  config: Config;
}

/** Settings a route may need, already read from the environment. */
export interface Config {
  /** What `/v1/health` reports about this build. */
  build: { version: string; commit: string | null };
  minimumClientVersions: MinimumVersions;
  /** Where design files are served from; a design's are under `<assetsUrl>/<asset key>/`. */
  assetsUrl: string;
  /**
   * The GitHub App's slug, where installs begin, the secret its webhooks are signed with, and
   * the user id of its bot, who commits are committed by.
   */
  githubApp: { slug: string; webhookSecret: string; botUserId: number };
  /** What the scheduler's requests carry (`routes/cron.ts`). */
  cronSecret: string;
}

/** Ids the API makes itself. Rows get theirs from `@ponzu/db`. */
export interface Ids {
  requestId(): string;
}

export const randomIds: Ids = {
  requestId: () => `req_${crypto.randomUUID().replaceAll("-", "")}`,
};

/** The API's own version: what Release Please last wrote to its manifest. */
export const VERSION = manifest.version;

/**
 * How long the database has to answer one statement, the same as WorkOS and GitHub get. A
 * statement that runs out fails as 503 `database_unavailable`. Without this the wait is
 * Node's own, five minutes, which is also as long as the function may run.
 */
export const DATABASE_TIMEOUT_MS = 10_000;

/** The real thing, for a deployment or `bun run dev`. */
export function createDeps(env: Env): Deps {
  const clock = systemClock;
  const outbound: Fetch = (url, init) => fetch(url, init);
  const log = createLogger(consoleSink);
  return {
    db: createDb(env.databaseUrl, { deadline: () => clock.timeout(DATABASE_TIMEOUT_MS) }),
    clock,
    ids: randomIds,
    log,
    background: createBackground(log, waitUntil),
    vault: createVault(env.vault),
    workos: createWorkos({ ...env.workos, fetch: outbound, clock }),
    github: createGithub({
      clientId: env.githubApp.clientId,
      clientSecret: env.githubApp.clientSecret,
      privateKey: env.githubApp.privateKey,
      fetch: outbound,
      clock,
    }),
    sandbox: new BoatProvider({ apiKey: env.boatApiKey, clock }),
    storage: createR2Storage({ ...env.r2, fetch: outbound, clock }),
    poke: createPoke({ fetch: outbound, clock }),
    realtime: createRealtimeSealer({
      ...env.realtime,
      database: new URL(env.databaseUrl).pathname.slice(1),
    }),
    docs: new DocCache(),
    gitTokens: new GitTokens(),
    config: {
      build: { version: VERSION, commit: env.commit },
      minimumClientVersions: env.minimumClientVersions,
      assetsUrl: env.assetsUrl,
      githubApp: {
        slug: env.githubApp.slug,
        webhookSecret: env.githubApp.webhookSecret,
        botUserId: env.githubApp.botUserId,
      },
      cronSecret: env.cronSecret,
    },
  };
}
