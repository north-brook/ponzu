import { createDb, type Db } from "@ponzu/db";
import { BoatProvider, type Clock, type SandboxProvider, systemClock } from "@ponzu/sandbox";
import manifest from "../../package.json" with { type: "json" };
import type { Env } from "../env.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { consoleSink, createLogger, type Logger } from "../http/log.ts";
import { createVault, type Vault } from "../vault/vault.ts";
import type { Fetch } from "./fetch.ts";
import { createGithub, type Github } from "./github.ts";
import { type RealtimeSealer, realtimeNotBuilt } from "./realtime.ts";
import { type ObjectStorage, storageNotBuilt } from "./storage.ts";
import { createWorkos, type Workos } from "./workos.ts";

/**
 * Everything the API reaches outside its own code. It is made once, here, and handed down:
 * a handler reads `c.var.deps`, and a function below a handler takes the parts it uses as an
 * argument. Nothing imports a client, a clock or the database as a module-level value, which
 * is what lets `createTestApp` run the whole app on fakes.
 */
export interface Deps {
  db: Db;
  clock: Clock;
  ids: Ids;
  log: Logger;
  vault: Vault;
  workos: Workos;
  github: Github;
  sandbox: SandboxProvider;
  /** Interface only until the assets module. */
  storage: ObjectStorage;
  /** Interface only until the live-query module. */
  realtime: RealtimeSealer;
  config: Config;
}

/** Settings a route may need, already read from the environment. */
export interface Config {
  /** What `/v1/health` reports about this build. */
  build: { version: string; commit: string | null };
  minimumClientVersions: MinimumVersions;
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

/** The real thing, for a deployment or `bun run dev`. */
export function createDeps(env: Env): Deps {
  const clock = systemClock;
  const outbound: Fetch = (url, init) => fetch(url, init);
  return {
    db: createDb(env.databaseUrl),
    clock,
    ids: randomIds,
    log: createLogger(consoleSink),
    vault: createVault(env.vault),
    workos: createWorkos({ ...env.workos, fetch: outbound, clock }),
    github: createGithub({ ...env.githubApp, fetch: outbound, clock }),
    sandbox: new BoatProvider({ apiKey: env.boatApiKey, clock }),
    storage: storageNotBuilt,
    realtime: realtimeNotBuilt,
    config: {
      build: { version: VERSION, commit: env.commit },
      minimumClientVersions: env.minimumClientVersions,
    },
  };
}
