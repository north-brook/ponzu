import {
  claimEmailNotice,
  countWithoutAddress,
  type EmailNoticeOutcome,
  emailNoticeRecords,
  existingUsers,
  finishEmailNotice,
  getMemberWorkspace,
  getWorkspace,
  noticeAudience,
} from "@ponzu/db";
import { PUBLISHED_RATE_CARD } from "@ponzu/db/rate-card";
import {
  type NoticeProps,
  type RenderedEmail,
  renderEmail,
  SUSPENSION_REASON_MAX,
} from "@ponzu/email";
import type { Deps } from "../deps/index.ts";
import { RetryLater } from "../jobs/retry.ts";
import { capDollars, dollarsAndCents, resetDay } from "../notifications/copy.ts";
import type { NoticeDay, NoticeFile } from "./notices/index.ts";
import { deliverEmail, type SendDeps } from "./send.ts";

/*
 * Legal notices by email (docs/cloud.md, "Email"): what Ponzu's terms and privacy policy promise
 * to tell people by email, sent by the founder with apps/api/scripts/notice.ts and never by a
 * trigger. Each goes through `sendEmail` as kind `notice`: no preference, no unsubscribe, never
 * paused, and outside production only to PONZU_EMAIL_ALLOW.
 *
 * Each person's notice is recorded in `email_notices`, because someone may later ask whether
 * they were told, and neither Resend (30 days) nor the logs (no addresses) could say:
 * 1. Before the send, a `pending` row, unless the person has a row already.
 * 2. The send, with the idempotency key `notice/<notice>/<person>`.
 * 3. After it, the outcome (`sent`, `refused`, `no_address` or `held`), the address it was for,
 *    and Resend's id.
 * A rerun skips everyone whose row is not `pending`. A `pending` row (the script stopped between
 * 2 and 3) is sent again with the same key while it is less than 24 hours old, which Resend
 * answers with the first email's id rather than a second email; an older one, when Resend's key
 * may have expired, is listed for the founder and never sent again by the script. So nobody can
 * be sent a notice twice.
 *
 * The script asks Resend at most 5 times a second, so the API's own emails stay under Resend's
 * 10 a second for the team. It refuses to send a dated notice less than 30 days before it takes
 * effect (the terms' promise), except `terms_change` with `sooner` (the terms' "sooner if the law
 * or stopping abuse needs it"); a suspension has no date.
 */

/** How many times a second the script may ask Resend. */
export const NOTICE_SENDS_PER_SECOND = 5;
const NOTICE_SPACING_MS = 1000 / NOTICE_SENDS_PER_SECOND;

/** How long Resend keeps an idempotency key: a `pending` row older than this is never resent. */
export const NOTICE_PENDING_MAX_MS = 24 * 60 * 60_000;

/** How many days ahead a dated notice must go. */
export const NOTICE_LEAD_DAYS = 30;

/** A suspension's case: a short id the founder picks, so each suspension has its own records. */
export const NOTICE_CASE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What the founder asked for. */
export interface NoticeRequest {
  notice: NoticeFile;
  /** Only these people (`--user`); for a suspension, exactly the people suspended. */
  users: readonly string[] | null;
  /** A suspension's case id (`--case`). */
  caseId?: string | null;
  /** The suspended workspace, for a suspension of one (`--workspace`). */
  workspaceId?: string | null;
  /** A suspension's reason, as the founder wrote it (`--reason-file`). */
  reason?: string | null;
  /** Send a terms change less than 30 days ahead (`--sooner`). */
  sooner?: boolean;
}

export type NoticeDeps = SendDeps & Pick<Deps, "clock">;

/** The id a notice's records carry: the file's, and for a suspension its case too. */
export function noticeRecordId(request: NoticeRequest): string {
  return request.notice.kind === "suspension"
    ? `${request.notice.id}/${request.caseId}`
    : request.notice.id;
}

/** Resend's idempotency key for one person's notice. */
export function noticeKey(recordId: string, userId: string): string {
  return `notice/${recordId}/${userId}`;
}

/** "February 1": the day a notice takes effect, as its midnight UTC falls. */
export function effectiveText(day: NoticeDay): string {
  return resetDay(dayStart(day));
}

function dayStart(day: NoticeDay): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** What is wrong with the request whenever it is made, or null. */
export function requestProblem(request: NoticeRequest): string | null {
  const { notice, users, caseId, workspaceId, reason } = request;
  if (users !== null && users.length === 0) return "--user names nobody.";
  if (notice.kind === "suspension") {
    if (!users) return "A suspension names the people suspended with --user.";
    if (!caseId || !NOTICE_CASE.test(caseId)) {
      return "A suspension needs --case <id>: lowercase letters, digits and -, at most 40.";
    }
    if (!reason?.trim()) return "A suspension needs its reason, with --reason-file.";
    if ([...reason].length > SUSPENSION_REASON_MAX) {
      return `A suspension's reason is at most ${SUSPENSION_REASON_MAX} characters.`;
    }
    return null;
  }
  if (caseId || workspaceId || reason) {
    return "--case, --workspace and --reason-file are for a suspension only.";
  }
  if (request.sooner && notice.kind !== "terms_change") {
    return "--sooner is for a terms change only.";
  }
  return null;
}

