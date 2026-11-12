import { sweepPullRequests } from "../../pull-requests/sweep.ts";
import type { CronStep } from "../steps.ts";

/**
 * Reading again the open pull requests nobody has read from GitHub for a quarter of an hour,
 * which catches one whose webhooks were all lost. The reads it records run as jobs.
 */
export const pullRequestSweepStep: CronStep = {
  name: "pull_requests",
  run: async (deps, now) => ({ swept: await sweepPullRequests(deps, now) }),
};
