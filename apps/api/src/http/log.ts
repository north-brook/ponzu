/*
 * Structured logs: one JSON object per line, which is what Vercel's log search reads. Every
 * line passes through `redact` on its way out, so a secret that reaches a log call by mistake
 * (an upstream error that quotes a token, a header object) does not reach the log.
 *
 * Redaction is the backstop, not the plan: log ids and outcomes, never request or response
 * bodies, headers or query strings.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every line. */
  with(fields: Record<string, unknown>): Logger;
}

/** Where finished lines go: the console in production, an array in tests. */
export type LogSink = (line: LogLine) => void;

export const consoleSink: LogSink = (line) => {
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    // A field JSON cannot write (a cycle, a value with a throwing `toJSON`). The line is lost;
    // that it was lost is not, and the request that logged it carries on.
    text = JSON.stringify({ level: line.level, event: line.event, unloggable: true });
  }
  if (line.level === "error") console.error(text);
  else if (line.level === "warn") console.warn(text);
  else console.log(text);
};

export function createLogger(sink: LogSink, bound: Record<string, unknown> = {}): Logger {
  const write = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) =>
    sink(redact({ level, event, ...bound, ...fields }) as LogLine);
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    with: (fields) => createLogger(sink, { ...bound, ...fields }),
  };
}

const REDACTED = "[redacted]";

/** A field with one of these in its name never has its value logged, whatever the value is. */
const SECRET_KEY =
  /token|secret|password|passwd|authorization|cookie|verifier|credential|key$|^code$/i;

/** What a secret looks like when it turns up inside some other text. */
const SECRET_VALUES = [
  // A JWT: a WorkOS access token, a GitHub App assertion.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,
  // GitHub tokens: user, refresh, installation, OAuth, personal.
  /\b(?:gh[pousr]_\w{16,}|github_pat_\w{16,})/g,
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

const MAX_DEPTH = 6;

/** A copy of `value` that is safe to log. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  // JSON has no bigint, and `JSON.stringify` throws on one.
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
      ...(value.cause === undefined ? {} : { cause: redact(value.cause, depth + 1) }),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      SECRET_KEY.test(key) && field != null ? REDACTED : redact(field, depth + 1),
    ]),
  );
}

function redactText(text: string): string {
  let out = text.replace(URL_PASSWORD, `$1${REDACTED}@`).replace(ASSIGNED, `$1=${REDACTED}`);
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  return out;
}