/**
 * Why the notice may not be sent now, or null when it may. Checked before anything is written.
 */
export function sendRefusal(
  request: NoticeRequest,
  {
    now,
    environment,
    mailEnabled,
    allowlisted,
  }: { now: Date; environment: string; mailEnabled: boolean; allowlisted: boolean },
): string | null {
  const problem = requestProblem(request);
  if (problem) return problem;
  if (!mailEnabled) return "RESEND_API_KEY is not set: email is off, so nothing is sent.";
  const { notice } = request;
  if (notice.devOnly && environment === "production") {
    return `${notice.id} is a check for dev only, never sent on production.`;
  }
  // Off production only PONZU_EMAIL_ALLOW is emailed and everyone else is recorded `held`, for
  // good. Without an allowlist that would be everyone: a PONZU_ENVIRONMENT mistyped against
  // production's database would close the notice to every person in it.
  if (environment !== "production" && !allowlisted) {
    return `PONZU_EMAIL_ALLOW is not set: on ${environment} nobody could be sent it, and everyone would be recorded held.`;
  }
  if (notice.kind === "suspension") return null;
  if (notice.effective === null) {
    return `${notice.id} has no day it takes effect yet: write it in its file first.`;
  }
  const lead = dayStart(notice.effective).getTime() - now.getTime();
  if (lead < NOTICE_LEAD_DAYS * 24 * 60 * 60_000 && !request.sooner) {
    return `${notice.id} takes effect less than ${NOTICE_LEAD_DAYS} days from now, sooner than the terms promise.`;
  }
  return null;
}

/** What `sendRefusal` reads from the deps, now. */
export function refusalFacts(deps: Pick<NoticeDeps, "clock" | "config" | "mail">) {
  return {
    now: new Date(deps.clock.now()),
    environment: deps.config.build.environment,
    mailEnabled: deps.mail.enabled,
    allowlisted: deps.config.email.allow !== null,
  };
}

/** The notice's email as everyone it goes to gets it: no notice carries anything personal. */
export async function noticeProps(
  deps: Pick<NoticeDeps, "db" | "config">,
  request: NoticeRequest,
): Promise<NoticeProps> {
  const replyTo = deps.config.email.replyTo !== null;
  const { notice } = request;
  if (notice.kind === "suspension") {
    const workspace = request.workspaceId ? await getWorkspace(deps.db, request.workspaceId) : null;
    if (request.workspaceId && !workspace) throw new Error("No such workspace.");
    return {
      notice: "suspension",
      workspaceName: workspace?.name ?? null,
      reason: request.reason ?? "",
      replyTo,
    };
  }
  if (notice.effective === null) throw new Error(`${notice.id} has no day it takes effect yet.`);
  const effective = effectiveText(notice.effective);
  switch (notice.kind) {
    case "billing_starts": {
      const card = PUBLISHED_RATE_CARD;
      return {
        notice: "billing_starts",
        effective,
        free: `${card.freeCreditsPerMember} free credits for each member`,
        price: dollarsAndCents(card.creditMicrousd / 10_000),
        cap: capDollars(card.defaultCapCents),
        replyTo,
      };
    }
    case "price_rise":
      return {
        notice: "price_rise",
        effective,
        oldPrice: notice.oldPrice,
        newPrice: notice.newPrice,
        replyTo,
      };
    case "terms_change":
    case "privacy_change":
    case "shutdown":
      return { notice: notice.kind, effective, summary: notice.summary, replyTo };
  }
}

export function renderNotice(props: NoticeProps): Promise<RenderedEmail> {
  return renderEmail("notice", props);
}

/** Who a notice is for, and what is already recorded for them. Reads only. */
export interface NoticePlan {
  recordId: string;
  /** Everyone it is for, by id. */
  recipients: string[];
  /**
   * People `--user` named who are not among those the notice is for: no account, or for a
   * workspace's suspension, not a member of it.
   */
  outside: string[];
  /** Of the recipients, how many have no address now. */
  withoutAddress: number;
  /** Of the recipients, how many each finished outcome has. */
  done: Record<Exclude<EmailNoticeOutcome, "pending">, number>;
  /** Recipients with a `pending` row young enough to be sent again with the same key. */
  retry: number;
  /** Recipients with a `pending` row older than 24 hours: listed, never sent again. */
  stale: string[];
  /** Recipients with no row yet. */
  fresh: number;
}

