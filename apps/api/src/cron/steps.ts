import { recordOnce } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { archivesStep } from "./steps/archives.ts";
import { digestsStep } from "./steps/digests.ts";
import { installationsStep } from "./steps/installations.ts";
import { jobsStep } from "./steps/jobs.ts";
import { maintenanceStep } from "./steps/maintenance.ts";
import { pruneNotificationsStep } from "./steps/prune-notifications.ts";
import { pullRequestSweepStep } from "./steps/pull-request-sweep.ts";
import { recapsStep } from "./steps/recaps.ts";
import { receiptsStep } from "./steps/receipts.ts";
import { resolveQuestionsStep } from "./steps/resolve-questions.ts";
import { retentionStep } from "./steps/retention.ts";
import { sandboxesStep } from "./steps/sandboxes.ts";
import { searchBackfillStep } from "./steps/search-backfill.ts";
import { selfcheckStep } from "./steps/selfcheck.ts";

/*
 * What the minute's cron does (`routes/cron.ts`), as steps. A feature that needs the cron adds
 * one step file under `steps/` and one line to `CRON_STEPS`, and never edits the route.
 *
 * Every run does the due steps: `jobs` first, so a retry is not held up behind a slow sweep,
 * then the rest at once. Each step is on its own: one that throws is logged as
 * `cron_step_failed` and the others still run, and still answer.
 */

/** What a step is handed: everything the API has, with the run's own log. */
export type CronDeps = Deps;

export interface CronStep {
  /** Its name in the answer and the logs: lowercase words joined by `_`. */
  name: string;
  /**
   * Runs once in every slot of this many minutes, counted from each hour (10 is :00, :10,
   * :20…). With neither this nor `atMinute`: every minute, on every run.
   */
  everyMinutes?: number;
  /** Runs once an hour, at this minute past it (0 to 59). Wins over `everyMinutes`. */
  atMinute?: number;
  /**
   * Whether the step is on at all. A step that answers false is not run, records no slot and
   * is left out of the answer, so a feature that is off writes and answers nothing.
   */
  enabled?(run: CronDeps, now: Date): boolean;
  /**
   * Does the step's work, and answers counts of what it did. Runs may overlap, and a run may
   * be repeated, so the work must take only what nobody else holds.
   */
  run(run: CronDeps, now: Date): Promise<Record<string, number>>;
}

/** Every step, one line each. `jobs` is first and is run before the others. */
export const CRON_STEPS: readonly CronStep[] = [
  jobsStep,
  installationsStep,
  sandboxesStep,
  searchBackfillStep,
  receiptsStep,
  resolveQuestionsStep,
  pruneNotificationsStep,
  digestsStep,
  recapsStep,
  maintenanceStep,
  pullRequestSweepStep,
  archivesStep,
  selfcheckStep,
  retentionStep,
];

/**
 * How late a run may be and still do a slotted step whose time it missed: a step due at :00
 * still runs if Vercel's :00 run failed and its :01 run comes.
 */
const CATCH_UP_MINUTES = 5;

const MINUTE_MS = 60_000;

/** What a run answers: each step that ran, by name, with its counts. */
export type CronAnswer = { steps: Record<string, Record<string, number>> };

/**
 * Run the steps due at `now`. A step run every minute just runs; one on a slot (every few
 * minutes, or once an hour) runs in the first minutes of its slot, once: the first run to
 * record the slot (`recordOnce`) does it, and an overlapping or later run in the same slot
 * leaves it. A step that throws answers `{ failed: 1 }`.
 */
export async function runCronSteps(
  deps: CronDeps,
  now: Date,
  steps: readonly CronStep[] = CRON_STEPS,
): Promise<CronAnswer> {
  const answer: CronAnswer = { steps: {} };
  const runStep = async (step: CronStep) => {
    try {
      if (step.enabled && !step.enabled(deps, now)) return;
      const slot = slotOf(step, now);
      if (slot === "skip") return;
      if (
        slot &&
        !(await recordOnce(deps.db, { kind: "cron.step", key: `${step.name}@${slot}` }))
      ) {
        return;
      }
      answer.steps[step.name] = await step.run(deps, now);
    } catch (error) {
      deps.log.error("cron_step_failed", { step: step.name, error });
      deps.analytics.exception(error, { cron_step: step.name });
      answer.steps[step.name] = { failed: 1 };
    }
  };
  const [first, ...rest] = steps;
  if (first) await runStep(first);
  await Promise.all(rest.map(runStep));
  return answer;
}

/**
 * Whether `step` is due at `now`: null when it runs every minute, the start of its slot (an
 * ISO time, which names the slot) when it is in the first minutes of one, else "skip".
 */
export function slotOf(step: CronStep, now: Date): string | null | "skip" {
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  const hour = minute - (minute % 60);
  const past = minute - hour;
  let start: number;
  let length: number;
  if (step.atMinute !== undefined) {
    length = 60;
    // Before this hour's minute, the slot is last hour's.
    start = past >= step.atMinute ? hour + step.atMinute : hour - 60 + step.atMinute;
  } else if (step.everyMinutes !== undefined && step.everyMinutes > 1) {
    length = step.everyMinutes;
    start = hour + past - (past % length);
  } else {
    return null;
  }
  if (minute - start >= Math.min(CATCH_UP_MINUTES, length)) return "skip";
  return new Date(start * MINUTE_MS).toISOString();
}
