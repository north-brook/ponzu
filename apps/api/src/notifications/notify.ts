import {
  collapseCommentNotification,
  enqueueJob,
  focusedPresence,
  getQuestion,
  insertDeliveries,
  insertNotifications,
  type Job,
  lastNotifiedAt,
  listNotificationsByIds,
  listNotifyRecipients,
  markNotificationsRead,
  type NewNotification,
  type Notification,
  type NotificationLink,
  type NotifyCanvasFacts,
  type NotifyWorkspaceFacts,
  notifyCanvasFacts,
  notifyWorkspaceFacts,
  recentPushes,
  repushDeliveries,
} from "@ponzu/db";
import { stableUuid } from "../analytics/analytics.ts";
import { billingPeriod } from "../billing/period.ts";
import type { Deps } from "../deps/index.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { runJob, runNow } from "../jobs/run.ts";
import { scheduleBadges } from "./badge.ts";
import { type BillingWorkspace, commentBody, firstName, type PingWords, pingCopy } from "./copy.ts";
import { DELIVER_JOB } from "./deliver.ts";
import { canvasFactsOf, deviceFactsOf, notificationIdFor, toggleOn } from "./facts.ts";
import {
  BILLING_NOTICE_KIND,
  dedupeKey,
  idOrNull,
  loginOrNull,
  type NotificationKind,
  NotifyTrigger,
  QUESTION_ESCALATE_MS,
  triggerKey,
  turnPing,
} from "./kinds.ts";
import { COMMENT_COLLAPSE_MS, HOUR_MS, planDelivery, prReadyHeld } from "./plan.ts";
import {
  billingRecipients,
  commentRecipients,
  needsYouRecipients,
  personRecipients,
  prRecipients,
} from "./recipients.ts";

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
 * What `notify` takes: a job's deps, and, in a request, somewhere to run the job past the
 * response. Without `background` (a job calling it: a webhook's work, the sweep, a wake), the
 * `notify` job runs where it is called, before `notify` returns.
 */
export type NotifyDeps = JobDeps & Partial<Pick<Deps, "background">>;

/**
 * Record what happened and have the `notify` job tell whoever should hear. Never throws: a
 * trigger that is not well formed, or a job that could not be recorded, is logged
 * (`notify_failed`) and dropped.
 */
export async function notify(deps: NotifyDeps, trigger: NotifyTrigger): Promise<void> {
  try {
    const parsed = NotifyTrigger.safeParse(trigger);
    if (!parsed.success) {
      deps.log.warn("notify_failed", { trigger: trigger.kind, reason: "invalid_trigger" });
      return;
    }
    const job = { kind: NOTIFY_JOB, key: triggerKey(parsed.data), payload: parsed.data };
    let recorded: Job | null;
    if (deps.background) {
      recorded = await runNow({ ...deps, background: deps.background }, job);
    } else {
      const worker = `${NOTIFY_JOB}:${crypto.randomUUID()}`;
      recorded = await enqueueJob(deps.db, {
        ...job,
        runAt: new Date(deps.clock.now()),
        lockedBy: worker,
      });
      // `runJob` never rejects: a failed attempt is left on the row for the cron to try again.
      if (recorded) await runJob(deps, recorded, worker);
    }
    deps.log.info("notify_recorded", { trigger: parsed.data.kind, jobId: recorded?.id ?? null });
  } catch (error) {
    deps.log.warn("notify_failed", { trigger: trigger.kind, error });
  }
}

/**
 * The trigger for a person's comment, from its event (canvases/events.ts): the ids of the
 * comment and of where its pin is, and never its text. An id a client chose that is not an id's
 * shape is left out of the link rather than costing the ping.
 */
export function commentPosted(
  canvasId: string,
  authorId: string,
  event: { payload?: unknown; comment?: unknown },
): NotifyTrigger | null {
  const payload = (event.payload ?? {}) as { messageId?: unknown; threadId?: unknown };
  const item = (event.comment ?? {}) as { pageId?: unknown; artboardId?: unknown };
  const asId = (value: unknown) => idOrNull(typeof value === "string" ? value : null);
  const messageId = asId(payload.messageId);
  if (!messageId) return null;
  return {
    kind: "comment_posted",
    canvasId,
    messageId,
    authorId,
    threadId: asId(payload.threadId),
    pageId: asId(item.pageId),
    artboardId: asId(item.artboardId),
  };
}

/**
 * The trigger for a review that approved a canvas's pull request, by GitHub's ids and logins.
 * Null for a reviewer whose login is not a login's shape.
 */
export function reviewApproved(
  canvasId: string,
  review: { number: number; reviewId: number; reviewerLogin: string; authorLogin: string | null },
): NotifyTrigger | null {
  const reviewerLogin = loginOrNull(review.reviewerLogin);
  if (!reviewerLogin) return null;
  return {
    kind: "review_approved",
    canvasId,
    number: review.number,
    reviewId: String(review.reviewId),
    reviewerLogin,
    authorLogin: loginOrNull(review.authorLogin),
  };
}

/** One notification to write: who, what and where it opens. */
interface Telling {
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  words: PingWords;
  link: NotificationLink;
  sourceId: string | null;
  /** The first names a comment row is about, for its words once more comments fold into it. */
  people?: string[];
}

/** What notifications are about: a canvas, or for a billing ping only its workspace. */
interface Scope {
  canvas: NotifyCanvasFacts | null;
  workspaceId: string | null;
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
    case "comment_posted": {
      canvas = await notifyCanvasFacts(deps.db, { canvasId: trigger.canvasId });
      if (!canvas) return;
      tellings = await commentTellings(deps, canvas, trigger, now);
      break;
    }
    case "pull_request_ready": {
      canvas = await notifyCanvasFacts(deps.db, { canvasId: trigger.canvasId });
      if (!canvas) return;
      tellings = await prReadyTellings(deps, canvas, trigger, now);
      break;
    }
    case "review_approved": {
      canvas = await notifyCanvasFacts(deps.db, { canvasId: trigger.canvasId });
      if (!canvas) return;
      const reviewer = personByLogin(canvas, trigger.reviewerLogin);
      const who = prRecipients(
        canvasFactsOf(canvas),
        {
          authorId: personByLogin(canvas, trigger.authorLogin)?.userId ?? null,
          // Never the person who approved it, when they are one of Ponzu's.
          actorId: reviewer?.userId ?? null,
        },
        now,
      );
      const name = canvas.name;
      tellings = who.map((userId) => ({
        userId,
        kind: "pr_approved",
        dedupeKey: dedupeKey.prApproved(trigger.canvasId, trigger.reviewId),
        words: {
          kind: "pr_approved",
          canvasName: name,
          number: trigger.number,
          approver: { name: reviewer?.name ?? null, login: trigger.reviewerLogin },
        },
        link: { open: "pull-request" },
        sourceId: trigger.reviewId,
      }));
      break;
    }
    case "turn_lapsed_twice": {
      canvas = await notifyCanvasFacts(deps.db, {
        canvasId: trigger.canvasId,
        eventId: trigger.eventId,
      });
      if (!canvas) return;
      const name = canvas.name;
      // The person whose message it was: the thread asks them to send it again.
      tellings = personRecipients(
        canvasFactsOf(canvas),
        { personId: canvas.event?.userId ?? null },
        now,
      ).map((userId) => ({
        userId,
        kind: "failed",
        dedupeKey: dedupeKey.lapsed(trigger.canvasId, trigger.eventId),
        words: { kind: "failed", canvasName: name, reason: "lapsed" },
        link: { open: "thread" },
        sourceId: trigger.eventId,
      }));
      break;
    }
    case "wake_failed": {
      canvas = await notifyCanvasFacts(deps.db, { canvasId: trigger.canvasId });
      if (!canvas) return;
      const name = canvas.name;
      // Whoever's message, answer or comment waits for it (no runner took it, so it may not be
      // delivered), else its owner: a wake a check or a review asked for is about their canvas.
      const personId = canvas.waitingFor ?? canvas.ownerId;
      tellings = personRecipients(canvasFactsOf(canvas), { personId }, now).map((userId) => ({
        userId,
        kind: "failed",
        dedupeKey: dedupeKey.wakeFailed(trigger.canvasId, trigger.failedAt),
        words: { kind: "failed", canvasName: name, reason: "wake" },
        link: { open: "thread" },
        sourceId: null,
      }));
      break;
    }
    case "billing": {
      const workspace = await notifyWorkspaceFacts(deps.db, trigger.workspaceId);
      if (!workspace) return;
      const words = billingWords(trigger, workspace);
      tellings = billingRecipients(workspace).map((userId) => ({
        userId,
        kind: BILLING_NOTICE_KIND[trigger.notice],
        dedupeKey: dedupeKey.billing(trigger.notice, trigger.workspaceId, trigger.periodStart),
        words,
        link: { open: "usage" },
        sourceId: null,
      }));
      await tell(deps, job, { canvas: null, workspaceId: workspace.id }, tellings, now);
      return;
    }
  }
  await tell(deps, job, { canvas, workspaceId: canvas.workspaceId }, tellings, now);
}

