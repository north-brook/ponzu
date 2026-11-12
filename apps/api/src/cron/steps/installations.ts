import { sweepInstallations } from "../../github/installations.ts";
import type { CronStep } from "../steps.ts";

/** How many installations each run reads again from GitHub. */
const SWEEP_LIMIT = 5;

/** Read again the installations nobody has read for hours, which catches a lost uninstall. */
export const installationsStep: CronStep = {
  name: "installations",
  run: async (deps) => ({ swept: await sweepInstallations(deps, { limit: SWEEP_LIMIT }) }),
};
