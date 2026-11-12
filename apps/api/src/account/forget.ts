import { getUserByWorkosId, type NewJob } from "@ponzu/db";
import { z } from "zod";
import type { JobDeps } from "../jobs/run.ts";

/*
 * What the services outside Ponzu are asked to forget once a person's account is deleted
 * (docs/cloud.md, "Deleting an account", step 8): their WorkOS user, so their next sign-in is
 * someone new, and then what PostHog holds about them (their profile, events and recordings).
 *
 * One job, keyed by the user id, so a provider being down is tried again, for hours, rather
 * than lost with the request that deleted them. Each step is safe to repeat: a WorkOS user
 * already gone is done (`workos.deleteUser`), one an account signed in with since is kept,
 * and PostHog finding nobody is done. Without
 * PostHog's personal key (`deps.posthogAdmin` null) the second step is skipped, logged, and
 * the job completes.
 *
 * It logs ids only: never an email, a name or a key.
 */

export const ACCOUNT_FORGET_JOB = "account.forget";
/** With the usual wait (a minute, doubling, at most an hour), ten attempts span about six hours. */
export const ACCOUNT_FORGET_ATTEMPTS = 10;

const Payload = z.object({ userId: z.string(), workosUserId: z.string().nullable() });

/** The job that forgets a deleted person outside Ponzu, for `runNow` to record. */
export function accountForgetJob(input: z.infer<typeof Payload>): NewJob {
  return {
    kind: ACCOUNT_FORGET_JOB,
    key: input.userId,
    payload: input,
    maxAttempts: ACCOUNT_FORGET_ATTEMPTS,
  };
}

export async function runAccountForgetJob(
  deps: Pick<JobDeps, "db" | "workos" | "posthogAdmin" | "log">,
  payload: unknown,
): Promise<void> {
  const { userId, workosUserId } = Payload.parse(payload);
  // While this job waits, sign-in refuses this WorkOS user (auth/sign-in.ts), so no account is
  // made on it between this check and the delete. The check is for one made before the job
  // was recorded, by a sign-in that raced the deletion: it is theirs to keep, and deleting it
  // would break the new account's sign-in.
  if (workosUserId && (await getUserByWorkosId(deps.db, workosUserId))) {
    deps.log.info("workos_forget_skipped", { userId, reason: "signed_in_again" });
  } else if (workosUserId) {
    await deps.workos.deleteUser(workosUserId);
  }
  if (!deps.posthogAdmin) {
    deps.log.info("analytics_forget_skipped", { userId });
    return;
  }
  await deps.posthogAdmin.forgetPerson(userId);
  deps.log.info("analytics_forgotten", { userId });
}
