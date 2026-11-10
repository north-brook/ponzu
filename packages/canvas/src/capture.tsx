import type { Capture } from "@ponzu/core";
import { type CSSProperties, useEffect, useState } from "react";
import { reducedMotion } from "./arrive.ts";
import type { CanvasSource } from "./connection.ts";
import { cn } from "./ui.tsx";

/** A screenshot's viewfinder: brackets snap in, the flash, and they let go. */
const SHOT_MS = 1100;
/** Before a recording's first frame: the ring dims and the trace sets off. */
const LEAD_MS = 250;
/** Each frame at most this long, and all of them at most `STEPS_MS`, so 24 still read as a run. */
const STEP_MS = 180;
const STEPS_MS = 2400;
/** After the last frame: the board comes back and the ring flares. */
const TAIL_MS = 900;

function stepMs(frames: number): number {
  return Math.min(STEP_MS, STEPS_MS / Math.max(1, frames));
}

function captureMs(c: Capture): number {
  const n = c.frames?.length ?? 0;
  return c.kind === "record" && n ? LEAD_MS + n * stepMs(n) + TAIL_MS : SHOT_MS;
}

/**
 * What agents are capturing now, by artboard: the latest capture of each, for as long as it
 * plays. Nothing for someone who asked for less motion.
 */
export function useCaptures(source: CanvasSource): Map<string, Capture> {
  const [playing, setPlaying] = useState<Map<string, Capture>>(() => new Map());
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = source.onCapture?.((c) => {
      if (reducedMotion()) return;
      setPlaying((m) => new Map(m).set(c.artboard, c));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setPlaying((m) => {
          if (m.get(c.artboard) !== c) return m;
          const next = new Map(m);
          next.delete(c.artboard);
          return next;
        });
      }, captureMs(c));
      timers.add(timer);
    });
    return () => {
      off?.();
      for (const t of timers) clearTimeout(t);
    };
  }, [source]);
  return playing;
}

interface Boxes {
  /** Round the board, where its working ring goes. */
  ring: CSSProperties;
  ringRadius: number;
  /** What was captured: the board, or the node a recording framed. */
  area: CSSProperties;
  radius: number;
}

/**
 * An agent looking at a board, played once over it in the screen-space overlay like the ring,
 * so screenshots never see it. A screenshot is a viewfinder: yuzu brackets snap onto its
 * corners, kick out on a camera flash, and fade. A recording steps a yuzu trace round the board
 * a frame at a time, showing each frame it took over the board with a small flash, then hands
 * the board back and the ring flares.
 */
export function CaptureFlash({ capture, ...boxes }: { capture: Capture } & Boxes) {
  return capture.kind === "record" && capture.frames?.length ? (
    <Frames frames={capture.frames} {...boxes} />
  ) : (
    <Viewfinder {...boxes} />
  );
}

const CORNERS = [
  { dx: -1, dy: -1, edges: ["Top", "Left"] },
  { dx: 1, dy: -1, edges: ["Top", "Right"] },
  { dx: -1, dy: 1, edges: ["Bottom", "Left"] },
  { dx: 1, dy: 1, edges: ["Bottom", "Right"] },
] as const;

function Viewfinder({ ring, ringRadius, area, radius }: Boxes) {
  return (
    <>
      <div className="pz-shot-flash pz:absolute" style={{ ...area, borderRadius: radius }} />
      <div className="pz:absolute" style={ring}>
        {CORNERS.map(({ dx, dy, edges }) => (
          <span
            key={`${dx}${dy}`}
            className="pz-bracket pz:absolute pz:size-[18px]"
            style={
              {
                [dx < 0 ? "left" : "right"]: -2,
                [dy < 0 ? "top" : "bottom"]: -2,
                [`border${edges[0]}`]: "2px solid var(--pz-rind)",
                [`border${edges[1]}`]: "2px solid var(--pz-rind)",
                [`border${edges[0]}${edges[1]}Radius`]: ringRadius + 2,
                "--dx": dx,
                "--dy": dy,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </>
  );
}

function Frames({ frames, ring, ringRadius, area, radius }: { frames: string[] } & Boxes) {
  const n = frames.length;
  // -1 before the first frame, n once they've all shown.
  const [step, setStep] = useState(-1);
  useEffect(() => {
    const each = stepMs(n);
    const timers = Array.from({ length: n + 1 }, (_, i) =>
      setTimeout(() => setStep(i), LEAD_MS + i * each),
    );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [n]);
  const showing = step >= 0 && step < n;
  const done = step >= n;
  return (
    <>
      {/* In at once, so the board never shows through its first frame; out gently. */}
      <div
        className={cn(
          "pz:absolute pz:overflow-hidden",
          done && "pz:transition-opacity pz:duration-300",
        )}
        style={{ ...area, borderRadius: radius, opacity: showing ? 1 : 0 }}
      >
        {frames.map((src, i) => (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: one recording's frames, fixed and in order
            key={i}
            src={src}
            alt=""
            className="pz:absolute pz:inset-0 pz:size-full"
            style={{ opacity: i === step ? 1 : 0 }}
          />
        ))}
        {showing && <div key={step} className="pz-tick pz:absolute pz:inset-0" />}
      </div>
      <svg
        aria-hidden
        className="pz:absolute pz:overflow-visible pz:text-[var(--pz-rind)] pz:transition-opacity pz:delay-150 pz:duration-500"
        style={{ ...ring, opacity: done ? 0 : 1 }}
      >
        <rect
          x={1}
          y={1}
          style={{
            width: "calc(100% - 2px)",
            height: "calc(100% - 2px)",
            transition: "stroke-dashoffset 130ms cubic-bezier(0.2, 0.8, 0.3, 1)",
          }}
          rx={ringRadius}
          pathLength={100}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="100 100"
          strokeDashoffset={100 - (Math.min(step + 1, n) * 100) / n}
        />
      </svg>
      {done && (
        <div className="pz-flare pz:absolute" style={{ ...ring, borderRadius: ringRadius }} />
      )}
    </>
  );
}
