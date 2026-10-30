import { expect, mock, test } from "bun:test";
import type { GesturePerf } from "../canvas/protocol";

const tracked: unknown[] = [];
mock.module("./telemetry", () => ({
  canTrack: false,
  track: (...e: unknown[]) => tracked.push(e),
}));
const p = await import("./canvas-perf");

test("every gesture measured in development, a sample where production can send it, else none", () => {
  expect(p.probeRate(true, false)).toBe(1);
  expect(p.probeRate(false, true)).toBeGreaterThan(0);
  expect(p.probeRate(false, true)).toBeLessThan(0.2);
  expect(p.probeRate(false, false)).toBe(0);
});

const pan: GesturePerf = {
  kind: "pan",
  ms: 640,
  fps: 52.1,
  p95: 33.3,
  max: 50,
  jank: 4,
  moves: 30,
  movesPerS: 46.2,
  maxGapMs: 50,
  boards: 12,
};

test("a gesture's line in Metro", () => {
  expect(p.describe(pan)).toBe(
    "[perf] pan 640 ms: 46.2 moves/s, longest wait 50 ms; 52.1 fps, longest frame 50 ms, 4 over 33 ms; 12 boards",
  );
  expect(p.describe({ ...pan, longTasks: 2, longestTaskMs: 88 })).toContain(
    ", 2 long tasks (88 ms);",
  );
});

test("each measured gesture goes to telemetry, which decides whether it's sent", () => {
  p.measured(pan);
  expect(tracked).toEqual([["canvas gesture", pan]]);
});
