import { countAppliedMigrations, EXPECTED_MIGRATIONS, pingDb } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { ENVIRONMENTS } from "../env.ts";
import type { AppEnv } from "../http/context.ts";

const Health = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  /** The commit this deployment was built from, when the build knew it. */
  commit: z.string().nullable(),
  /** Which environment this deployment is (PONZU_ENVIRONMENT). */
  environment: z.enum(ENVIRONMENTS),
  /** The image every sandbox runs: apps/runner/image/current.json's `ponzu-runner@sha256:…`. */
  image: z.string(),
  /**
   * The first 12 hex of the runner bundle's SHA-256, or null when this process has no bundle
   * (`bun run dev` before the runner is built). A deployment always has one: the build inlines it.
   */
  runnerBundle: z.string().nullable(),
  /**
   * How many migrations the database has applied (null when it could not be asked) and how many
   * this build's journal lists. They differ when a deploy ran ahead of its migration, or after it.
   */
  migrations: z.object({ applied: z.number().int().nullable(), expected: z.number().int() }),
  database: z.boolean(),
});

const DATABASE_TIMEOUT_MS = 3_000;

/** What `work` gave before `signal` aborted, or undefined. Never throws. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
    work.then(resolve, () => resolve(undefined));
  });
}

/** The bundle's short hash, or null when there is none to read. Never throws. */
function bundleHash(read: () => { sha256: string }): string | null {
  try {
    return read().sha256.slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * `/v1/health`: what is deployed, where, and whether it can reach its database and has every
 * migration it was built for. 503 when the database cannot be reached; `degraded` at 200 when it
 * can but the applied migrations are not the journal's.
 */
export const health = new Hono<AppEnv>().get("/", access.public, async (c) => {
  const { db, clock, config, runnerBundle } = c.var.deps;
  const deadline = clock.timeout(DATABASE_TIMEOUT_MS);
  const [reached, applied] = await Promise.all([
    within(
      pingDb(db).then(() => true),
      deadline,
    ),
    within(countAppliedMigrations(db), deadline),
  ]);
  const database = reached === true;
  const migrations = { applied: applied ?? null, expected: EXPECTED_MIGRATIONS };
  const body = Health.parse({
    status: database && migrations.applied === migrations.expected ? "ok" : "degraded",
    version: config.build.version,
    commit: config.build.commit,
    environment: config.build.environment,
    image: config.sandbox.image,
    runnerBundle: bundleHash(runnerBundle),
    migrations,
    database,
  });
  return c.json(body, database ? 200 : 503);
});
