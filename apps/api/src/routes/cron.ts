import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { runCronSteps } from "../cron/steps.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { runSelfcheck, SELFCHECK_DETAILS, SELFCHECK_IDS } from "../ops/selfcheck.ts";

/** Each step that ran, by name, with the counts it answered (`cron/steps.ts`). */
const CronRun = z.object({
  steps: z.record(z.string(), z.record(z.string(), z.number())),
});

/** Every check the selfcheck made, each answered in its fixed words (`ops/selfcheck.ts`). */
const Selfcheck = z.object({
  checks: z.array(
    z.object({
      id: z.enum(SELFCHECK_IDS),
      ok: z.boolean(),
      detail: z.enum(SELFCHECK_DETAILS),
      count: z.number().int().optional(),
      missing: z.array(z.string()).optional(),
    }),
  ),
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
  })
  /**
   * The API's own checks of its dependencies and settings (`ops/selfcheck.ts`), on demand: what
   * `scripts/prod/check.ts` and a person with the cron secret ask. Behind the same bearer as
   * `/minute`. It answers 200 with every check, whether or not each passed, and raises nothing:
   * the hourly cron step is what alarms.
   */
  .get("/selfcheck", access.public, async (c) => {
    const { deps } = c.var;
    if (!isCron(deps.config.cronSecret, c.req.header("authorization"))) {
      throw new ApiError(401, "unauthenticated", "Only the scheduler runs this.");
    }
    const checks = await runSelfcheck({ ...deps, log: c.var.log });
    return c.json(Selfcheck.parse({ checks }));
  });
