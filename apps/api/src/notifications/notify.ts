import {
  enqueueJob,
  focusedPresence,
  getQuestion,
  insertDeliveries,
  insertNotifications,
  type Job,
  listNotificationsByIds,
  listNotifyRecipients,
  type NewNotification,
  type NotificationLink,
  type NotifyCanvasFacts,
  notifyCanvasFacts,
  recentPushes,
} from "@ponzu/db";
import { stableUuid } from "../analytics/analytics.ts";
import type { JobDeps, RunNowDeps, RunningJob } from "../jobs/run.ts";
import { runJob, runNow } from "../jobs/run.ts";
import { scheduleBadges } from "./badge.ts";
import { type PingWords, pingCopy } from "./copy.ts";
import { DELIVER_JOB } from "./deliver.ts";
import { canvasFactsOf, deviceFactsOf, notificationIdFor, toggleOn } from "./facts.ts";
import {
  dedupeKey,
  type NotificationKind,
  NotifyTrigger,
  QUESTION_ESCALATE_MS,
  triggerKey,
  turnPing,
} from "./kinds.ts";
import { HOUR_MS, planDelivery } from "./plan.ts";
import { needsYouRecipients, personRecipients } from "./recipients.ts";

/*
 * What product code calls when something may be worth a ping (docs/cloud.md, "Notifications").
 *
 * `notify` records a `notify` job keyed by the trigger and runs it at once, past the response,
 * as `requestWake` does with a wake; if the request's instance dies, the minute's cron runs it.
 * It never throws to its caller: a ping is never worth failing the request that caused it.
 *
 * The job (`runNotifyJob`) reads the facts in a few statements, works out who hears of it
 * (recipients.ts) and what each is told (copy.ts), plans each person's pushes by the quiet rules
 * (plan.ts), and writes one `notifications` row per person, with a `notification_deliveries` row
 * per iPhone. Every row it writes has an id made from the job's own, so an attempt run again
 * picks up what an earlier one wrote and plans its pushes, and the dedupe key means the same
 * thing never makes two rows for one person, however often its trigger comes. Pushes due now are
 * sent in the same run (`notification.deliver`, deliver.ts); the rest wait for their time.
 */

export const NOTIFY_JOB = "notify";

/**
 * Record what happened and have the `notify` job tell whoever should hear. Never throws: a
 * trigger that is not well formed, or a job that could not be recorded, is logged
 * (`notify_failed`) and dropped.
 */
export async function notify(deps: RunNowDeps, trigger: NotifyTrigger): Promise<void> {
  try {
    const parsed = NotifyTrigger.safeParse(trigger);
    if (!parsed.success) {
      deps.log.warn("notify_failed", { trigger: trigger.kind, reason: "invalid_trigger" });
      return;
    }
    const recorded = await runNow(deps, {
      kind: NOTIFY_JOB,
      key: triggerKey(parsed.data),
      payload: parsed.data,
    });
    deps.log.info("notify_recorded", { trigger: parsed.data.kind, jobId: recorded?.id ?? null });
  } catch (error) {
    deps.log.warn("notify_failed", { trigger: trigger.kind, error });
  }
}

/** One notification to write: who, what and where it opens. */
interface Telling {
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  words: PingWords;
  link: NotificationLink;
  sourceId: string | null;
}

