import { runDueJobs } from "../../jobs/run.ts";
import type { CronStep } from "../steps.ts";

/** Close the jobs that ran out of attempts, then run what is due and nobody holds. */
export const jobsStep: CronStep = {
  name: "jobs",
  run: (deps) => runDueJobs(deps, `cron:${crypto.randomUUID()}`),
};