export async function planNotice(
  deps: Pick<NoticeDeps, "db" | "clock">,
  request: NoticeRequest,
): Promise<NoticePlan> {
  const { db } = deps;
  const recordId = noticeRecordId(request);
  let recipients: string[];
  if (request.notice.kind === "suspension") {
    recipients = await existingUsers(db, request.users ?? []);
    const { workspaceId } = request;
    if (workspaceId) {
      // A workspace's suspension names the workspace: only its members may be told, so a
      // mistyped --user never tells a stranger about someone else's workspace.
      const members = await Promise.all(
        recipients.map((userId) => getMemberWorkspace(db, { userId, workspaceId })),
      );
      recipients = recipients.filter((_, at) => members[at] !== null);
    }
  } else {
    const audience = await noticeAudience(
      db,
      request.notice.kind === "billing_starts" || request.notice.kind === "price_rise"
        ? "billing"
        : "everyone",
    );
    const named = request.users ? new Set(request.users) : null;
    recipients = named ? audience.filter((id) => named.has(id)) : audience;
  }
  const listed = new Set(recipients);
  const outside = [...new Set(request.users ?? [])].filter((id) => !listed.has(id)).sort();

  const records = await emailNoticeRecords(db, recordId);
  const now = deps.clock.now();
  const done = { sent: 0, refused: 0, no_address: 0, held: 0 };
  const stale: string[] = [];
  let retry = 0;
  let fresh = 0;
  for (const userId of recipients) {
    const record = records.get(userId);
    if (!record) fresh++;
    else if (record.outcome !== "pending") done[record.outcome]++;
    else if (now - record.createdAt.getTime() >= NOTICE_PENDING_MAX_MS) stale.push(userId);
    else retry++;
  }
  return {
    recordId,
    recipients,
    outside,
    withoutAddress: await countWithoutAddress(db, recipients),
    done,
    retry,
    stale,
    fresh,
  };
}

/** What one `--send` did. */
export interface NoticeReport {
  recordId: string;
  /** What this run recorded, by outcome. */
  outcomes: Record<Exclude<EmailNoticeOutcome, "pending">, number>;
  /** Recipients skipped because their notice was already finished. */
  alreadyDone: number;
  /** `pending` rows older than 24 hours: never sent again; the founder looks at each. */
  stale: string[];
  /**
   * Set when Resend asked to wait (a rate limit, or it was down): the run stopped there and the
   * person it was sending to keeps a `pending` row. Run it again within 24 hours.
   */
  stoppedEarly: string | null;
}

/**
 * Send the notice to everyone it is for who has not had it. The caller has checked
 * `sendRefusal`; this checks it again and throws, so nothing is written when it would refuse.
 */
export async function sendNotice(deps: NoticeDeps, request: NoticeRequest): Promise<NoticeReport> {
  const refusal = sendRefusal(request, refusalFacts(deps));
  if (refusal) throw new Error(refusal);
  const plan = await planNotice(deps, request);
  if (plan.outside.length > 0) {
    throw new Error(`${plan.outside.length} of the people --user names are not ones it is for.`);
  }
  // Rendered once: everyone gets the same bytes, so a resend under the same key is the same email.
  const rendered = await renderNotice(await noticeProps(deps, request));
  const { recordId } = plan;
  const workspaceId = request.notice.kind === "suspension" ? (request.workspaceId ?? null) : null;
  const report: NoticeReport = {
    recordId,
    outcomes: { sent: 0, refused: 0, no_address: 0, held: 0 },
    alreadyDone: 0,
    stale: [],
    stoppedEarly: null,
  };
  // When Resend may next be asked; moved on only by a request that reached it.
  let nextAt = 0;
  for (const userId of plan.recipients) {
    const now = deps.clock.now();
    const record = await claimEmailNotice(deps.db, {
      noticeId: recordId,
      userId,
      workspaceId,
      now: new Date(now),
    });
    if (record.outcome !== "pending") {
      report.alreadyDone++;
      continue;
    }
    if (now - record.createdAt.getTime() >= NOTICE_PENDING_MAX_MS) {
      report.stale.push(userId);
      continue;
    }

    const wait = nextAt - deps.clock.now();
    if (wait > 0) await deps.clock.sleep(wait);
    const askedAt = deps.clock.now();
    let result: Awaited<ReturnType<typeof deliverEmail>>;
    try {
      result = await deliverEmail(deps, {
        kind: "notice",
        userId,
        key: noticeKey(recordId, userId),
        render: () => rendered,
      });
    } catch (error) {
      if (!(error instanceof RetryLater)) throw error;
      report.stoppedEarly = "Resend asked to wait (a rate limit, or it was unavailable).";
      break;
    }
    if (["sent", "duplicate", "refused"].includes(result.outcome)) {
      nextAt = askedAt + NOTICE_SPACING_MS;
    }
    const outcome = recordedOutcome(result.outcome);
    await finishEmailNotice(deps.db, {
      noticeId: recordId,
      userId,
      outcome,
      address: result.address,
      resendId: result.resendId,
      sentAt: outcome === "sent" ? new Date(deps.clock.now()) : null,
    });
    report.outcomes[outcome]++;
  }
  return report;
}

function recordedOutcome(
  outcome: Awaited<ReturnType<typeof deliverEmail>>["outcome"],
): Exclude<EmailNoticeOutcome, "pending"> {
  switch (outcome) {
    case "sent":
    case "duplicate":
      return "sent";
    case "refused":
    case "no_address":
    case "held":
      return outcome;
    default:
      // A notice has no switch and is never paused, and the script refuses while email is off.
      throw new Error(`A notice cannot end ${outcome}.`);
  }
}
