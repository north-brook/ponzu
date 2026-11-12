import { sweepOldRows } from "@ponzu/db";
import type { CronStep } from "../steps.ts";

/**
 * Once an hour, delete the operational rows that have outlived their retention: sign-in and
 * install states a day after they expire, finished jobs and webhook records after 30 days
 * (`packages/db/src/queries/retention.ts`). It logs counts only, never what the rows held.
 */
export const retentionStep: CronStep = {
  name: "retention",
  atMinute: 0,
  run: async (deps, now) => {
    const swept = await sweepOldRows(deps.db, now);
    const counts = {
      auth_states: swept.authStates,
      jobs: swept.jobs,
      webhook_deliveries: swept.webhookDeliveries,
    };
    if (counts.auth_states + counts.jobs + counts.webhook_deliveries > 0) {
      deps.log.info("rows_swept", counts);
    }
    return counts;
  },
};
