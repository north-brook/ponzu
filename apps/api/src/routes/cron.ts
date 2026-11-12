import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { sweepInstallations } from "../github/installations.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { runDueJobs } from "../jobs/run.ts";
import { sweepSandboxes } from "../sandboxes/sweep.ts";

/** How many installations each run reads again from GitHub (`sweepInstallations`). */
const SWEEP_LIMIT = 5;

const CronRun = z.object({
  ran: z.number(),
  abandoned: z.number(),
  swept: z.number(),
  sandboxes: z.record(z.string(), z.number()),
});

/** Whether `header` is `Bearer <secret>`, compared in constant time. */
function isCron(secret: string, header: string | undefined): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${secret}`));
}

export const cron = new Hono<AppEnv>()
  /**
   * Vercel's cron, every minute (`vercel.json`), on production only. Vercel sends the project's
   * `CRON_SECRET` as the bearer, which is the only thing that opens this route. Runs may
   * overlap; each part takes only what nobody else holds.
   */
  .get("/minute", access.public, async (c) => {
    const { deps } = c.var;
    if (!isCron(deps.config.cronSecret, c.req.header("authorization"))) {
      throw new ApiError(401, "unauthenticated", "Only the scheduler runs this.");
    }
    const run = { ...deps, log: c.var.log };
    const jobs = await runDueJobs(run, `cron:${c.var.requestId}`);
    // The sandbox sweep's reconcile also removes the sandboxes of sign-ins that are over.
    const [swept, sandboxes] = await Promise.all([
      sweepInstallations(run, { limit: SWEEP_LIMIT }),
      sweepSandboxes(run),
    ]);
    const ran = { ...jobs, swept, sandboxes };
    c.var.log.info("cron_ran", ran);
    return c.json(CronRun.parse(ran));
  });
