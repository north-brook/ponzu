import { createDb, type Db } from "@ponzu/db";
import { BoatProvider, type Clock, type SandboxProvider, systemClock } from "@ponzu/sandbox";
import manifest from "../../package.json" with { type: "json" };
import { DocCache } from "../designs/doc-cache.ts";
import type { Env } from "../env.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { consoleSink, createLogger, type Logger } from "../http/log.ts";
import { createVault, type Vault } from "../vault/vault.ts";
import { type Background, createBackground, waitUntil } from "./background.ts";
import type { Fetch } from "./fetch.ts";
import { createGithub, type Github } from "./github.ts";
import { createRealtimeSealer, type RealtimeSealer } from "./realtime.ts";
import { type ObjectStorage, storageNotBuilt } from "./storage.ts";
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
  /** Interface only until the assets module. */
  storage: ObjectStorage;
  realtime: RealtimeSealer;
  /** The design documents this instance has built lately. */
  docs: DocCache;
  config: Config;
}

/** Settings a route may need, already read from the environment. */
export interface Config {
  /** What `/v1/health` reports about this build. */
  build: { version: string; commit: string | null };
  minimumClientVersions: MinimumVersions;
  /** Where design files are served from; a design's are under `<assetsUrl>/<asset key>/`. */
  assetsUrl: string;
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
    github: createGithub({ ...env.githubApp, fetch: outbound, clock }),
    sandbox: new BoatProvider({ apiKey: env.boatApiKey, clock }),
    storage: storageNotBuilt,
    realtime: createRealtimeSealer({
      ...env.realtime,
      database: new URL(env.databaseUrl).pathname.slice(1),
    }),
    docs: new DocCache(),
    config: {
      build: { version: VERSION, commit: env.commit },
      minimumClientVersions: env.minimumClientVersions,
      assetsUrl: env.assetsUrl,
    },
  };
}
