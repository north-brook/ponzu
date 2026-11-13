import { accountJobs } from "./kinds/account.ts";
import { canvasJobs } from "./kinds/canvases.ts";
import { environmentJobs } from "./kinds/environments.ts";
import { githubJobs } from "./kinds/github.ts";
import { notificationJobs } from "./kinds/notifications.ts";
import { peopleJobs } from "./kinds/people.ts";
import { pullRequestJobs } from "./kinds/pull-requests.ts";
import { searchJobs } from "./kinds/search.ts";
import type { JobDeps, RunningJob } from "./run.ts";

/*
 * What runs a job of each kind. Each area's kinds are in their own module under `kinds/`,
 * and a feature that adds kinds adds one module there and one line to `JOB_MODULES`, so no two
 * features edit the same function.
 */

/** What runs one job: its payload as recorded, and which attempt this is. */
export type JobHandler = (
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
) => Promise<void>;

/** One area's kinds, by name. */
export type JobKinds = Record<string, JobHandler>;

/**
 * Every area that runs jobs, one line each. A module is a function, called when the registry
 * is asked for and not when it loads: a module that runs its own jobs imports `run.ts`, which
 * imports this, and may be loaded before the handlers it names exist.
 */
export const JOB_MODULES: readonly (() => JobKinds)[] = [
  githubJobs,
  canvasJobs,
  pullRequestJobs,
  environmentJobs,
  peopleJobs,
  searchJobs,
  notificationJobs,
  accountJobs,
];

/**
 * Every kind and what runs it. Two modules naming one kind is a mistake that would otherwise
 * run one of them silently, so it throws.
 */
export function jobHandlers(modules = JOB_MODULES): JobKinds {
  const all: JobKinds = {};
  for (const kinds of modules) {
    for (const [kind, handler] of Object.entries(kinds())) {
      if (kind in all) throw new Error(`Two modules run jobs of kind ${kind}.`);
      all[kind] = handler;
    }
  }
  return all;
}
