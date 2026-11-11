/*
 * What a secret looks like, and a copy of a value with every one taken out. The API's logs and
 * error reports and the runner's agent traces all pass through it on their way out, so a token
 * that turns up by mistake (an upstream error that quotes it, a command that prints the
 * environment) does not leave with them.
 *
 * Redaction is the backstop, not the plan: what goes out should name ids and outcomes, not
 * bodies, headers or environments. Pure, so it runs anywhere.
 */

export const REDACTED = "[redacted]";

/** A field with one of these in its name never has its value kept, whatever the value is. */
const SECRET_KEY =
  /token|secret|password|passwd|authorization|cookie|verifier|credential|key$|^code$/i;

/** What a secret looks like when it turns up inside some other text. */
const SECRET_VALUES = [
  // A JWT: a WorkOS access token, a GitHub App assertion.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,
  // GitHub tokens: user, refresh, installation, OAuth, personal.
  /\b(?:gh[pousr]_\w{16,}|github_pat_\w{16,})/g,
  // Anthropic API keys and Claude Code OAuth tokens.
  /\bsk-ant-[\w-]{16,}/g,
  // WorkOS API keys, Ponzu runner tokens, vault ciphertexts.
  /\bsk_(?:test|live)_\w+/g,
  /\bpzr_[0-9a-z]{16,}/g,
  /\bpzv1\.[\w.-]+/g,
  /\bBearer\s+[^\s"',]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** The password in a connection string (`postgres://user:<this>@host`), and `password=<this>`. */
const URL_PASSWORD = /(\w+:\/\/[^\s:/@]+:)[^\s@]+@/g;
const ASSIGNED = /\b(password|passwd|secret|token|api_?key)=[^\s&"']+/gi;

/** Shorter known values are not looked for: "1" or "true" would take everything with them. */
export const MIN_KNOWN_SECRET = 8;

export interface RedactOptions {
  /** Values known to be secret (a repo's secrets, a credential), taken out wherever they are. */
  known?: readonly string[];
  /** How deep to go before giving up on the rest: "[too deep]". */
  maxDepth?: number;
}

/** A copy of `value` with every secret in it replaced by `[redacted]`. */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const known = knownSecrets(options.known);
  return walk(value, 0, options.maxDepth ?? 6, known);
}

/** `text` with every secret in it replaced by `[redacted]`. */
export function redactText(text: string, known: readonly string[] = []): string {
  return scrub(text, knownSecrets(known));
}

/** `text` without its secrets, `known` already as `knownSecrets` gives it. */
function scrub(text: string, known: readonly string[]): string {
  let out = text.replace(URL_PASSWORD, `$1${REDACTED}@`).replace(ASSIGNED, `$1=${REDACTED}`);
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  for (const secret of known) out = out.replaceAll(secret, REDACTED);
  return out;
}

/** The known values worth looking for, longest first so one inside another goes whole. */
export function knownSecrets(values: readonly string[] = []): string[] {
  return [...new Set(values)]
    .filter((value) => value.length >= MIN_KNOWN_SECRET)
    .sort((a, b) => b.length - a.length);
}

function walk(value: unknown, depth: number, maxDepth: number, known: string[]): unknown {
  if (typeof value === "string") return scrub(value, known);
  // JSON has no bigint, and `JSON.stringify` throws on one.
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return "[too deep]";
  const next = (field: unknown) => walk(field, depth + 1, maxDepth, known);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message, known),
      ...(value.stack ? { stack: scrub(value.stack, known) } : {}),
      ...(value.cause === undefined ? {} : { cause: next(value.cause) }),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(next);
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      SECRET_KEY.test(key) && field != null ? REDACTED : next(field),
    ]),
  );
}