/** The `notify` job: who hears of the trigger, and what they are told. */
export async function runNotifyJob(
  deps: JobDeps,
  payload: RunningJob["payload"],
  job: RunningJob,
): Promise<void> {
  const parsed = NotifyTrigger.safeParse(payload);
  if (!parsed.success) {
    // Recorded by an older build in a shape this one does not take: nothing to do with it.
    deps.log.warn("notify_failed", { jobId: job.id, reason: "invalid_payload" });
    return;
  }
  const trigger = parsed.data;
  const now = new Date(deps.clock.now());
  let tellings: Telling[];
  let canvas: NotifyCanvasFacts | null;
  switch (trigger.kind) {
    case "question_raised":
    case "question_escalate": {
      const question = await getQuestion(deps.db, {
        canvasId: trigger.canvasId,
        id: trigger.questionId,
      });
      // Answered or withdrawn before anyone was told: nobody needs to be.
      if (question?.status !== "open") return;
      if (trigger.kind === "question_raised") {
        // Recorded first, so a retry of this job never leaves the question without its second
        // round. A second recording while one waits is nothing (the job's key).
        await enqueueJob(deps.db, {
          kind: NOTIFY_JOB,
          key: triggerKey({ ...trigger, kind: "question_escalate" }),
          payload: { ...trigger, kind: "question_escalate" },
          runAt: new Date(now.getTime() + QUESTION_ESCALATE_MS),
        });
      }
      canvas = await notifyCanvasFacts(deps.db, { canvasId: trigger.canvasId });
      if (!canvas) return;
      const people = needsYouRecipients(
        canvasFactsOf(canvas),
        {
          stage: trigger.kind === "question_raised" ? "now" : "escalate",
          driverId: canvas.driverId,
          openedBy: new Set(canvas.openedBy),
        },
        now,
      );
      const name = canvas.name;
      tellings = people.map((userId) => ({
        userId,
        kind: "needs_you",
        dedupeKey: dedupeKey.needsYou(trigger.canvasId, trigger.questionId),
        words: { kind: "needs_you", canvasName: name, questionKind: trigger.questionKind },
        link: { open: "thread", questionId: trigger.questionId },
        sourceId: trigger.questionId,
      }));
      break;
    }
    case "turn_finished": {
      canvas = await notifyCanvasFacts(deps.db, {
        canvasId: trigger.canvasId,
        eventId: trigger.eventId,
      });
      if (!canvas) return;
      tellings = turnTellings(canvas, trigger, now);
      break;
    }
    default:
      // The comment, pull request, lapse, wake and billing triggers are told by a later change.
      deps.log.info("notify_skipped", { jobId: job.id, trigger: trigger.kind });
      return;
  }
  await tell(deps, job, canvas, tellings, now);
}

/** Who hears that a turn ended, and what they are told: a reply, finished, failed or a limit. */
function turnTellings(
  canvas: NotifyCanvasFacts,
  trigger: Extract<NotifyTrigger, { kind: "turn_finished" }>,
  now: Date,
): Telling[] {
  const ping = turnPing({
    outcome: trigger.outcome,
    errorCode: trigger.errorCode,
    durationMs: trigger.durationMs,
    eventKind: (canvas.event?.kind ?? null) as Parameters<typeof turnPing>[0]["eventKind"],
    questionOpen: canvas.openQuestions > 0,
  });
  if (!ping) return [];
  const facts = canvasFactsOf(canvas);
  const name = canvas.name;
  const thread: NotificationLink = { open: "thread" };
  const turnId = trigger.turnId;
  if (ping.kind === "claude_limit") {
    // Whoever's Claude account the canvas runs on: it is their plan that hit the limit.
    if (!canvas.claudeAccountId) return [];
    const who = personRecipients(facts, { personId: canvas.claudeUserId }, now);
    return who.map((userId) => ({
      userId,
      kind: "claude_limit",
      dedupeKey: dedupeKey.claudeLimit(canvas.claudeAccountId!, now),
      words: { kind: "claude_limit", canvasName: name },
      link: thread,
      sourceId: turnId,
    }));
  }
  // The person whose message, answer or comment began the turn.
  const who = personRecipients(facts, { personId: canvas.event?.userId ?? null }, now);
  return who.map((userId): Telling => {
    switch (ping.kind) {
      case "reply":
        return {
          userId,
          kind: "reply",
          dedupeKey: dedupeKey.reply(trigger.canvasId, turnId),
          words: { kind: "reply", canvasName: name },
          link: thread,
          sourceId: turnId,
        };
      case "finished":
        return {
          userId,
          kind: "finished",
          dedupeKey: dedupeKey.finished(trigger.canvasId, turnId),
          words: { kind: "finished", canvasName: name },
          link: thread,
          sourceId: turnId,
        };
      case "failed":
        return {
          userId,
          kind: "failed",
          dedupeKey: dedupeKey.failedTurn(trigger.canvasId, turnId),
          words: { kind: "failed", canvasName: name, reason: ping.reason },
          link: thread,
          sourceId: turnId,
        };
    }
  });
}

/**
 * Write the notifications, plan each one's pushes by the quiet rules, and send what is due now.
 * Safe to run again: rows this job wrote are found by their ids, and their deliveries by
 * (notification, device).
 */
