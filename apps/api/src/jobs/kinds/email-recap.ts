import { RECAP_JOB, runRecapJob } from "../../email/recap.ts";
import type { JobKinds } from "../registry.ts";

/** The Friday recap of what a person shipped. */
export const emailRecapJobs = (): JobKinds => ({
  [RECAP_JOB]: runRecapJob,
});
