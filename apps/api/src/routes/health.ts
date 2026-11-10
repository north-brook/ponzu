import { pingDb } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";

const Health = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  /** The commit this deployment was built from, when the build knew it. */
  commit: z.string().nullable(),
  database: z.boolean(),
});

const DATABASE_TIMEOUT_MS = 3_000;

/** Whether `work` finished before `signal` aborted. Never throws. */
function finishes(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
    work.then(
      () => resolve(true),
      () => resolve(false),
    );
  });
}

/** `/v1/health`: what is deployed, and whether it can reach its database. 503 when it cannot. */
export const health = new Hono<AppEnv>().get("/", access.public, async (c) => {
  const { db, clock, config } = c.var.deps;
  const database = await finishes(pingDb(db), clock.timeout(DATABASE_TIMEOUT_MS));
  const body = Health.parse({
    status: database ? "ok" : "degraded",
    version: config.build.version,
    commit: config.build.commit,
    database,
  });
  return c.json(body, database ? 200 : 503);
});