async function tell(
  deps: JobDeps,
  job: Pick<Job, "id">,
  canvas: NotifyCanvasFacts | null,
  tellings: readonly Telling[],
  now: Date,
): Promise<void> {
  if (tellings.length === 0) return;
  const { db } = deps;
  const userIds = [...new Set(tellings.map((telling) => telling.userId))];
  const [recipients, focused, pushes] = await Promise.all([
    listNotifyRecipients(db, userIds),
    canvas
      ? focusedPresence(db, { canvasId: canvas.id, userIds, now })
      : Promise.resolve(new Map<string, Date>()),
    recentPushes(db, { userIds, since: new Date(now.getTime() - HOUR_MS) }),
  ]);
  const byUser = new Map(recipients.map((recipient) => [recipient.userId, recipient]));

  const planned = tellings.flatMap((telling) => {
    const recipient = byUser.get(telling.userId);
    if (!recipient) return [];
    const plan = planDelivery(
      {
        kind: telling.kind,
        toggleOn: toggleOn(telling.kind, recipient.prefs),
        focusedAt: focused.get(telling.userId) ?? null,
        recentPushes: pushes.filter((push) => push.userId === telling.userId),
        devices: recipient.devices.map(deviceFactsOf),
      },
      now,
    );
    const { title, body } = pingCopy(telling.words);
    const row: NewNotification = {
      id: notificationIdFor(job.id, telling.userId, telling.dedupeKey),
      userId: telling.userId,
      workspaceId: canvas?.workspaceId ?? null,
      canvasId: canvas?.id ?? null,
      kind: telling.kind,
      dedupeKey: telling.dedupeKey,
      title,
      body,
      link: telling.link,
      sourceId: telling.sourceId,
      muted: plan.muted,
      ...(plan.readNow ? { readVia: plan.readNow } : {}),
    };
    return [{ row, plan }];
  });

  const inserted = await insertNotifications(db, { rows: planned.map(({ row }) => row), now });
  // This job's rows: those just written, and any an earlier attempt of it wrote.
  const mine = await listNotificationsByIds(
    db,
    planned.map(({ row }) => row.id!),
  );
  const plans = new Map(planned.map(({ row, plan }) => [row.id!, plan]));
  const deliveries = mine.flatMap((row) =>
    row.readAt
      ? []
      : (plans.get(row.id)?.pushes ?? []).map((push) => ({
          notificationId: row.id,
          deviceId: push.deviceId,
          sendAt: push.sendAt,
        })),
  );
  await insertDeliveries(db, { rows: deliveries, now });

  for (const row of inserted) {
    const plan = plans.get(row.id)!;
    deps.analytics.capture(
      "notification created",
      {
        kind: row.kind,
        muted: row.muted,
        suppressed: plan.suppressed,
        pushes: plan.pushes.length,
        deferred: plan.pushes.some((push) => push.sendAt.getTime() > now.getTime()),
      },
      {
        distinctId: row.userId,
        workspaceId: row.workspaceId,
        uuid: stableUuid(`${row.id}/created`),
        timestamp: row.createdAt,
      },
    );
  }

  // A needs-you that pushes nothing (muted, looked at, held back) still counts on the badge:
  // the person's phones learn the new count from a badge-only push.
  const quiet = inserted.filter(
    (row) => row.kind === "needs_you" && (plans.get(row.id)?.pushes.length ?? 0) === 0,
  );
  await scheduleBadges(deps, [...new Set(quiet.map((row) => row.userId))]);

  // Each notification's pushes go in one `notification.deliver` job, at the earliest time one
  // is due: now, here and in this run, or later, for the cron.
  const firstSend = new Map<string, Date>();
  for (const delivery of deliveries) {
    const at = firstSend.get(delivery.notificationId);
    if (!at || delivery.sendAt < at) firstSend.set(delivery.notificationId, delivery.sendAt);
  }
  for (const [notificationId, sendAt] of firstSend) {
    const due = sendAt.getTime() <= now.getTime();
    const worker = `${DELIVER_JOB}:${crypto.randomUUID()}`;
    const recorded = await enqueueJob(db, {
      kind: DELIVER_JOB,
      key: notificationId,
      payload: { notificationId },
      runAt: sendAt,
      ...(due ? { lockedBy: worker } : {}),
    });
    if (due && recorded) await runJob(deps, recorded, worker);
  }
}
