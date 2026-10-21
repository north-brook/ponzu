import type { Presence } from "@ponzu/core";
import { useEffect, useId, useState } from "react";

/**
 * The Ponzu wedge with its three segments filling in turn: Ponzu is loading
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
  const clip = useId();
  const [rind, pith, flesh] = dry
    ? dark
      ? ["#5a5a58", "#2a2a28", "#6a6a68"]
      : ["#bdb9b0", "#f1efea", "#d9d6cf"]
    : dark
      ? ["#FFA800", "#FFFDF2", "#FFC400"]
      : ["#F4B012", "#FFF3CF", "#FFD23F"];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Loading"
      className={dry ? "pz-juice-slow" : undefined}
    >
      <defs>
        <clipPath id={clip}>
          <path d="M19.57 9.61A24.62 24.62 0 0 0 54.39 44.43Z" />
        </clipPath>
      </defs>
      <path fill={rind} d="M12.96 3.00A33.96 33.96 0 0 0 61.00 51.04Z" />
      <path fill={pith} d="M17.08 7.12A28.14 28.14 0 0 0 56.88 46.92Z" />
      {/* Three slices of the flesh, split along the pith lines. */}
      <g clipPath={`url(#${clip})`} fill={flesh}>
        <polygon className="pz-juice-seg" points="34.49,29.51 -30,41.2 -60,-60 60,-60" />
        <polygon className="pz-juice-seg" points="34.49,29.51 -30,41.2 -60,120 22.85,93.4" />
        <polygon className="pz-juice-seg" points="34.49,29.51 22.85,93.4 120,120 120,-60" />
      </g>
      <path fill={pith} d="M17.08 7.12L56.88 46.92L54.39 49.41L14.59 9.61Z" />
      <path
        stroke={pith}
        d="M34.49 29.51L30.61 50.80M34.49 29.51L13.20 33.39"
        strokeWidth={3.4}
        strokeLinecap="round"
        fill="none"
      />
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

/**
 * What an agent is doing in a file. `working` while it changes artboards
 * (see `Presence.working`); `collaborating` while it runs the collaborate
 * loop, i.e. waiting in wait_for_activity or handling what it heard from it;
 * otherwise nothing the person needs to see.
 */
export type AgentActivity = "working" | "collaborating" | null;

/** A loop's turn (read, edit, screenshot, resolve) between two waits rarely takes longer. */
const LOOP_GAP = 2 * 60_000;

export function agentActivity(p: Presence, file: string, now = Date.now()): AgentActivity {
  if (p.kind !== "agent" || (p.file && p.file !== file)) return null;
  if (p.working.length) return "working";
  if (!p.file) return null;
  if (p.listening || (p.listenedAt && now - p.listenedAt < LOOP_GAP)) return "collaborating";
  return null;
}
