import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { recordCronRun } from "../cron/heartbeat.ts";
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

/**
 * How far from the clock the scheduler's own time for a run may be and still be the run's time.
 * Vercel starts a run up to a minute after its time (the jitter), so its time is within a minute
 * or so of ours. An occurrence delivered later than this, as when runs catch up after an outage,
 * is a run now: its slotted steps belong to the slot it runs in, not the one it missed.
 */
export const SCHEDULED_AT_WINDOW_MS = 2 * 60_000;

/** A full ISO 8601 time with its zone, as the scheduler sends it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The time a run is for: the scheduler's `ce-vssscheduledat` (the minute the expression
 * matched, without jitter; https://vercel.com/docs/schedules/handle-runs, "Request headers")
 * when it is a full ISO 8601 time within `SCHEDULED_AT_WINDOW_MS` of `clock`, else the clock.
 * So a run that started 40 seconds into its minute still does the steps due on that minute, and
 * one that started at :00:59 for :00 does not do :01's.
 */
export function runTimeOf(
  scheduledAt: string | undefined,
  clock: number,
): { now: Date; from: "schedule" | "clock" } {
  const at = scheduledAt && ISO_TIME.test(scheduledAt) ? Date.parse(scheduledAt) : Number.NaN;
  if (Number.isFinite(at) && Math.abs(clock - at) <= SCHEDULED_AT_WINDOW_MS) {
    return { now: new Date(at), from: "schedule" };
  }
  return { now: new Date(clock), from: "clock" };
}

/** Whether `header` is `Bearer <secret>`, compared in constant time. */
function isCron(secret: string, header: string | undefined): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${secret}`));
}

export const cron = new Hono<AppEnv>()
  /**
   * The minute's run: Vercel's schedule `minute` (`vercel.json`), in each environment that has it
   * turned on. Vercel sends the deployment's `CRON_SECRET` as the bearer, which is the only thing
   * that opens this route. Runs may overlap and may come late or twice; each step takes only
   * what nobody else holds, and a step on a slot runs once in it.
   *
   * A preview never runs anything here: it shares dev's database, and dev's own minute does
   * that work. It answers no steps, so a schedule turned on by mistake, or a person with the
   * secret, cannot make a throwaway build sweep dev.
   */
  .get("/minute", access.public, async (c) => {
    const { deps } = c.var;
    if (!isCron(deps.config.cronSecret, c.req.header("authorization"))) {
      throw new ApiError(401, "unauthenticated", "Only the scheduler runs this.");
    }
    if (deps.config.build.environment === "preview") {
      c.var.log.info("cron_skipped", { reason: "preview" });
      return c.json(CronRun.parse({ steps: {} }));
    }
    const clock = deps.clock.now();
    const { now, from } = runTimeOf(c.req.header("ce-vssscheduledat"), clock);
    // Before the steps, and on its own: a run that reached us counts as a run even when every
    // step fails, and a heartbeat that cannot be written holds no step up.
    await recordCronRun(deps.db, new Date(clock)).catch((error: unknown) => {
      c.var.log.error("cron_heartbeat_failed", { error });
    });
    const ran = await runCronSteps({ ...deps, log: c.var.log }, now);
    c.var.log.info("cron_ran", { ...ran, time: from });
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
