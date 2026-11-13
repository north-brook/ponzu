import { enqueueRecaps } from "../../email/recap.ts";
import type { CronStep } from "../steps.ts";

/**
 * Every five minutes: on Fridays from 15:00 where each person is, stamp everyone with nothing
 * merged that week, then send the recaps of a batch of the rest, one after another. Nothing
 * while email is off or `recap` is paused.
 */
export const recapsStep: CronStep = {
  name: "recaps",
  everyMinutes: 5,
  run: (deps, now) => enqueueRecaps(deps, now),
};
