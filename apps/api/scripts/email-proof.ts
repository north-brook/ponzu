// Send every sample email to one allowlisted address, for the founder to look at in real mail
// apps (docs/cloud.md, "Email"; the email plan §7, "The live check"). Run by the orchestrator
// only, on dev, once the founder's dev key exists:
//
//   set -a; . .context/cloud.env; set +a
//   bun apps/api/scripts/email-proof.ts --to <an address in PONZU_EMAIL_ALLOW> [--only <name>,…]
//
// It reads RESEND_API_KEY, PONZU_EMAIL_FROM, PONZU_EMAIL_REPLY_TO, PONZU_EMAIL_ALLOW and
// PONZU_ENVIRONMENT, and refuses (exit 2) on production, without a key, without an allowlist,
// or for an address the allowlist does not name. It prints each sample's name and what Resend
// answered; never the key and never the address. Subjects start `[Proof] `.
import { systemClock } from "@ponzu/sandbox";
import { createResendMail, DEFAULT_EMAIL_FROM, noMail } from "../src/deps/mail.ts";
import { proofRefusal, sendProofs } from "../src/email/proof.ts";
import { createLogger } from "../src/http/log.ts";

const { env } = process;
const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const to = flagValue("--to");
const only = flagValue("--only")?.split(",").filter(Boolean);
const settings = {
  environment: env.PONZU_ENVIRONMENT,
  allow: env.PONZU_EMAIL_ALLOW,
  to,
  replyTo: env.PONZU_EMAIL_REPLY_TO || undefined,
};
const log = createLogger((line) => console.error(JSON.stringify(line)));
const mail = env.RESEND_API_KEY
  ? createResendMail({
      apiKey: env.RESEND_API_KEY,
      from: env.PONZU_EMAIL_FROM || DEFAULT_EMAIL_FROM,
      clock: systemClock,
      log,
    })
  : noMail;

const refusal = proofRefusal(settings, mail);
if (refusal) {
  console.error(refusal);
  process.exit(2);
}
const results = await sendProofs(
  mail,
  { ...settings, to: to!, environment: env.PONZU_ENVIRONMENT ?? "local" },
  {
    run: new Date(systemClock.now())
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14),
    only,
  },
);
for (const { name, outcome } of results) console.log(`${name}: ${outcome}`);
process.exit(results.every((result) => result.outcome.startsWith("sent")) ? 0 : 1);
