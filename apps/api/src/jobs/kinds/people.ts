import { PEOPLE_JOB, runPeopleJob } from "../../github/people.ts";
import type { JobKinds } from "../registry.ts";

/** Who can reach a workspace's repos, read again from GitHub. */
export const peopleJobs = (): JobKinds => ({
  [PEOPLE_JOB]: runPeopleJob,
});
