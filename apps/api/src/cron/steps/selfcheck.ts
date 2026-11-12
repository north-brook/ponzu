import { reportSelfcheck, runSelfcheck } from "../../ops/selfcheck.ts";
import type { CronStep } from "../steps.ts";

/** The minute past each hour the selfcheck runs. */
export const SELFCHECK_MINUTE = 7;

/**
 * Once an hour, the API checks its own dependencies and settings (`ops/selfcheck.ts`). Each
 * check that fails is logged, and raised to error tracking unless it is informational.
 */
export const selfcheckStep: CronStep = {
  name: "selfcheck",
  atMinute: SELFCHECK_MINUTE,
  run: async (deps) => {
    const results = await runSelfcheck(deps);
    reportSelfcheck(deps, results);
    const failed = results.filter((result) => !result.ok).length;
    return { ok: results.length - failed, failed };
  },
};
