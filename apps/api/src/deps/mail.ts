/*
 * Email, through Resend with its own SDK (`resend`, pinned exactly). Ponzu sends one kind of
 * email: the daily digest (notifications/digest.ts). This is the only file that imports the SDK
 * (mail.surface.test.ts holds it to that). It is off, as `noMail`, until RESEND_API_KEY is set,
 * and then Settings hides the Email row.
 *
 * What may be logged: Resend's error name and status, never an address, a subject, a body or
 * the SDK's own error message. A `MailError` is built from those safe parts only and carries no
 * `cause`, so logging one, or reporting it to error tracking, is safe too.
 */

import type { Clock } from "@ponzu/sandbox";
import { Resend } from "resend";
import type { Logger } from "../http/log.ts";

/** One email. */
export interface MailMessage {
  /** One address. */
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, like `List-Unsubscribe`. */
  headers: Record<string, string>;
  /**
   * Sent as `Idempotency-Key`: Resend sends an email for a key once in 24 hours, so a retry
   * after a request that went out but was never answered does not send it twice.
   */
  idempotencyKey: string;
}

export interface Mail {
  /** False when email is off: nothing can be sent. */
  readonly enabled: boolean;
  /** Sends one email and answers Resend's id for it. Throws `MailError` when it was not taken. */
  send(message: MailMessage): Promise<{ id: string }>;
}

/** How long one send may take. The SDK's `fetch` has no deadline of its own. */
export const MAIL_DEADLINE_MS = 10_000;

/** Where Resend is: fixed, so no environment variable the SDK reads can send mail elsewhere. */
const RESEND_URL = "https://api.resend.com";

/**
 * Why a send failed:
 * - `rate_limited`: Resend answered 429 (its rate, or a daily or monthly quota). Try later.
 * - `unavailable`: Resend answered 5xx, never answered (the network, or the deadline), or is
 *   still working on another request with the same key. Try later with the same key: if the
 *   first went out, Resend answers it again rather than sending a second.
 * - `duplicate`: this key was used in the last 24 hours for an email that was not the same. The
 *   email for this key went out already; do not send another.
 * - `rejected`: Resend refused the email (a bad address, an unverified sender, the API key).
 *   Trying the same email again will not help.
 */
export type MailErrorCode = "rate_limited" | "unavailable" | "duplicate" | "rejected";

export class MailError extends Error {
  readonly code: MailErrorCode;
  /** Resend's HTTP status, when it answered. */
  readonly status: number | null;
  /** Resend's own name for the error (`validation_error`, `rate_limit_exceeded`), when it gave one. */
  readonly resendCode: string | null;

  constructor(code: MailErrorCode, status: number | null = null, resendCode: string | null = null) {
    super(
      `Resend failed: ${code}${status === null ? "" : `, status ${status}`}${resendCode ? `, ${resendCode}` : ""}.`,
    );
    this.name = "MailError";
    this.code = code;
    this.status = status;
    this.resendCode = resendCode;
  }
}

/** Mail while RESEND_API_KEY is unset: off, and anything asked of it is a caller's mistake. */
export const noMail: Mail = {
  enabled: false,
  send: async () => {
    throw new Error("Email is off: RESEND_API_KEY is not set.");
  },
};

/** What Ponzu's emails come from when PONZU_EMAIL_FROM is unset. */
export const DEFAULT_EMAIL_FROM = "Ponzu <ping@ponzu.design>";

export interface ResendMailConfig {
  apiKey: string;
  /** The From line, like `Ponzu <ping@ponzu.design>`, on a domain verified at Resend. */
  from: string;
  clock: Clock;
  log: Logger;
}

/** Mail through Resend. The SDK calls the global `fetch`; it has no way to be handed one. */
export function createResendMail({ apiKey, from, clock, log }: ResendMailConfig): Mail {
  const resend = new Resend(apiKey, { baseUrl: RESEND_URL });
  return {
    enabled: true,
    async send(message) {
      let answer: Awaited<ReturnType<typeof resend.emails.send>> | null = null;
      try {
        // The SDK never throws for Resend's answer: it hands back `{ data, error }`. A network
        // failure, or the deadline's abort, comes back as an error with no status.
        answer = await resend.emails.send(
          {
            from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            headers: message.headers,
          },
          { idempotencyKey: message.idempotencyKey, signal: clock.timeout(MAIL_DEADLINE_MS) },
        );
      } catch {
        // Thrown only when the deadline cut off reading an error's body: nothing was answered.
      }
      const id = answer?.data?.id;
      if (answer && !answer.error && typeof id === "string") return { id };
      const failure = answer ? mailErrorOf(answer.error) : new MailError("unavailable");
      // `failure`, not `code`: the log's redaction takes any field named `code` for a secret.
      log.warn("mail_send_failed", {
        failure: failure.code,
        status: failure.status,
        resendCode: failure.resendCode,
      });
      throw failure;
    },
  };
}

/**
 * Resend's error as a `MailError`, from its status and name alone; its message can quote the
 * address. No error at all (an answer in a shape the SDK did not expect) is `rejected`.
 */
export function mailErrorOf(error: unknown): MailError {
  if (error === null || error === undefined) return new MailError("rejected");
  const fields = (typeof error === "object" ? error : {}) as Record<string, unknown>;
  const status = typeof fields.statusCode === "number" ? fields.statusCode : null;
  const name =
    typeof fields.name === "string" && /^[a-z][a-z_]{0,63}$/.test(fields.name) ? fields.name : null;
  if (name === "invalid_idempotent_request") return new MailError("duplicate", status, name);
  if (name === "concurrent_idempotent_requests") return new MailError("unavailable", status, name);
  if (status === null) return new MailError("unavailable", null, name);
  if (status === 429) return new MailError("rate_limited", status, name);
  if (status >= 500) return new MailError("unavailable", status, name);
  return new MailError("rejected", status, name);
}
