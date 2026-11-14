import { closeDuePeriods } from "../../billing/close.ts";
import type { CronStep } from "../steps.ts";

/**
 * Every minute while billing is observed or on: work out when new workspaces' periods close,
 * move past periods with nothing in them, and record a close for each period that ended ten
 * minutes or more ago (`billing/close.ts`). While PONZU_BILLING is off it is not run at all, so
 * the minute answers as it did before billing.
 */
export const closePeriodsStep: CronStep = {
  name: "close_periods",
  enabled: (deps) => deps.features.billing !== "off",
  run: (deps, now) => closeDuePeriods(deps, now),
};
