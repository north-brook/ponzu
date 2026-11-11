/*
 * The last pass over anything the Mac app sends PostHog (docs/analytics.md, "Never sent"): the
 * studio's events and the shell's error reports both run through it. An error's message or a
 * stack can name a URL, and a URL's query can carry a sign-in code, a token or a signed upload
 * address, so every URL keeps only its origin and path, and anything shaped like a credential is
 * replaced. This is the backstop, not the plan: what is captured is chosen not to hold secrets.
 */

const REDACTED = "[redacted]";

/** A URL of any scheme (`https:`, `ponzu:`, `ponzu-dev:`) and what follows its path. */
const URL_TAIL = /\b([a-z][a-z\d+.-]*:\/\/[^\s?#"'`<>()[\]{}]*)[?#][^\s"'`<>()[\]{}]*/gi;

/** `code=…`, `token=…` and their kin, wherever they turn up outside a URL. */
const ASSIGNED =
  /\b(code|state|token|access_token|refresh_token|id_token|secret|password|api_?key|signature|x-amz-signature)=[^\s&"'`]+/gi;

/** What a credential looks like inside other text. */
const SECRET_VALUES = [
  /\bBearer\s+[^\s"'`,]+/gi,
  // A JWT: an access token, a GitHub App assertion.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,
  // GitHub tokens.
  /\b(?:gh[pousr]_\w{16,}|github_pat_\w{16,})/g,
  // Anthropic API keys and Claude's OAuth tokens.
  /\bsk-ant-[\w-]{8,}/g,
  // WorkOS keys, Ponzu runner tokens, vault ciphertexts, PostHog personal API keys.
  /\bsk_(?:test|live)_\w+/g,
  /\bpzr_[\da-z]{16,}/g,
  /\bpzv1\.[\w.-]+/g,
  /\bphx_\w{16,}/g,
];

/** `text` with every URL cut to its origin and path, and every credential-shaped run replaced. */
export function scrubSecretsText(text: string): string {
  let out = text.replace(URL_TAIL, "$1").replace(ASSIGNED, `$1=${REDACTED}`);
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  return out;
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
