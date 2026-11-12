import { BASE_REBUILD_JOB, runBaseRebuildJob } from "../../environments/rebuild.ts";
import type { JobKinds } from "../registry.ts";

/** A repo's environment: rebuilding its base. */
export const environmentJobs = (): JobKinds => ({
  [BASE_REBUILD_JOB]: runBaseRebuildJob,
});
