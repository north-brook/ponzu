import { REDACTED, redactText } from "@ponzu/core/redact";

/*
 * The last pass over anything the Mac app sends PostHog (docs/analytics.md, "Never a secret"):
 * the studio's events and the shell's error reports both run through it. An error's message or a
 * stack can name a URL, and a URL's query can carry a sign-in code, a token or a signed upload
 * address, so every URL keeps only its origin and path; then the server's own redaction
 * (`@ponzu/core/redact`) takes out anything shaped like a credential.
 *
 * Not `redact` itself: it drops any field whose name says `token` or `key`, and PostHog's events
 * carry the project's public key as `token`, which ingestion needs; and it gives up past six
 * levels, where an exception's stack frames are. This walks every string, and only strings.
 */

/** A URL of any scheme (`https:`, `ponzu:`, `ponzu-dev:`) and what follows its path. */
const URL_TAIL = /\b([a-z][a-z\d+.-]*:\/\/[^\s?#"'`<>()[\]{}]*)[?#][^\s"'`<>()[\]{}]*/gi;

/** A sign-in's `code=…` and `state=…`, outside a URL, which the core's redaction leaves. */
const SIGN_IN = /\b(code|state)=[^\s&"'`]+/gi;

/** `text` with every URL cut to its origin and path, and every credential-shaped run replaced. */
export function scrubSecretsText(text: string): string {
  return redactText(text.replace(URL_TAIL, "$1").replace(SIGN_IN, `$1=${REDACTED}`));
}

/** `value` with `scrubSecretsText` applied to every string in it, however deep. */
export function scrubSecrets<T>(value: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubSecretsText(v);
    if (depth > 12 || v === null || typeof v !== "object" || v instanceof Date) return v;
    if (Array.isArray(v)) return v.map((inner) => walk(inner, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner, depth + 1)]));
  };
  return walk(value, 0) as T;
}
