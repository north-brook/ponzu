import type { GesturePerf } from "../canvas/protocol";
import { canTrack, track } from "./telemetry";

/**
 * How smoothly the canvas moves on a real phone: the page measures its own gestures (canvas/
 * probe.ts, as apps/mobile/perf measures it in WebKit) and posts one `perf` per gesture.
 * Development measures every one and logs it to Metro (`[perf] pan …`); production measures a
 * sample, for telemetry, where the build can send it; otherwise nothing is measured.
 */

/** One gesture in twenty, in production. */
const SAMPLE = 0.05;

export function probeRate(dev: boolean, tracked: boolean): number {
  return dev ? 1 : tracked ? SAMPLE : 0;
}

const dev = typeof __DEV__ !== "undefined" && __DEV__;
export const PROBE_RATE = probeRate(dev, canTrack);

/** A gesture's line in Metro. */
export function describe(g: GesturePerf): string {
  const long =
    g.longTasks !== undefined ? `, ${g.longTasks} long tasks (${g.longestTaskMs} ms)` : "";
  return `[perf] ${g.kind} ${g.ms} ms: ${g.movesPerS} moves/s, longest wait ${g.maxGapMs} ms; ${g.fps} fps, longest frame ${g.max} ms, ${g.jank} over 33 ms${long}; ${g.boards} boards`;
}

export function measured(g: GesturePerf) {
  // Development only logs, even with a key set: telemetry is production's.
  if (dev) return console.log(describe(g));
  track("canvas gesture", g);
}
