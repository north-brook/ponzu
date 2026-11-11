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

test("each measured gesture goes to telemetry, which decides whether it's sent", () => {
  p.measured(pan);
  expect(tracked).toEqual([["canvas gesture", pan]]);
});
