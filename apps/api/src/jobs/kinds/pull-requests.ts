import { REFRESH_JOB, runRefreshJob } from "../../pull-requests/refresh.ts";
import type { JobKinds } from "../registry.ts";

/** A canvas's pull request: reading it again from GitHub. */
export const pullRequestJobs = (): JobKinds => ({
  [REFRESH_JOB]: runRefreshJob,
});
