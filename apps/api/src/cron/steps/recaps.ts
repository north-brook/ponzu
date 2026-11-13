import { enqueueRecaps, recapEmailOn, recapMayBeDue } from "../../email/recap.ts";
import type { CronStep } from "../steps.ts";

/**
 * Every five minutes: on Fridays from 15:00 where each person is, stamp everyone with nothing
 * merged that week, then send the recaps of a batch of the rest, one after another. While email
 * is off, `recap` is paused, or no zone can be at its Friday 15:00, the step does not run at
 * all: it records no slot and is not in the cron's answer.
 */
export const recapsStep: CronStep = {
  name: "recaps",
  everyMinutes: 5,
  enabled: (deps, now) => recapEmailOn(deps) && recapMayBeDue(now),
  run: (deps, now) => enqueueRecaps(deps, now),
};
