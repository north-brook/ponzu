import { ACCOUNT_FORGET_JOB, runAccountForgetJob } from "../../account/forget.ts";
import type { JobKinds } from "../registry.ts";

/** A deleted account: forgetting the person at WorkOS and PostHog. */
export const accountJobs = (): JobKinds => ({
  [ACCOUNT_FORGET_JOB]: runAccountForgetJob,
});
