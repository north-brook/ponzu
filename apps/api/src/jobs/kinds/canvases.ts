import { runWakeJob, WAKE_JOB } from "../../sandboxes/orchestrate.ts";
import type { JobKinds } from "../registry.ts";

/** A canvas's sandbox: waking it. */
export const canvasJobs = (): JobKinds => ({
  [WAKE_JOB]: runWakeJob,
});