/** The member of the canvas's workspace with this GitHub login, if any. */
function personByLogin(canvas: NotifyCanvasFacts, login: string | null) {
  if (!login) return null;
  const lower = login.toLowerCase();
  return canvas.people.find((person) => person.login.toLowerCase() === lower) ?? null;
}

/**
 * Who hears that a pull request is ready to merge: the canvas's owner and its author, at most
 * once per canvas per person per `PR_READY_EVERY_MS`, however often new commits make it ready
 * again.
 */
async function prReadyTellings(
  deps: JobDeps,
  canvas: NotifyCanvasFacts,
  trigger: Extract<NotifyTrigger, { kind: "pull_request_ready" }>,
  now: Date,
): Promise<Telling[]> {
  const key = dedupeKey.prReady(trigger.canvasId, trigger.number, trigger.headSha);
  const ready = prRecipients(
    canvasFactsOf(canvas),
    { authorId: personByLogin(canvas, trigger.authorLogin)?.userId ?? null },
    now,
  );
  const last = await lastNotifiedAt(deps.db, {
    canvasId: trigger.canvasId,
    kind: "pr_ready",
    userIds: ready,
    // A row this very trigger wrote on an earlier attempt does not hold itself back.
    exceptDedupeKey: key,
  });
  return ready
    .filter((userId) => !prReadyHeld(last.get(userId) ?? null, now))
    .map((userId) => ({
      userId,
      kind: "pr_ready",
      dedupeKey: key,
      words: { kind: "pr_ready", canvasName: canvas.name, number: trigger.number },
      link: { open: "pull-request" },
      sourceId: null,
    }));
}

