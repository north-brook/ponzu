/*
 * The one credential the evals run on: an Anthropic API key (the development key, never anyone's
 * Claude subscription). The judges call the API with it, and the agent's turns give it to Claude
 * Code the way a canvas connected to an API key does. A Claude sign-in in the environment or on
 * disk is never read, so the evals cannot be pointed at one.
 */

/** The names the key is read from, in order: the API's own name for it, then the usual one. */
export const EVALS_KEY_NAMES = ["PONZU_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] as const;

/** What a run with no key says, in one line. */
export const NO_EVALS_KEY =
  "No Anthropic API key: set ANTHROPIC_API_KEY (the development key, in .context/cloud.env) or PONZU_ANTHROPIC_API_KEY. The evals never run on a Claude sign-in; see docs/evals.md.";

/** The evals' Anthropic API key, or null when none is set. */
export function evalsApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of EVALS_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * A copy of `value` with every string's `secret` replaced by `[redacted]`: for what the evals keep
 * (results, logs), which must never carry the key whatever a model or an error repeated.
 */
export function withoutSecret<T>(value: T, secret: string): T {
  if (!secret) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replaceAll(secret, "[redacted]");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, field]) => [k, walk(field)]));
    }
    return v;
  };
  return walk(value) as T;
}
