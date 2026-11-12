import { type EventKind, QUESTION_KINDS } from "@ponzu/db/types";
import type { RunErrorCode } from "@ponzu/runner/protocol";
import { z } from "zod";

/*
 * What Ponzu pings a person about, and the triggers that product code hands to `notify`
 * (docs/cloud.md, "Notifications"). Pure: no database, no SDK, no clock.
 *
 * A kind names one thing worth a ping. Each is under one of the person's toggles in Settings ›
 * Notifications, except the billing kinds, which are always on and go to a workspace's admins.
 * Mentions and the notifications spec's `cap_80` and `cap_reached` are not built: the billing
 * kinds take the cap's place, with billing's words (copy.ts).
 *
 * A trigger carries ids, numbers and fixed words only, never anything a person or the agent
 * wrote: the schema below is the allowlist of what reaches the `notify` job, and an id is
 * refused unless it has an id's shape.
 */

export const NOTIFICATION_KINDS = [
  "needs_you",
  "reply",
  "finished",
  "failed",
  "claude_limit",
  "pr_ready",
  "pr_approved",
  "teammate_comment",
  "billing_free_used",
  "billing_cap_warning",
  "billing_cap_reached",
  "billing_payment_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The toggles of `prefs` that a kind can be under (`GET /v1/me/notifications`). */
export type PingToggle = "needsYou" | "replies" | "prReady" | "teammateComments";

/** Each kind's toggle; null is always on. */
export const KIND_TOGGLE: Record<NotificationKind, PingToggle | null> = {
  needs_you: "needsYou",
  reply: "replies",
  finished: "needsYou",
  failed: "needsYou",
  claude_limit: "needsYou",
  pr_ready: "prReady",
  pr_approved: "prReady",
  teammate_comment: "teammateComments",
  billing_free_used: null,
  billing_cap_warning: null,
  billing_cap_reached: null,
  billing_payment_failed: null,
};

export const BILLING_KINDS = [
  "billing_free_used",
  "billing_cap_warning",
  "billing_cap_reached",
  "billing_payment_failed",
] as const satisfies NotificationKind[];
export type BillingKind = (typeof BILLING_KINDS)[number];

/** The kinds the hourly push limit neither counts nor stops (plan.ts). */
export const RATE_EXEMPT_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "needs_you",
  ...BILLING_KINDS,
]);

export function isBillingKind(kind: NotificationKind): kind is BillingKind {
  return (BILLING_KINDS as readonly NotificationKind[]).includes(kind);
}

/**
 * Where a ping opens: the canvas's thread, its pull request, a comment's pin, or Plan and usage.
 * The words are the shared link grammar's (`open` on a canvas link, which comes with the link
 * groundwork in `@ponzu/core/links`).
 */
export const NOTIFICATION_OPENS = ["thread", "pull-request", "comment", "usage"] as const;
export type NotificationOpen = (typeof NOTIFICATION_OPENS)[number];

export const KIND_OPENS: Record<NotificationKind, NotificationOpen> = {
  needs_you: "thread",
  reply: "thread",
  finished: "thread",
  failed: "thread",
  claude_limit: "thread",
  pr_ready: "pull-request",
  pr_approved: "pull-request",
  teammate_comment: "comment",
  billing_free_used: "usage",
  billing_cap_warning: "usage",
  billing_cap_reached: "usage",
  billing_payment_failed: "usage",
};

/** A question still open this long after it was raised reaches the canvas's other steerers. */
export const QUESTION_ESCALATE_MS = 5 * 60_000;
/** A turn must have worked longer than this for "finished" to be worth a ping. */
export const FINISHED_MIN_MS = 60_000;

/** An id as the API makes them, or as GitHub and the runner give them: at most 64 safe characters. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const Id = z.string().regex(ID);
/** A GitHub login, or an app's (`ponzu[bot]`). */
const Login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/);
const Sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Instant = z.iso.datetime({ offset: false });
const PrNumber = z.number().int().min(1).max(2_147_483_647);

