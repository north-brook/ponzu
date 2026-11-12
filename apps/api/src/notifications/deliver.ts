import {
  badgeCount,
  type DeliveryUpdate,
  type DueDelivery,
  dueDeliveries,
  forgetDeadTokens,
  getNotification,
  getQuestion,
  listNotifyRecipients,
  markDeliveries,
  notifyCanvasFacts,
  resolveNeedsYou,
} from "@ponzu/db";
import { z } from "zod";
import { stableUuid } from "../analytics/analytics.ts";
import { type PushMessage, pushErrorOf } from "../deps/push.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { scheduleBadges } from "./badge.ts";
import { canvasFactsOf, deviceFactsOf, pushNotificationOf, toggleOn } from "./facts.ts";
import { pushMessage } from "./payload.ts";
import { type CancelReason, cancelReason } from "./plan.ts";
import { canRead } from "./recipients.ts";

/*
 * One notification's pushes to its person's iPhones (docs/cloud.md, "Notifications"): the
 * `notification.deliver` job, keyed by the notification. It takes the deliveries due now, cancels
 * those that should no longer go (read, resolved, toggle off, phone gone, access lost, too late,
 * push off), and hands the rest to Expo in one request.
 *
 * Each push goes at most once. A delivery is marked `sending` before the request, and only the
 * rows that moved are sent, so two runs of the job never send the same one. What Expo answers
 * then settles it:
 *
 * - a ticket: `sent`, or `failed` with Expo's code (a `DeviceNotRegistered` also forgets the
 *   phone, if it still holds that token);
 * - a 429: nothing was taken, so the pushes go back to waiting for `RATE_LIMITED_WAIT_MS` and the
 *   job is tried again then;
 * - a 5xx or no answer: Expo may have taken them, so they are never sent again. They stay
 *   `sending` until the receipts step marks them `unknown`. Every ping carries a collapse id
 *   (its notification's), so one Expo did take shows once however it is delivered;
 * - a refusal (any other 4xx, the access token's among them): `failed`, and an error.
 */

export const DELIVER_JOB = "notification.deliver";

/** How long a push Expo refused with a 429 waits before it is tried again. */
export const RATE_LIMITED_WAIT_MS = 30_000;

const DeliverPayload = z.object({ notificationId: z.string().min(1).max(64) });

export async function runDeliverJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
): Promise<void> {
  const parsed = DeliverPayload.safeParse(payload);
  if (!parsed.success) {
    deps.log.warn("push_failed", { jobId: job.id, reason: "invalid_payload" });
    return;
  }
  const { db } = deps;
  const { notificationId } = parsed.data;
  const now = new Date(deps.clock.now());
  const notification = await getNotification(db, notificationId);
  if (!notification) return;
  const { due, nextSendAt } = await dueDeliveries(db, { notificationId, now });
  if (due.length > 0) {
    await deliver(deps, notification, due, now, job.attempts >= job.maxAttempts);
  }
  // Pushes still waiting for their time (a 429's, or a phone added on a later attempt).
  if (nextSendAt) {
    throw new RetryLater(
      Math.max(nextSendAt.getTime() - now.getTime(), 1000),
      "Pushes still wait for their time.",
    );
  }
}

/**
 * For a needs-you whose row is not resolved: `now` when its question is no longer open (and the
 * row is resolved here, so its badge goes down), else null.
 */
async function closedAt(
  deps: JobDeps,
  notification: NonNullable<Awaited<ReturnType<typeof getNotification>>>,
  now: Date,
): Promise<Date | null> {
  if (notification.kind !== "needs_you" || !notification.canvasId || !notification.sourceId) {
    return null;
  }
  const question = await getQuestion(deps.db, {
    canvasId: notification.canvasId,
    id: notification.sourceId,
  });
  if (question?.status === "open") return null;
  const lowered = await resolveNeedsYou(deps.db, {
    canvasId: notification.canvasId,
    questionIds: [notification.sourceId],
    now,
  });
  await scheduleBadges(deps, lowered);
  return now;
}

