import { MEMBERS_JOB, runMembersJob } from "../../email/members.ts";
import type { JobKinds } from "../registry.ts";

/** The email that tells an organisation's admins who joined its workspace. */
export const emailMembersJobs = (): JobKinds => ({
  [MEMBERS_JOB]: runMembersJob,
});
