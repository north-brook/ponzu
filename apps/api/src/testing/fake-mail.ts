import { type Mail, MailError, type MailMessage } from "../deps/mail.ts";

/**
 * Email in memory. It records every email sent and answers each with a fresh id. As Resend does,
 * a second send with an idempotency key already used answers the first email's id and sends
 * nothing, or `duplicate` when the email is not the same. `failNext` makes the next sends throw
 * a `MailError`, as a 429 or a 5xx from Resend would. `enabled: false` acts out email being off.
 */
export class FakeMail implements Mail {
  readonly enabled: boolean;
  /** Every email sent, oldest first. */
  readonly sent: MailMessage[] = [];
  readonly #failures: MailError[] = [];
  readonly #byKey = new Map<string, { id: string; message: MailMessage }>();
  #next = 0;

  constructor({ enabled = true }: { enabled?: boolean } = {}) {
    this.enabled = enabled;
  }

  /** The next sends, one each, throw these codes. */
  failNext(...codes: MailError["code"][]): void {
    this.#failures.push(...codes.map((code) => new MailError(code)));
  }

  async send(message: MailMessage): Promise<{ id: string }> {
    if (!this.enabled) throw new Error("Email is off: RESEND_API_KEY is not set.");
    const failure = this.#failures.shift();
    if (failure) throw failure;
    const earlier = this.#byKey.get(message.idempotencyKey);
    if (earlier) {
      if (JSON.stringify(earlier.message) !== JSON.stringify(message)) {
        throw new MailError("duplicate", 409, "invalid_idempotent_request");
      }
      return { id: earlier.id };
    }
    const id = `eml_${++this.#next}`;
    const kept = structuredClone(message);
    this.#byKey.set(message.idempotencyKey, { id, message: kept });
    this.sent.push(kept);
    return { id };
  }
}
