import { enqueueDigests } from "../../notifications/digest.ts";
import type { CronStep } from "../steps.ts";

/**
 * At minute 0 of each hour: a daily email job for everyone whose email is due (9:00 or later
 * where they are, and none sent for that date yet). Nothing while email is off.
 */
export const digestsStep: CronStep = {
  name: "digests",
  atMinute: 0,
  run: (deps, now) => enqueueDigests(deps, now),
};
