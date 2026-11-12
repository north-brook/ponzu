/*
 * The person's own Claude, which every canvas of theirs runs on: how it is connected, and the
 * plan's limits as Settings › Agents shows them. Never its credential.
 */

/** A Claude subscription signed in through claude.ai, or an Anthropic API key. */
export type ClaudeMethod = "subscription" | "api_key";

export interface ClaudeConnection {
  method: ClaudeMethod;
  /** `expired` and `revoked` are signed out: canvases wait until it is connected again. */
  status: "connected" | "expired" | "revoked";
  /** "Claude Max", when Claude has said. */
  planLabel: string | null;
  email: string | null;
  /** An API key's last four characters. */
  keyHint: string | null;
  connectedAt: string;
  /** A subscription's sign-in lasts a year. */
  expiresAt: string | null;
}

/**
 * The windows a Claude plan limits that Settings shows: the five-hour session, the week, and the
 * week on Opus or on Sonnet, for the plans that have those.
 */
export type LimitWindow = "session" | "week" | "week_opus" | "week_sonnet";

export interface ClaudeLimit {
  window: LimitWindow;
  /** 0 to 1, as last seen by a sandbox; null before any canvas has run. */
  utilization: number | null;
  resetsAt: string | null;
}

export const LIMIT_TITLES: Record<LimitWindow, string> = {
  session: "Current session",
  week: "This week",
  week_opus: "This week, Opus",
  week_sonnet: "This week, Sonnet",
};

/** The Agent SDK's names for the windows (its `rateLimitType`), as Settings names them. */
const SDK_WINDOWS: Record<string, LimitWindow> = {
  five_hour: "session",
  seven_day: "week",
  seven_day_opus: "week_opus",
  seven_day_sonnet: "week_sonnet",
};
const ORDER: readonly LimitWindow[] = ["session", "week", "week_opus", "week_sonnet"];

/** A plan's window as the API answers it: the SDK's name, and dates as ISO 8601 text. */
export interface ApiClaudeLimit {
  window: string;
  utilization: number | null;
  resetsAt: string | null;
}

/**
 * The API's `limits` as Settings › Agents shows them: the windows it knows, in its order, and
 * any other window left out. Before any canvas has run on the plan nothing is known, and the two
 * windows every plan has show as not yet seen. Null (an API key, which has no plan) hides the
 * section.
 */
export function toLimits(
  limits: readonly ApiClaudeLimit[] | null | undefined,
): ClaudeLimit[] | null {
  if (!limits) return null;
  const known = new Map<LimitWindow, ClaudeLimit>();
  for (const limit of limits) {
    const window = SDK_WINDOWS[limit.window];
    if (window)
      known.set(window, { window, utilization: limit.utilization, resetsAt: limit.resetsAt });
  }
  if (!known.size) {
    return (["session", "week"] as const).map((window) => ({
      window,
      utilization: null,
      resetsAt: null,
    }));
  }
  return ORDER.flatMap((window) => {
    const limit = known.get(window);
    return limit ? [limit] : [];
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** From four weeks before a sign-in runs out, Settings asks for a new one. */
const RENEW_AHEAD = 28 * 24 * HOUR;

export function isSignedOut(connection: ClaudeConnection): boolean {
  return connection.status !== "connected";
}

/** A subscription whose year is nearly up: Settings asks the person to sign in again. */
export function needsRenewal(connection: ClaudeConnection, now: number): boolean {
  if (connection.status !== "connected" || !connection.expiresAt) return false;
  return Date.parse(connection.expiresAt) - now <= RENEW_AHEAD;
}

/** "Nov 2", in the person's time zone. */
export function shortDate(at: string): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The Connected row's second line: "Claude Max · bryce@northbrook.co · connected Nov 2", or for
 * a key "Anthropic API key · sk-ant-…4f2a · connected Nov 2".
 */
export function connectionLine(connection: ClaudeConnection): string {
  const parts =
    connection.method === "api_key"
      ? ["Anthropic API key", connection.keyHint ? `sk-ant-…${connection.keyHint}` : null]
      : [connection.planLabel ?? "Claude subscription", connection.email];
  return [...parts.filter(Boolean), `connected ${shortDate(connection.connectedAt)}`].join(" · ");
}

/** "Monday 9:00": a weekly reset, in the person's time zone. */
function weekdayTime(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${day} ${clock(date)}`;
}

/** "9:00", "16:00": the mockup writes times on a 24-hour clock without a leading zero. */
function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "2 h 14 min", "40 min", "3 h". */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A limit as its row shows it: the share used, and the line under its title. */
export function limitView(
  limit: ClaudeLimit,
  now: number,
): { percent: number | null; line: string | null; full: boolean } {
  const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : null;
  // A window that has reset since it was last seen is empty until a sandbox sees it again.
  const lapsed = resets !== null && resets <= now;
  const percent =
    limit.utilization === null ? null : lapsed ? 0 : Math.round(limit.utilization * 100);
  const full = !lapsed && percent !== null && percent >= 100;
  if (resets === null || lapsed) return { percent, line: null, full: false };
  if (full) {
    const until = limit.window === "session" ? clock(new Date(resets)) : weekdayTime(resets);
    return { percent: 100, line: `Canvases wait until ${until}`, full };
  }
  const line =
    limit.window === "session"
      ? `Resets in ${duration(resets - now)}`
      : `Resets ${weekdayTime(resets)}`;
  return { percent, line, full };
}

/**
 * The text a person pastes, as the code to send: claude.ai shows `code#state`. Surrounding words
 * are dropped only when exactly one part of the paste looks like a code; otherwise it is kept as
 * pasted, trimmed.
 */
export function pastedCode(text: string): string {
  const trimmed = text.trim();
  if (!/\s/.test(trimmed)) return trimmed;
  const codes = trimmed.split(/\s+/).filter((word) => /^[\w-]+#[\w-]+$/.test(word));
  return codes.length === 1 ? codes[0]! : trimmed;
}

/** An API key as entered: a key has no spaces, so a copy's stray space or line break goes. */
export function enteredKey(text: string): string {
  return text.replace(/\s+/g, "");
}
