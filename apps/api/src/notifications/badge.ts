import {
  badgeCount,
  enqueueJob,
  forgetDeadTokens,
  listNotifyRecipients,
  markNotificationsRead,
  resolveNeedsYou,
} from "@ponzu/db";
import { z } from "zod";
import { pushErrorOf } from "../deps/push.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { deviceFactsOf } from "./facts.ts";
import { dedupeKey } from "./kinds.ts";
import { badgeMessage } from "./payload.ts";
import { takesPings } from "./plan.ts";

/*
 * The number on a person's phone icon (docs/cloud.md, "Notifications"): their open needs-you
 * questions across every workspace. A ping carries it as it goes; when it changes without a ping
 * (a question answered, withdrawn or swept closed, or a needs-you that pushed nothing), the
 * `notification.badge` job sends each of their phones a push with the new number and nothing
 * else. It is keyed by the person and waits `BADGE_FOLD_MS`, so a burst of changes is one push.
 */

export const BADGE_JOB = "notification.badge";

/** How long a badge push waits for more changes, which it then carries too. */
export const BADGE_FOLD_MS = 30_000;

/** A badge push that fails is tried again this much later; sending it twice is harmless. */
const BADGE_RETRY_MS = 30_000;

const BadgePayload = z.object({ userId: z.string().min(1).max(64) });

/**
 * Record a badge push for each of these people, `BADGE_FOLD_MS` from now, for the cron to send.
 * One already waiting for a person carries this change too. Nothing while push is off.
 */
export async function scheduleBadges(
  deps: Pick<JobDeps, "db" | "clock" | "push">,
  userIds: readonly string[],
): Promise<void> {
  if (!deps.push.enabled || userIds.length === 0) return;
  const runAt = new Date(deps.clock.now() + BADGE_FOLD_MS);
  await Promise.all(
    userIds.map((userId) =>
      enqueueJob(deps.db, { kind: BADGE_JOB, key: userId, payload: { userId }, runAt }),
    ),
  );
}

/** The `notification.badge` job: the person's badge, to each phone that takes pings. */
export async function runBadgeJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
): Promise<void> {
  const parsed = BadgePayload.safeParse(payload);
  if (!parsed.success) {
    deps.log.warn("push_failed", { jobId: job.id, reason: "invalid_payload" });
    return;
  }
  if (!deps.push.enabled) return;
  const { db, log } = deps;
  const now = new Date(deps.clock.now());
  const [recipient] = await listNotifyRecipients(db, [parsed.data.userId]);
  const phones = (recipient?.devices ?? []).filter((device) =>
    takesPings(deviceFactsOf(device), now),
  );
  if (phones.length === 0) return;
  const badge = await badgeCount(db, parsed.data.userId);
  let tickets: Awaited<ReturnType<JobDeps["push"]["send"]>>;
  try {
    tickets = await deps.push.send(phones.map((phone) => badgeMessage(phone.pushToken!, badge)));
  } catch (error) {
    const failure = pushErrorOf(error);
    if (failure.code === "rejected") {
      log.error("push_rejected", { jobId: job.id, status: failure.status });
      return;
    }
    // A badge push has no words: one that went twice only sets the same number again.
    throw new RetryLater(BADGE_RETRY_MS, `Expo could not take a badge push: ${failure.code}.`);
  }
  const dead: { id: string; pushToken: string }[] = [];
  phones.forEach((phone, index) => {
    const ticket = tickets[index];
    if (ticket?.ok) return;
    const error = ticket?.error ?? "Unknown";
    log.warn("push_ticket_error", { jobId: job.id, error, badge: true });
    if (error === "DeviceNotRegistered") dead.push({ id: phone.id, pushToken: phone.pushToken! });
  });
  const forgotten = await forgetDeadTokens(db, dead);
  if (forgotten > 0) log.info("device_unregistered", { count: forgotten, via: "badge" });
}

/**
 * Some of a canvas's questions closed (answered, withdrawn): their needs-you notifications are
 * resolved, the one who answered has theirs read (`via: seen`, which cancels the push still
 * waiting for their phone), and every badge that went down is pushed. Never throws: the cron's
 * sweep (`resolveClosedQuestions`) resolves anything this missed.
 */
export async function questionsClosed(
  deps: Pick<JobDeps, "db" | "clock" | "push" | "log">,
  {
    canvasId,
    questionIds,
    answeredBy = null,
  }: { canvasId: string; questionIds: readonly string[]; answeredBy?: string | null },
): Promise<void> {
  if (questionIds.length === 0) return;
  try {
    const now = new Date(deps.clock.now());
    const lowered = await resolveNeedsYou(deps.db, { canvasId, questionIds, now });
    if (answeredBy) {
      await markNotificationsRead(deps.db, {
        userId: answeredBy,
        dedupeKeys: questionIds.map((id) => dedupeKey.needsYou(canvasId, id)),
        now,
        via: "seen",
      });
    }
    await scheduleBadges(deps, lowered);
  } catch (error) {
    deps.log.warn("notify_failed", { canvasId, reason: "resolve", error });
  }
}
