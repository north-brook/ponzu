import { renderEmail } from "@ponzu/email";
import { FIXTURES } from "@ponzu/email/fixtures";
import type { Mail } from "../deps/mail.ts";
import { emailAllowed, parseEmailAllow } from "./kinds.ts";

/*
 * The proof sends (scripts/email-proof.ts): every sample email in @ponzu/email, rendered as the
 * API renders it and sent through the real seam to one address the founder looks at in Apple
 * Mail, Gmail and Outlook, light and dark. Subjects start `[Proof] `.
 *
 * It refuses unless all of these hold, before anything is sent:
 * - the environment is not production (it is run against dev's key, never production's);
 * - RESEND_API_KEY is set (the caller makes `mail` from it);
 * - PONZU_EMAIL_ALLOW is set, and `--to` is an address it names.
 *
 * It prints the samples' names and Resend's answers, never the key, and never the address.
 */

export const PROOF_SUBJECT_PREFIX = "[Proof] ";

export interface ProofSettings {
  environment: string | undefined;
  allow: string | undefined;
  to: string | undefined;
  replyTo: string | undefined;
}

/** Why the proof may not run, or null when it may. */
export function proofRefusal(settings: ProofSettings, mail: Pick<Mail, "enabled">): string | null {
  if (settings.environment === "production") {
    return "Refused: PONZU_ENVIRONMENT is production. The proof runs on dev's key only.";
  }
  if (!mail.enabled) return "Refused: RESEND_API_KEY is not set.";
  if (!settings.to) return "Refused: say where with --to <address>.";
  if (settings.allow === undefined) {
    return "Refused: PONZU_EMAIL_ALLOW is not set, so no address may be emailed.";
  }
  const allow = parseEmailAllow(settings.allow);
  if (!allow) return "Refused: PONZU_EMAIL_ALLOW is malformed.";
  if (!emailAllowed(allow, settings.to)) {
    return "Refused: the --to address is not one PONZU_EMAIL_ALLOW names.";
  }
  return null;
}

/** Sends every sample once; answers what each got, by name. */
export async function sendProofs(
  mail: Mail,
  settings: ProofSettings & { to: string; environment: string },
  { run, only }: { run: string; only?: readonly string[] },
): Promise<{ name: string; outcome: string }[]> {
  const results: { name: string; outcome: string }[] = [];
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    if (only && !only.includes(name)) continue;
    const rendered = await renderEmail(fixture.kind, fixture.props as never);
    try {
      const { id } = await mail.send({
        to: settings.to,
        subject: `${PROOF_SUBJECT_PREFIX}${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
        headers: {},
        // One key a run and sample: running again the same day is a new run.
        idempotencyKey: `proof/${run}/${name}`,
        ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
        tags: [
          { name: "kind", value: fixture.kind },
          { name: "env", value: settings.environment.replace(/[^A-Za-z0-9_-]/g, "-") },
        ],
      });
      results.push({ name, outcome: `sent ${id}` });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "error";
      results.push({ name, outcome: `failed ${code}` });
    }
  }
  return results;
}