/** A billing ping's words: billing's sentences, about the workspace. */
function billingWords(
  trigger: Extract<NotifyTrigger, { kind: "billing" }>,
  facts: NotifyWorkspaceFacts,
): PingWords {
  const workspace: BillingWorkspace = { name: facts.name, personal: facts.kind === "personal" };
  // Set for every notice but free_used (the trigger's schema says so).
  const cents = trigger.amountCents ?? 0;
  switch (trigger.notice) {
    case "free_used":
      return { kind: "billing_free_used", workspace };
    case "cap_warning":
      return { kind: "billing_cap_warning", workspace, capCents: cents };
    case "cap_reached":
      return {
        kind: "billing_cap_reached",
        workspace,
        capCents: cents,
        // The cap resets where the period the notice is about ends.
        resetsOn: billingPeriod(facts.billingPeriodAnchor, new Date(trigger.periodStart)).end,
      };
    case "payment_failed":
      return { kind: "billing_payment_failed", workspace, totalCents: cents };
  }
}

/**
 * A comment row's words once more comments fold into it. `people` are the first names it keeps,
 * in the order they first commented; the sentence names the newest first.
 */
export function collapsedCommentBody(people: readonly string[], count: number): string {
  return commentBody(
    [...people].reverse().map((name) => ({ userId: name, name, login: null })),
    count,
  );
}

/**
 * Who hears of a teammate's comment: the canvas's owner, unless they wrote it. A comment made
 * within `COMMENT_COLLAPSE_MS` of the owner's unread comment ping for the canvas folds into that
 * row (its count and names grow and its words change) and is pushed again under the row's own
 * collapse id, so a phone shows one ping for the lot. Only a comment with no row to fold into is
 * told as a new one.
 */
