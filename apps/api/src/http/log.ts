/*
 * Structured logs: one JSON object per line, which is what Vercel's log search reads. Every
 * line passes through `redact` on its way out, so a secret that reaches a log call by mistake
 * (an upstream error that quotes a token, a header object) does not reach the log.
 *
 * Redaction is the backstop, not the plan: log ids and outcomes, never request or response
 * bodies, headers or query strings.
 */

import { redact as redactValue } from "@ponzu/core/redact";

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

/** A copy of `value` that is safe to log (`@ponzu/core/redact`, which the runner's traces share). */
export function redact(value: unknown): unknown {
  return redactValue(value);
}
