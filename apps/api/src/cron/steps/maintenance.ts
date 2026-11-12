import { wakesPaused } from "../../http/maintenance.ts";
import { resumeBlocked } from "../../sandboxes/wake.ts";
import type { CronStep } from "../steps.ts";

/**
 * Once wakes are no longer paused (`PONZU_MAINTENANCE` back to `off`), the canvases still
 * waiting on `paused` go on: a wake job tries again by itself every two minutes, but one that
 * ran out of tries during a long pause has stopped, and its canvas would wait for its next
 * message. Every minute this lifts `paused` everywhere and wakes those that owe a turn
 * (`resumeBlocked`); with nothing paused, that is one update that changes no row. While wakes
 * are paused it does nothing.
 */
export const maintenanceStep: CronStep = {
  name: "maintenance",
  run: async (deps): Promise<Record<string, number>> => {
    if (wakesPaused(deps.features)) return { paused: 1 };
    return { ...(await resumeBlocked(deps, { blockers: ["paused"] })) };
  },
};
