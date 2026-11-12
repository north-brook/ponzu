import { enqueueDigests } from "../../notifications/digest.ts";
import type { CronStep } from "../steps.ts";

/**
 * Every five minutes: the daily email for a batch of the people whose email is due (9:00 or
 * later where they are, and none sent for that date yet), sent one after another. Nothing while
 * email is off.
 */
export const digestsStep: CronStep = {
  name: "digests",
  everyMinutes: 5,
  run: (deps, now) => enqueueDigests(deps, now),
};
