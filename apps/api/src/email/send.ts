import { emailRecipient } from "@ponzu/db";
import type { RenderedEmail } from "@ponzu/email";
import type { Config, Deps } from "../deps/index.ts";
import { MailError, type MailMessage, mailErrorOf } from "../deps/mail.ts";
import { RetryLater } from "../jobs/retry.ts";
import { EMAIL_KINDS, type EmailKind, emailAllowed, emailPaused } from "./kinds.ts";
import { unsubscribeToken } from "./unsubscribe.ts";

/*
 * The one door every email goes out of (docs/cloud.md, "Email"). A job or script that has
 * something to say calls `sendEmail` with the kind, the person, a key that names this one email,
 * and a way to render it; everything else is decided here, in this order:
 *
 * 1. Email is off (no RESEND_API_KEY): `off`. Nothing is written; the caller stamps nothing.
 * 2. The kind is in PONZU_EMAIL_PAUSED: `paused`. Paused means dropped, not deferred: the
 *    caller stamps as if it went. (Retrying until resumed would use the job's attempts up, since
 *    a `RetryLater` counts as one.)
 * 3. The person's address and switch are read now, never from the job: `no_address` with none
 *    (or no person any more), `opted_out` when the kind's switch is off.
 * 4. Outside production, only an address PONZU_EMAIL_ALLOW names may be emailed: `held`
 *    otherwise, and an unset allowlist holds everything. Resend is never asked.
 * 5. It renders, with the kind's unsubscribe link when it has one.
 * 6. Headers: `List-Unsubscribe` and its one-click partner for a kind that can be turned off;
 *    `[Dev] ` before the subject outside production.
 * 7. Resend is asked, with the key as its Idempotency-Key, so a retry within a day sends once.
 * 8. Its answer: taken is `sent`; `duplicate` (the key's email went already) counts as sent;
 *    `rejected` is `refused`, reported and not tried again; `rate_limited` and `unavailable`
 *    throw `RetryLater`, so the job tries again in five minutes with the same key.
 *
 * Every answer but `off` and a thrown `RetryLater` is final: the caller stamps its email done.
 * Logs and events carry the kind and the key, never an address, a subject or a body.
 */

/** What became of one email. */
export type SendOutcome =
  | "sent"
  | "duplicate"
  | "refused"
  | "held"
  | "paused"
  | "off"
  | "no_address"
  | "opted_out";

/** What `render` is handed: the email's unsubscribe link, for a kind that has one. */
export interface RenderParts {
  unsubscribeUrl: string | null;
}

export interface SendRequest {
  kind: EmailKind;
  /** Who it is for. Their address is read now. */
  userId: string;
  /**
   * What names this one email: the job's key, sent as Resend's Idempotency-Key. At most 256
   * characters. The same key must always render the same email.
   */
  key: string;
  render(parts: RenderParts): Promise<RenderedEmail> | RenderedEmail;
}

/** What became of one email, with where it went and Resend's id for it when it was taken. */
export interface SendResult {
  outcome: SendOutcome;
  /** The address it was for, read at send time; null when it was not read or there was none. */
  address: string | null;
  /** Resend's id, when Resend took it (`sent`). */
  resendId: string | null;
}

/** The settings `sendEmail` reads: a deployment's, or the notice script's few. */
export interface SendConfig {
  build: Pick<Config["build"], "environment">;
  email: Config["email"];
  sandbox: Pick<Config["sandbox"], "apiUrl">;
}

/** What `sendEmail` reads: a job's deps, or a script's. */
export type SendDeps = Pick<Deps, "db" | "log" | "mail" | "vault" | "analytics"> & {
  config: SendConfig;
};

/** How long a send Resend could not take now waits before it is tried again. */
export const SEND_RETRY_MS = 5 * 60_000;

/** Resend's longest Idempotency-Key. */
export const IDEMPOTENCY_KEY_MAX = 256;

/** The subject's mark outside production. */
export const DEV_SUBJECT_PREFIX = "[Dev] ";