/** A turn report's error codes, as the runner protocol lists them; others are refused. */
const RUN_ERROR_CODES = [
  "clone_failed",
  "claude_auth",
  "claude_limit",
  "model_unavailable",
  "max_turns",
  "turn_failed",
  "agent_exited",
  "message_refused",
  "question_failed",
  "push_failed",
  "elicitation_unsupported",
] as const satisfies RunErrorCode[];
// And every code the protocol has is listed: a new one fails the typecheck here rather than
// making `notify` refuse a turn that failed with it.
const everyRunErrorCode: readonly (typeof RUN_ERROR_CODES)[number][] = [] as RunErrorCode[];
void everyRunErrorCode;

export const BILLING_NOTICES = [
  "free_used",
  "cap_warning",
  "cap_reached",
  "payment_failed",
] as const;
export type BillingNotice = (typeof BILLING_NOTICES)[number];

export const NotifyTrigger = z.discriminatedUnion("kind", [
  /** The runner raised a question (`POST /v1/runner/questions` answered `raised`). */
  z.strictObject({
    kind: z.literal("question_raised"),
    canvasId: Id,
    questionId: Id,
    questionKind: z.enum(QUESTION_KINDS),
  }),
  /** The same question, `QUESTION_ESCALATE_MS` on: it reaches the other steerers if still open. */
  z.strictObject({
    kind: z.literal("question_escalate"),
    canvasId: Id,
    questionId: Id,
    questionKind: z.enum(QUESTION_KINDS),
  }),
  /** A turn report (`POST /v1/runner/usage`): reply, finished, failed or a Claude limit. */
  z.strictObject({
    kind: z.literal("turn_finished"),
    canvasId: Id,
    turnId: Id,
    eventId: Id.nullable(),
    outcome: z.enum(["completed", "failed", "stopped"]),
    errorCode: z.enum(RUN_ERROR_CODES).nullable(),
    durationMs: z.number().int().min(0),
  }),
  /** A person's comment was committed to the canvas. */
  z.strictObject({
    kind: z.literal("comment_posted"),
    canvasId: Id,
    messageId: Id,
    authorId: Id,
  }),
  /** `recordRead` found the pull request open, not a draft, checks passing and mergeable. */
  z.strictObject({
    kind: z.literal("pull_request_ready"),
    canvasId: Id,
    number: PrNumber,
    headSha: Sha,
    authorLogin: Login.nullable(),
  }),
  /** A review approved the pull request. */
  z.strictObject({
    kind: z.literal("review_approved"),
    canvasId: Id,
    number: PrNumber,
    reviewId: Id,
    reviewerLogin: Login,
    authorLogin: Login.nullable(),
  }),
  /** A copy of a message that had lapsed lapsed again: the thread says to send it again. */
  z.strictObject({ kind: z.literal("turn_lapsed_twice"), canvasId: Id, eventId: Id }),
  /** A wake gave up (`sandbox_failed`). */
  z.strictObject({ kind: z.literal("wake_failed"), canvasId: Id, failedAt: Instant }),
  /**
   * A billing gate transition (`refreshBillingGate`). `amountCents` is the cap for the two cap
   * notices, the invoice's total for a failed payment, and null for free credits used; any
   * other pairing is refused, so a ping never reads "$0".
   */
  z
    .strictObject({
      kind: z.literal("billing"),
      workspaceId: Id,
      periodStart: Instant,
      notice: z.enum(BILLING_NOTICES),
      amountCents: z.number().int().min(0).nullable(),
    })
    .refine((trigger) => (trigger.notice === "free_used") === (trigger.amountCents === null), {
      message: "amountCents is null for free_used and set for every other notice",
      path: ["amountCents"],
    }),
]);
export type NotifyTrigger = z.infer<typeof NotifyTrigger>;

