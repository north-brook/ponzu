import { createContext, useContext } from "react";

/**
 * The time a component measures ages from. The app leaves it to the clock; the gallery and tests
 * pin it, so "2 h" reads the same on every run.
 */
export const NowContext = createContext<(() => number) | null>(null);

export function useNow(): number {
  const now = useContext(NowContext);
  return now ? now() : Date.now();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How long ago `at` was. `short` is for dense lines ("2 h", "3 d"); `long` reads as words
 * ("2 hours ago", "3 weeks ago").
 */
export function ago(at: string, now: number, style: "short" | "long"): string {
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
  if (unit === "now") return "just now";
  if (style === "short") return `${n} ${unit}`;
  const word = { m: "minute", h: "hour", d: "day", w: "week", mo: "month" }[unit]!;
  return `${n} ${word}${n === 1 ? "" : "s"} ago`;
}