/** Where an unsubscribe link goes: this API's own address, so dev's mail stops dev's email. */
export async function unsubscribeUrl(
  deps: Pick<Deps, "vault"> & { config: Pick<SendConfig, "sandbox"> },
  userId: string,
  category: NonNullable<(typeof EMAIL_KINDS)[EmailKind]["unsubscribe"]>,
): Promise<string> {
  const url = new URL("/v1/email/unsubscribe", deps.config.sandbox.apiUrl);
  url.searchParams.set("t", await unsubscribeToken(deps.vault, userId, category));
  return url.toString();
}

export async function sendEmail(deps: SendDeps, request: SendRequest): Promise<SendOutcome> {
  return (await deliverEmail(deps, request)).outcome;
}

/**
 * `sendEmail`, answering also the address it was for and Resend's id: what a legal notice's
 * record keeps. Nothing else about it differs.
 */
export async function deliverEmail(deps: SendDeps, request: SendRequest): Promise<SendResult> {
  const { kind, userId, key } = request;
  const { log, config } = deps;
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX) {
    throw new Error(`An email's key is 1 to ${IDEMPOTENCY_KEY_MAX} characters.`);
  }
  const ended = (outcome: SendOutcome, address: string | null = null): SendResult => ({
    outcome,
    address,
    resendId: null,
  });
  if (!deps.mail.enabled) return ended("off");
  if (emailPaused(config.email, kind)) {
    log.info("email_paused", { kind, job: key });
    return ended("paused");
  }

  const rules = EMAIL_KINDS[kind];
  const person = await emailRecipient(deps.db, userId);
  if (!person?.email) {
    log.info("email_no_address", { kind, job: key });
    return ended("no_address");
  }
  if (rules.pref !== null && !person[rules.pref]) {
    log.info("email_opted_out", { kind, job: key });
    return ended("opted_out", person.email);
  }

  const production = config.build.environment === "production";
  if (!production && !emailAllowed(config.email.allow, person.email)) {
    log.info("email_held", { kind, job: key });
    return ended("held", person.email);
  }

  const unsubscribe = rules.unsubscribe
    ? await unsubscribeUrl(deps, userId, rules.unsubscribe)
    : null;
  const rendered = await request.render({ unsubscribeUrl: unsubscribe });
  const message: MailMessage = {
    to: person.email,
    subject: production ? rendered.subject : `${DEV_SUBJECT_PREFIX}${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    headers: unsubscribe
      ? {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : {},
    idempotencyKey: key,
    ...(config.email.replyTo ? { replyTo: config.email.replyTo } : {}),
    tags: [
      { name: "kind", value: kind },
      { name: "env", value: config.build.environment },
    ],
  };

  let resendId: string;
  try {
    ({ id: resendId } = await deps.mail.send(message));
  } catch (error) {
    const failure = error instanceof MailError ? error : mailErrorOf(null);
    if (failure.code === "rate_limited" || failure.code === "unavailable") {
      throw new RetryLater(SEND_RETRY_MS, `Resend could not take the email: ${failure.code}.`);
    }
    if (failure.code === "duplicate") {
      // This key's email went already: it is sent, once.
      log.warn("email_duplicate", { kind, job: key });
      deps.analytics.capture("email sent", { kind }, { distinctId: userId });
      return ended("duplicate", person.email);
    }
    log.error("email_refused", {
      kind,
      job: key,
      failure: failure.code,
      status: failure.status,
      resendCode: failure.resendCode,
    });
    deps.analytics.capture(
      "email refused",
      { kind, failure: failure.resendCode ?? failure.code },
      { distinctId: userId },
    );
    deps.analytics.exception(failure, { email: kind });
    return ended("refused", person.email);
  }
  log.info("email_sent", { kind, job: key });
  deps.analytics.capture("email sent", { kind }, { distinctId: userId });
  return { outcome: "sent", address: person.email, resendId };
}
