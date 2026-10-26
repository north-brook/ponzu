import { describe, expect, test } from "bun:test";
import { cameraMoves, cpuTime, frames, settle, stages } from "./metrics.ts";

describe("frames", () => {
  test("fps and the longest gap", () => {
    const t = [0, 16, 32, 48, 100, 116];
    const f = frames(t);
    expect(f.fps).toBeCloseTo(43.1, 1);
    expect(f.max).toBe(52);
    expect(f.jank).toBe(1);
  });
});

describe("cameraMoves", () => {
  test("counts moves inside gestures only, timed from first to last move", () => {
    const moves = [10, 26, 42, 58, 500, 900, 916, 932, 1000];
    const r = cameraMoves(moves, [
      [0, 60],
      [890, 1000],
    ]);
    // 3 intervals over 48 ms, then 3 over 100 ms; the 500 between gestures isn't counted.
    expect(r.movesPerS).toBeCloseTo((6 / 148) * 1000, 1);
    expect(r.maxGapMs).toBe(68);
  });

  test("no movement reads as none", () => {
    expect(cameraMoves([5], [[0, 100]])).toEqual({ movesPerS: 0, maxGapMs: 0 });
  });
});

describe("settle", () => {
  test("first frame after the lift and the longest in the next second", () => {
    expect(settle([90, 110, 126, 300, 316, 1090, 1106, 1122], 100)).toEqual({
      firstMs: 10,
      maxMs: 774,
    });
  });
  test("a stall that runs past the second still counts", () => {
    expect(settle([110, 1500], 100)).toEqual({ firstMs: 10, maxMs: 1390 });
    expect(settle([90, 1500, 1516], 100)).toEqual({ firstMs: 1400, maxMs: 1400 });
  });
  test("nothing drawn", () => {
    expect(settle([], 100)).toEqual({ firstMs: null, maxMs: null });
  });
});

describe("stages", () => {
  test("self time by stage, children not counted twice", () => {
    const r = stages([
      {
        type: "TimerFire",
        startTime: 0,
        endTime: 0.01,
        children: [{ type: "FunctionCall", startTime: 0.001, endTime: 0.009 }],
      },
      { type: "Layout", startTime: 0.02, endTime: 0.025 },
      { type: "Paint", startTime: 0.03, endTime: 0.031 },
    ]);
    expect(r).toEqual({ script: 10, layout: 5, paint: 1 });
  });
});

describe("cpuTime", () => {
  test("reads ps's formats", () => {
    expect(cpuTime("0:01.50")).toBe(1500);
    expect(cpuTime("492:42.07")).toBe((492 * 60 + 42.07) * 1000);
    expect(cpuTime("1:02:03.00")).toBe(3723000);
    expect(cpuTime("2-00:00:00.00")).toBe(2 * 86400000);
  });
});