async function commentTellings(
  deps: JobDeps,
  canvas: NotifyCanvasFacts,
  trigger: Extract<NotifyTrigger, { kind: "comment_posted" }>,
  now: Date,
): Promise<Telling[]> {
  const author = canvas.people.find((person) => person.userId === trigger.authorId);
  const commenter = {
    userId: trigger.authorId,
    name: author?.name ?? null,
    login: author?.login ?? null,
  };
  const first = firstName(commenter);
  const key = dedupeKey.comment(trigger.canvasId, trigger.messageId);
  const link: NotificationLink = {
    open: "comment",
    ...(trigger.pageId ? { pageId: trigger.pageId } : {}),
    ...(trigger.artboardId ? { artboardId: trigger.artboardId } : {}),
    ...(trigger.threadId ? { commentThreadId: trigger.threadId } : {}),
  };
  const tellings: Telling[] = [];
  const who = commentRecipients(canvasFactsOf(canvas), { authorId: trigger.authorId }, now);
  for (const userId of who) {
    const folded = await collapseCommentNotification(deps.db, {
      userId,
      canvasId: canvas.id,
      dedupeKey: key,
      person: first,
      since: new Date(now.getTime() - COMMENT_COLLAPSE_MS),
      now,
      bodyFor: collapsedCommentBody,
    });
    if (folded?.status === "already") continue;
    if (folded?.status === "collapsed") {
      await retell(deps, canvas, folded.notification, now);
      continue;
    }
    tellings.push({
      userId,
      kind: "teammate_comment",
      dedupeKey: key,
      words: { kind: "teammate_comment", canvasName: canvas.name, people: [commenter], count: 1 },
      link,
      sourceId: trigger.messageId,
      people: [first],
    });
  }
  return tellings;
}

/**
 * Push a row again after it changed (a comment folded into it), by the quiet rules as they stand
 * now: nothing if its person is looking at the canvas (it is read) or the row is muted, and
 * otherwise each of their phones again, under the row's own collapse id, so the new words take
 * the old ping's place.
 */
async function retell(
  deps: JobDeps,
  canvas: NotifyCanvasFacts,
  row: Notification,
  now: Date,
): Promise<void> {
  const { db } = deps;
  const [[recipient], focused, recent] = await Promise.all([
    listNotifyRecipients(db, [row.userId]),
    focusedPresence(db, { canvasId: canvas.id, userIds: [row.userId], now }),
    recentPushes(db, { userIds: [row.userId], since: new Date(now.getTime() - HOUR_MS) }),
  ]);
  if (!recipient) return;
  const plan = planDelivery(
    {
      kind: row.kind,
      toggleOn: toggleOn(row.kind, recipient.prefs),
      focusedAt: focused.get(row.userId) ?? null,
      recentPushes: recent,
      devices: recipient.devices.map(deviceFactsOf),
    },
    now,
  );
  if (plan.readNow) {
    await markNotificationsRead(db, { userId: row.userId, ids: [row.id], now, via: plan.readNow });
    return;
  }
  // A row made while the toggle was off stays quiet, whatever the toggle says now.
  if (row.muted || plan.pushes.length === 0) return;
  const waiting = await repushDeliveries(db, {
    rows: plan.pushes.map((push) => ({
      notificationId: row.id,
      deviceId: push.deviceId,
      sendAt: push.sendAt,
    })),
    now,
  });
  if (waiting.length === 0) return;
  const first = Math.min(...plan.pushes.map((push) => push.sendAt.getTime()));
  await scheduleDeliveries(deps, new Map([[row.id, new Date(first)]]), now);
}

/**
 * Each notification's pushes go in one `notification.deliver` job, at the earliest time one is
 * due: now, here and in this run, or later, for the cron. A job already waiting for the
 * notification is left to send them.
 */
async function scheduleDeliveries(
  deps: JobDeps,
  firstSend: ReadonlyMap<string, Date>,
  now: Date,
): Promise<void> {
  for (const [notificationId, sendAt] of firstSend) {
    const due = sendAt.getTime() <= now.getTime();
    const worker = `${DELIVER_JOB}:${crypto.randomUUID()}`;
    const recorded = await enqueueJob(deps.db, {
      kind: DELIVER_JOB,
      key: notificationId,
      payload: { notificationId },
      runAt: sendAt,
      ...(due ? { lockedBy: worker } : {}),
    });
    if (due && recorded) await runJob(deps, recorded, worker);
  }
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
  { canvas, workspaceId }: Scope,
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
      workspaceId,
      canvasId: canvas?.id ?? null,
      kind: telling.kind,
      dedupeKey: telling.dedupeKey,
      title,
      body,
      link: telling.link,
      sourceId: telling.sourceId,
      ...(telling.people ? { people: telling.people } : {}),
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

  const firstSend = new Map<string, Date>();
  for (const delivery of deliveries) {
    const at = firstSend.get(delivery.notificationId);
    if (!at || delivery.sendAt < at) firstSend.set(delivery.notificationId, delivery.sendAt);
  }
  await scheduleDeliveries(deps, firstSend, now);
}
