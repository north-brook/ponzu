// Send a legal notice by email (docs/cloud.md, "Email"; the notices are the files in
// apps/api/src/email/notices/). Only the founder sends one on production; the orchestrator
// sends `dev-check` on dev to check it end to end.
//
//   DATABASE_URL=… PONZU_ENVIRONMENT=production RESEND_API_KEY=… PONZU_EMAIL_REPLY_TO=… \
//     bun apps/api/scripts/notice.ts --notice <id> --dry-run
//   … --send [--user <id> …] [--sooner]
//   … --notice suspension --case <id> --user <id> … --reason-file <path> [--workspace <id>] --send
//
// Run `--dry-run` first: it reads, writes nothing, prints counts and renders the email to a
// file. `--send` refuses (exit 2, nothing written) without RESEND_API_KEY, for a notice less
// than 30 days before it takes effect (a terms change may pass `--sooner`), for a notice with no
// day written yet, for dev's check on production, and off production without
// PONZU_EMAIL_ALLOW. It sends at most 5 a second, records each
// person's in `email_notices`, and never sends anyone a notice twice: run it again freely. It
// exits 1 when a notice needs a look (a `pending` record over a day old, or Resend asked it to
// wait). It prints counts and ids, never an address, a name, a key or the reason.
//
// It reads DATABASE_URL (Neon's pooled URL, as the API takes it), PONZU_ENVIRONMENT, and the
// API's email settings: RESEND_API_KEY, PONZU_EMAIL_FROM, PONZU_EMAIL_REPLY_TO and, outside
// production, PONZU_EMAIL_ALLOW. A notice is never paused, so PONZU_EMAIL_PAUSED is not read.
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDb } from "@ponzu/db";
import { systemClock } from "@ponzu/sandbox";
import { noAnalytics } from "../src/analytics/analytics.ts";
import { createResendMail, DEFAULT_EMAIL_FROM, noMail } from "../src/deps/mail.ts";
import { EMAIL_CONFIG_UNSET, parseEmailAllow } from "../src/email/kinds.ts";
import { NOTICE_USAGE, parseNoticeArgs, runNotice } from "../src/email/notice-cli.ts";
import { DEFAULT_API_URL, ENVIRONMENTS, type Environment } from "../src/env.ts";
import { consoleSink, createLogger } from "../src/http/log.ts";
import { createVault, generateVaultKey } from "../src/vault/vault.ts";

const { env } = process;
const args = parseNoticeArgs(process.argv.slice(2));
const environment = env.PONZU_ENVIRONMENT as Environment | undefined;
if (typeof args === "string" || !env.DATABASE_URL || !environment) {
  if (typeof args === "string") console.error(args);
  console.error(NOTICE_USAGE);
  process.exit(2);
}
if (!ENVIRONMENTS.includes(environment)) {
  console.error(`PONZU_ENVIRONMENT is one of ${ENVIRONMENTS.join(", ")}.`);
  process.exit(2);
}
const allow = env.PONZU_EMAIL_ALLOW === undefined ? null : parseEmailAllow(env.PONZU_EMAIL_ALLOW);
if (env.PONZU_EMAIL_ALLOW !== undefined && !allow) {
  console.error("PONZU_EMAIL_ALLOW is malformed.");
  process.exit(2);
}

// The script's own lines go to stderr, as JSON, the API's way: kinds and keys, never addresses.
const log = createLogger((line) => consoleSink({ ...line, level: "error" }));
const mail = env.RESEND_API_KEY
  ? createResendMail({
      apiKey: env.RESEND_API_KEY,
      from: env.PONZU_EMAIL_FROM || DEFAULT_EMAIL_FROM,
      clock: systemClock,
      log,
    })
  : noMail;

const code = await runNotice(
  {
    db: createDb(env.DATABASE_URL),
    clock: systemClock,
    log,
    mail,
    analytics: noAnalytics,
    // A notice carries no unsubscribe link, so nothing is sealed; a throwaway key makes sure
    // nothing this script could seal would ever open in the API.
    vault: createVault({ key: generateVaultKey() }),
    config: {
      build: { environment },
      email: { ...EMAIL_CONFIG_UNSET, replyTo: env.PONZU_EMAIL_REPLY_TO || null, allow },
      sandbox: { apiUrl: env.PONZU_API_URL || DEFAULT_API_URL },
    },
  },
  args,
  {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text),
    print: (line) => console.log(line),
    tmpdir: tmpdir(),
  },
);
process.exit(code);
