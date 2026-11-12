/*
 * Times as the apps write them. Each takes the moment it measures from as an argument: the Mac
 * reads it from React context (apps/studio/src/cloud/time.ts, `useNow`), the phone from its own
 * clock, and tests pin it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How long ago `at` was. `short` is for dense lines ("2 h", "3 d"); `compact` for the pull
 * request tab's GitHub-like lines ("14m"); `long` reads as words ("2 hours ago", "3 weeks ago").
 */
export function ago(at: string, now: number, style: "short" | "compact" | "long"): string {
  const ms = Math.max(0, now - Date.parse(at));
  const [n, unit] =
    ms < MINUTE
      ? [0, "now"]
      : ms < HOUR
        ? [Math.floor(ms / MINUTE), "m"]
        : ms < DAY
          ? [Math.floor(ms / HOUR), "h"]
          : ms < WEEK
            ? [Math.floor(ms / DAY), "d"]
            : ms < 5 * WEEK
              ? [Math.floor(ms / WEEK), "w"]
              : [Math.floor(ms / (30 * DAY)), "mo"];
  if (unit === "now") return style === "compact" ? "now" : "just now";
  if (style === "short") return `${n} ${unit}`;
  if (style === "compact") return `${n}${unit}`;
  const word = { m: "minute", h: "hour", d: "day", w: "week", mo: "month" }[unit]!;
  return `${n} ${word}${n === 1 ? "" : "s"} ago`;
}

/** How long something took, as a check's row says it: "9s", "2m 41s", "1h 05m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** A time of day on the viewer's clock, as a sentence says it: "4:00 PM". */
export function clock(at: string): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