async function deliver(
  deps: JobDeps,
  notification: NonNullable<Awaited<ReturnType<typeof getNotification>>>,
  due: DueDelivery[],
  now: Date,
  /** This is the job's last attempt: a 429 can not be tried again. */
  lastAttempt: boolean,
): Promise<void> {
  const { db, log } = deps;
  const [recipient] = await listNotifyRecipients(db, [notification.userId]);
  // Read again at send time: someone who lost the canvas since it was planned hears nothing.
  const canvas = notification.canvasId
    ? await notifyCanvasFacts(db, { canvasId: notification.canvasId })
    : null;
  // A billing ping is about a workspace, not a canvas; whether its person may still see it is
  // checked by its own trigger's change.
  const readable = notification.canvasId
    ? canvas !== null && canRead(canvasFactsOf(canvas), notification.userId, now)
    : true;
  // A question can close between the notify job's look at it and its row being written, and
  // then nothing resolved the row (the cron's sweep would, a minute on). Ask the question itself.
  const resolvedAt = notification.resolvedAt ?? (await closedAt(deps, notification, now));

  const cancels: { id: string; outcome: CancelReason }[] = [];
  const sends: (DueDelivery & { device: NonNullable<DueDelivery["device"]>; token: string })[] = [];
  for (const delivery of due) {
    const reason = cancelReason(
      {
        pushEnabled: deps.push.enabled,
        kind: notification.kind,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
        resolvedAt,
        toggleOn: recipient ? toggleOn(notification.kind, recipient.prefs) : false,
        device: delivery.device && recipient ? deviceFactsOf(delivery.device) : null,
        canRead: readable,
      },
      now,
    );
    if (reason) cancels.push({ id: delivery.id, outcome: reason });
    else sends.push({ ...delivery, device: delivery.device!, token: delivery.device!.pushToken! });
  }
  if (cancels.length > 0) {
    await markDeliveries(
      db,
      cancels.map(({ id, outcome }) => ({ id, state: "cancelled", outcome })),
    );
    log.info("push_cancelled", {
      notificationId: notification.id,
      outcomes: cancels.map(({ outcome }) => outcome),
    });
  }
  if (sends.length === 0) return;

  const badge = await badgeCount(db, notification.userId);
  const ping = pushNotificationOf(notification);
  // Built before anything is marked: a message too large throws here, and nothing is lost.
  const messages = new Map<string, PushMessage>(
    sends.map((send) => [send.id, pushMessage(send.token, ping, badge)]),
  );
  // Only the rows that move to `sending` are this run's to send.
  const moved = new Set(
    await markDeliveries(
      db,
      sends.map((send) => ({ id: send.id, state: "sending", sentAt: now })),
    ),
  );
  // A person keeps at most 20 devices, far under one request's `PUSH_SEND_LIMIT`.
  const going = sends.filter((send) => moved.has(send.id));
  if (going.length === 0) return;

  let tickets: Awaited<ReturnType<JobDeps["push"]["send"]>>;
  try {
    tickets = await deps.push.send(going.map((send) => messages.get(send.id)!));
  } catch (error) {
    const failure = pushErrorOf(error);
    if (failure.code === "rate_limited") {
      if (lastAttempt) {
        // No attempt is left to send them later: they would wait for ever.
        await markDeliveries(
          db,
          going.map((send) => ({ id: send.id, state: "failed", outcome: "rate_limited" })),
        );
        log.warn("push_rate_limited", { notificationId: notification.id, count: going.length });
        return;
      }
      const later = new Date(now.getTime() + RATE_LIMITED_WAIT_MS);
      await markDeliveries(
        db,
        going.map((send) => ({ id: send.id, state: "waiting", sendAt: later })),
      );
      throw new RetryLater(RATE_LIMITED_WAIT_MS, "Expo asked for fewer pushes.");
    }
    if (failure.code === "unavailable") {
      // Expo may have taken them: they are not sent again (the receipts step settles them).
      log.warn("push_unanswered", { notificationId: notification.id, count: going.length });
      return;
    }
    await markDeliveries(
      db,
      going.map((send) => ({ id: send.id, state: "failed", outcome: "rejected" })),
    );
    log.error("push_rejected", { notificationId: notification.id, status: failure.status });
    deps.analytics.exception(failure, { push: "send" });
    return;
  }

  const updates: DeliveryUpdate[] = [];
  const dead: { id: string; pushToken: string }[] = [];
  going.forEach((send, index) => {
    const ticket = tickets[index];
    if (ticket?.ok) {
      updates.push({ id: send.id, state: "sent", sentAt: now, ticketId: ticket.id });
      deps.analytics.capture(
        "push sent",
        { kind: notification.kind },
        {
          distinctId: notification.userId,
          workspaceId: notification.workspaceId,
          uuid: stableUuid(`${send.id}/sent`),
        },
      );
      return;
    }
    const error = ticket?.error ?? "Unknown";
    updates.push({ id: send.id, state: "failed", outcome: error });
    log.warn("push_ticket_error", { notificationId: notification.id, error });
    deps.analytics.capture(
      "push failed",
      { kind: notification.kind, error },
      {
        distinctId: notification.userId,
        workspaceId: notification.workspaceId,
        uuid: stableUuid(`${send.id}/failed`),
      },
    );
    if (error === "DeviceNotRegistered") dead.push({ id: send.device.id, pushToken: send.token });
    if (error === "InvalidCredentials") {
      log.error("push_credentials_invalid", { notificationId: notification.id });
      deps.analytics.exception(new Error("Expo refused Ponzu's push credentials."), {
        push: "ticket",
      });
    }
  });
  await markDeliveries(db, updates);
  const forgotten = await forgetDeadTokens(db, dead);
  if (forgotten > 0) log.info("device_unregistered", { count: forgotten, via: "ticket" });
  log.info("push_sent", {
    notificationId: notification.id,
    count: updates.filter((update) => update.state === "sent").length,
  });
}
