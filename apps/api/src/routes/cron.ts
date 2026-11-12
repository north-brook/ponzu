import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { runCronSteps } from "../cron/steps.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";

/** Each step that ran, by name, with the counts it answered (`cron/steps.ts`). */
const CronRun = z.object({
  steps: z.record(z.string(), z.record(z.string(), z.number())),
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
   * overlap; each step takes only what nobody else holds, and a step on a slot runs once in it.
   */
  .get("/minute", access.public, async (c) => {
    const { deps } = c.var;
    if (!isCron(deps.config.cronSecret, c.req.header("authorization"))) {
      throw new ApiError(401, "unauthenticated", "Only the scheduler runs this.");
    }
    const ran = await runCronSteps({ ...deps, log: c.var.log }, new Date(deps.clock.now()));
    c.var.log.info("cron_ran", ran);
    return c.json(CronRun.parse(ran));
  });
