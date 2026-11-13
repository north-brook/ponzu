// Real sends through Resend, to Resend's own test addresses, on dev's key (docs/cloud.md,
// "Email"; the email plan §7, "The live check"). Skipped unless PONZU_LIVE_MAIL=1 with
// RESEND_API_KEY. Run by the orchestrator only, once the founder's dev key exists; CI never sets
// them. Test sends count toward Resend's quota. Nothing printed holds the key or an address.
//
//   set -a; . .context/cloud.env; set +a
//   PONZU_LIVE_MAIL=1 bun test apps/api/src/email/email.live.test.ts
//
// It sends one sample of each kind to delivered@resend.dev, and the digest to bounced@resend.dev
// and suppressed@resend.dev, and prints what Resend answered for the suppressed address (an id,
// or an error and its code): the email plan's §11 lists that as not verified.
import { describe, expect, test } from "bun:test";
import { renderEmail } from "@ponzu/email";
import { FIXTURES } from "@ponzu/email/fixtures";
import { systemClock } from "@ponzu/sandbox";
import { createResendMail, DEFAULT_EMAIL_FROM, MailError } from "../deps/mail.ts";
import { createLogger, type LogLine } from "../http/log.ts";

const env = process.env;
const configured = env.PONZU_LIVE_MAIL === "1" && !!env.RESEND_API_KEY;

/** One sample of each kind. */
const SAMPLES = ["billing-cap-warning", "team-hostile", "recap-2", "digest-one", "notice-shutdown"];

describe.skipIf(!configured)("Resend, for real", () => {
  const logs: LogLine[] = [];
  const mail = () =>
    createResendMail({
      apiKey: env.RESEND_API_KEY ?? "",
      from: env.PONZU_EMAIL_FROM || DEFAULT_EMAIL_FROM,
      clock: systemClock,
      log: createLogger((line) => logs.push(line)),
    });
  const run = new Date(systemClock.now())
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  async function send(sample: string, to: string) {
    const fixture = FIXTURES[sample]!;
    const rendered = await renderEmail(fixture.kind, fixture.props as never);
    return mail().send({
      to,
      subject: `[Live] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      headers: {},
      idempotencyKey: `live/${run}/${sample}/${to.split("@")[0]}`,
      tags: [
        { name: "kind", value: fixture.kind },
        { name: "env", value: "live-test" },
      ],
      ...(env.PONZU_EMAIL_REPLY_TO ? { replyTo: env.PONZU_EMAIL_REPLY_TO } : {}),
    });
  }

  test("each kind is taken for delivered@resend.dev", async () => {
    for (const sample of SAMPLES) {
      const { id } = await send(sample, "delivered@resend.dev");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  }, 60_000);

  test("a bounce is taken at send time; what a suppressed address gets is recorded", async () => {
    const bounced = await send("digest-one", "bounced@resend.dev");
    expect(bounced.id).toBeTruthy();
    const suppressed = await send("digest-one", "suppressed@resend.dev").then(
      ({ id }) => `taken, id ${id}`,
      (error: unknown) =>
        error instanceof MailError
          ? `refused: ${error.code}, status ${error.status}, ${error.resendCode}`
          : "failed outside Resend",
    );
    // The record the plan asks for: an id, or an error that maps to `rejected`.
    console.log(`suppressed@resend.dev: ${suppressed}`);
    expect(suppressed).toMatch(/^taken|^refused: rejected/);
    expect(JSON.stringify(logs)).not.toContain(env.RESEND_API_KEY ?? "never");
  }, 60_000);
});
