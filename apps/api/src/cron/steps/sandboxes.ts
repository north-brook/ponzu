import { sweepSandboxes } from "../../sandboxes/sweep.ts";
import type { CronStep } from "../steps.ts";

/**
 * The look over every sandbox that costs something or is moving. Its reconcile, every tenth
 * minute, also removes the sandboxes of sign-ins that are over.
 */
export const sandboxesStep: CronStep = {
  name: "sandboxes",
  run: async (deps) => ({ ...(await sweepSandboxes(deps)) }),
};