/** The `notify` job's key for a trigger: the same trigger twice is one job. */
export function triggerKey(trigger: NotifyTrigger): string {
  switch (trigger.kind) {
    case "question_raised":
    case "question_escalate":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.questionId}`;
    case "turn_finished":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.turnId}`;
    case "comment_posted":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.messageId}`;
    case "pull_request_ready":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.number}:${trigger.headSha}`;
    case "review_approved":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.reviewId}`;
    case "turn_lapsed_twice":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.eventId}`;
    case "wake_failed":
      return `${trigger.kind}:${trigger.canvasId}:${trigger.failedAt}`;
    case "billing":
      return `${trigger.kind}:${trigger.notice}:${trigger.workspaceId}:${trigger.periodStart}`;
  }
}

/**
 * Each notification's dedupe key, unique per recipient: the same thing never makes two rows for
 * one person, however often its trigger runs.
 */
export const dedupeKey = {
  needsYou: (canvasId: string, questionId: string) => `needs_you:${canvasId}:${questionId}`,
  reply: (canvasId: string, turnId: string) => `reply:${canvasId}:${turnId}`,
  finished: (canvasId: string, turnId: string) => `finished:${canvasId}:${turnId}`,
  failedTurn: (canvasId: string, turnId: string) => `failed:${canvasId}:${turnId}`,
  lapsed: (canvasId: string, eventId: string) => `lapsed:${canvasId}:${eventId}`,
  wakeFailed: (canvasId: string, failedAt: string) => `wake_failed:${canvasId}:${failedAt}`,
  /** One a day per Claude account, by the UTC date. */
  claudeLimit: (claudeAccountId: string, at: Date) =>
    `limit:${claudeAccountId}:${at.toISOString().slice(0, 10)}`,
  prReady: (canvasId: string, number: number, headSha: string) =>
    `pr_ready:${canvasId}:${number}:${headSha}`,
  prApproved: (canvasId: string, reviewId: string) => `pr_approved:${canvasId}:${reviewId}`,
  comment: (canvasId: string, messageId: string) => `comment:${canvasId}:${messageId}`,
  /** Once a period each, per notice. */
  billing: (notice: BillingNotice, workspaceId: string, periodStart: string) =>
    `billing:${notice}:${workspaceId}:${periodStart}`,
};

/** The billing kind each notice is. */
export const BILLING_NOTICE_KIND: Record<BillingNotice, BillingKind> = {
  free_used: "billing_free_used",
  cap_warning: "billing_cap_warning",
  cap_reached: "billing_cap_reached",
  payment_failed: "billing_payment_failed",
};

/** Why a turn's "failed" ping is sent, which picks its words. */
export type FailedReason = "turn" | "claude_auth" | "lapsed" | "wake";

/** What a finished turn is worth, by its report. */
export type TurnPing =
  | { kind: "reply" }
  | { kind: "finished" }
  | { kind: "failed"; reason: "turn" | "claude_auth" }
  | { kind: "claude_limit" }
  | null;

/**
 * What a turn report pings, if anything:
 *
 * - a stop: nothing (the person stopped it);
 * - failed at a Claude limit: `claude_limit`; failed any other way: `failed`;
 * - completed, begun by a comment: `reply`;
 * - completed, begun by a message or an answer, after more than `FINISHED_MIN_MS` of work, with
 *   no question of the canvas open: `finished`;
 * - anything else (no event began it, a short turn, an edit, a check or a review): nothing.
 */
export function turnPing(report: {
  outcome: "completed" | "failed" | "stopped";
  errorCode: RunErrorCode | null;
  durationMs: number;
  /** The kind of the event that began the turn, or null when none did. */
  eventKind: EventKind | null;
  questionOpen: boolean;
}): TurnPing {
  if (report.outcome === "stopped") return null;
  if (report.outcome === "failed") {
    if (report.errorCode === "claude_limit") return { kind: "claude_limit" };
    return { kind: "failed", reason: report.errorCode === "claude_auth" ? "claude_auth" : "turn" };
  }
  if (report.eventKind === "comment") return { kind: "reply" };
  if (report.eventKind !== "message" && report.eventKind !== "answer") return null;
  if (report.durationMs <= FINISHED_MIN_MS || report.questionOpen) return null;
  return { kind: "finished" };
}
