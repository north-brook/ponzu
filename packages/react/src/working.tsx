import { type CSSProperties, useEffect, useState } from "react";
import { SLICE, SLICE_STROKE } from "./slice.ts";

/**
 * The slice with its six segments fading in turn, clockwise: Ponzu is loading
 * a file or a screen. `dry` is grey at half speed, for waiting rather than
 * working (reconnecting). Agents at work never use it; see `.pz-shimmer`.
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
      className={dry ? "pz-juice-slow" : undefined}
    >
      <g fill={fill} stroke={fill} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d, i) => (
          <path key={d} d={d} className="pz-juice-seg" style={{ "--i": i } as CSSProperties} />
        ))}
      </g>
    </svg>
  );
}

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
