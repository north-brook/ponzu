import { scrubSecretsText } from "@ponzu/client";

/*
 * The Help menu's links (menu.ts): Contact Support, Ponzu Status, the Privacy Policy and the
 * Terms of Service. Contact Support writes an email to support@ponzu.design with what support
 * needs to find a problem (this build's version, commit and environment, and the id of the last
 * request the studio made to the API) and nothing else: never a token, a session, a canvas or a
 * path. Each field is checked against the shape it must have, and the whole body is scrubbed
 * again on the way out, so a field that went wrong upstream can't carry a secret into an email.
 */

export const SUPPORT_EMAIL = "support@ponzu.design";

/** The site's pages the Help menu opens. The status page is the site's (production plan, R12). */
export const HELP_LINKS = {
  status: "https://ponzu.design/status",
  privacy: "https://ponzu.design/privacy",
  terms: "https://ponzu.design/terms",
} as const;

/** What a support email says about this build. */
export interface SupportFacts {
  /** The app's version: `2.0.0`. */
  version: string;
  /** The commit it was built from, or null when the build wasn't told. */
  commit: string | null;
  /** The environment it talks to: `production`, `dev` or `custom` (config.ts). */
  environment: string;
  /** The `x-request-id` of the API's last answer to the studio, or null before any. */
  lastRequestId: string | null;
}

/** As the API takes a caller's request id (apps/api/src/http/request.ts), so one it gave fits. */
const REQUEST_ID = /^[\w-]{8,64}$/;
const VERSION = /^[\w.+-]{1,40}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
const ENVIRONMENT = /^[a-z][a-z-]{0,19}$/;

/** `value` when it has the shape `pattern` says, else "unknown". */
function checked(value: string | null, pattern: RegExp): string {
  return value !== null && pattern.test(value) ? value : "unknown";
}

/** The body of a support email: room for the person's words, then the build's facts. */
export function supportBody(facts: SupportFacts): string {
  const body = [
    "",
    "",
    "",
    "---",
    "Please keep these lines: they help us find what happened.",
    `Version: ${checked(facts.version, VERSION)}`,
    `Commit: ${checked(facts.commit, COMMIT)}`,
    `Environment: ${checked(facts.environment, ENVIRONMENT)}`,
    `Last request id: ${facts.lastRequestId && REQUEST_ID.test(facts.lastRequestId) ? facts.lastRequestId : "none"}`,
  ].join("\n");
  return scrubSecretsText(body);
}

/** The `mailto:` link Contact Support opens. */
export function supportMailto(facts: SupportFacts): string {
  const subject = encodeURIComponent("Ponzu support");
  const body = encodeURIComponent(supportBody(facts));
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/**
 * The request id in an answer's headers, as Electron's `webRequest` hands them over (names in
 * whatever case the server sent, each with a list of values), or null when it has none that fits.
 */
export function requestIdOf(headers: Record<string, string[] | string> | undefined): string | null {
  if (!headers) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-request-id") continue;
    const id = Array.isArray(value) ? value[0] : value;
    return id && REQUEST_ID.test(id) ? id : null;
  }
  return null;
}
