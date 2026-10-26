import { type CSSProperties, useEffect, useState } from "react";
import { SLICE, SLICE_STROKE } from "./slice.ts";

/**
 * The slice turning a segment at a time: a sixth of a turn, a rest, again. It's symmetric, so
 * every rest is the mark itself, whole. Ponzu is loading a file or a screen. `dry` is grey at
 * half speed, for waiting rather than working (reconnecting). Agents at work never use it;
 * see `.pz-shimmer`.
 */
export function Juice({
  size = 20,
  dark = false,
  dry = false,
}: {
  size?: number;
  dark?: boolean;
  dry?: boolean;
}) {
  const fill = dry ? (dark ? "#5e5b54" : "#c9c5bc") : "#ffc81e";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Loading"
      className={dry ? "pz-juice pz-juice-slow" : "pz-juice"}
    >
      <g fill={fill} stroke={fill} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Yuzu rain: columns of dots falling at their own pace, Paper's way of saying "at work here"
 * without anyone's face on it. The columns come in left to right. Sized in em, so it's the
 * size of the text around it; `columns` sets how wide it runs.
 */
export function Rain({
  columns = 24,
  className,
  label,
  title,
}: {
  columns?: number;
  className?: string;
  /** Read out in its place; without one it's decoration. */
  label?: string;
  title?: string;
}) {
  return (
    <span
      className={`pz-rain pz:inline-flex pz:shrink-0 pz:items-center${className ? ` ${className}` : ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      title={title}
    >
      {RAIN.slice(0, columns).map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of columns
          key={i}
          style={{ "--i": i, "--fall": `${c.fall}s`, "--drift": `${c.drift}s` } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** The rain's columns: each falls at its own pace from its own start, the same every time. */
const RAIN = Array.from({ length: 24 }, (_, i) => {
  const r = (n: number) => (((Math.sin((i + 1) * n) * 43758.5453) % 1) + 1) % 1;
  return { fall: (1.05 + r(12.9898) * 0.5).toFixed(2), drift: (-r(78.233) * 1.5).toFixed(2) };
});

/** True once `on` has held for `ms`: loading states for waits too short to notice show nothing. */
export function useDelayed(on: boolean, ms = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && shown;
}

export { type AgentActivity, agentActivity } from "@ponzu/core";
