import { describe, expect, test } from "bun:test";
import { aggregate, compare, frameStats, percentile } from "./metrics.ts";
import { historyEntry, MARKER, parseHistory, type Results, report, sparkline } from "./report.ts";
import { summarize, type TraceEvent } from "./trace.ts";

describe("frame numbers", () => {
  test("a steady 60 Hz reads as 60 fps with no long frames", () => {
    const frames = Array.from({ length: 61 }, (_, i) => 1000 + i * (1000 / 60));
    const s = frameStats(frames, 1000, 2000);
    expect(s.fps).toBe(60);
    expect(s.longFrames).toBe(0);
    expect(s.frameP95).toBeCloseTo(16.7, 1);
  });

  test("a hitch is a long frame, and only frames in the window count", () => {
    const frames = [0, 16, 32, 48, 148, 164, 5000];
    const s = frameStats(frames, 0, 200);
    expect(s.frames).toBe(6);
    expect(s.longFrames).toBe(1);
    expect(s.maxFrame).toBe(100);
  });

  test("percentiles take the value at or above the rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("what counts as a change", () => {
  test("a count moves for real at 3%, past its rounds' spread", () => {
    expect(compare("restyledPerFrame", aggregate([1000]), aggregate([1040]))).toBe("worse");
    expect(compare("restyledPerFrame", aggregate([1000]), aggregate([1020]))).toBe("same");
    // A count that leans on timing wanders between rounds: overlapping, it hasn't moved.
    expect(compare("laidOutPerFrame", aggregate([28, 63, 40]), aggregate([45, 70, 30]))).toBe(
      "same",
    );
    expect(compare("restyledPerFrame", aggregate([4500]), aggregate([650]))).toBe("better");
  });

  test("a time must leave both builds' spread", () => {
    // Overlapping rounds: noise, however far the medians are.
    expect(compare("mainMs", aggregate([100, 140, 180]), aggregate([150, 170, 190]))).toBe("same");
    expect(compare("mainMs", aggregate([100, 105, 110]), aggregate([150, 160, 170]))).toBe("worse");
    expect(compare("fps", aggregate([40, 42, 44]), aggregate([58, 59, 60]))).toBe("better");
    // Under 10%: same, even apart.
    expect(compare("mainMs", aggregate([100, 101, 102]), aggregate([105, 106, 107]))).toBe("same");
    // A few ms, however large a share: noise.
    expect(compare("mainMs", aggregate([60, 61, 62]), aggregate([69, 70, 71]))).toBe("same");
    // Fewer than three rounds: never called.
    expect(compare("mainMs", aggregate([100, 105]), aggregate([300, 310]))).toBe("same");
  });
});

describe("Chrome's trace, summed", () => {
  test("reads the main thread's phases and counts by thread", () => {
    const meta = (pid: number, tid: number, name: string): TraceEvent => ({
      name: "thread_name",
      ph: "M",
      pid,
      tid,
      ts: 0,
      args: { name },
    });
    const x = (pid: number, tid: number, name: string, ms: number, args = {}): TraceEvent => ({
      name,
      ph: "X",
      pid,
      tid,
      ts: 0,
      dur: ms * 1000,
      args,
    });
    const s = summarize([
      meta(1, 1, "CrRendererMain"),
      meta(1, 2, "ThreadPoolForegroundWorker"),
      meta(2, 1, "CrGpuMain"),
      x(1, 1, "ThreadControllerImpl::RunTask", 30),
      x(1, 1, "ThreadControllerImpl::RunTask", 12),
      x(1, 1, "UpdateLayoutTree", 8, { elementCount: 4500 }),
      x(1, 1, "UpdateLayoutTree", 2, { elementCount: 100 }),
      x(1, 1, "Layout", 3, { beginData: { dirtyObjects: 40 } }),
      x(1, 1, "Paint", 1),
      x(1, 1, "FunctionCall", 5),
      x(1, 2, "RasterTask", 7),
      x(2, 1, "ThreadControllerImpl::RunTask", 9),
    ]);
    expect(s).toMatchObject({
      mainMs: 42,
      longestTaskMs: 30,
      styleMs: 10,
      recalcs: 2,
      restyled: 4600,
      layouts: 1,
      laidOut: 40,
      paints: 1,
      scriptMs: 5,
      rasterMs: 7,
      gpuMs: 9,
    });
  });
});

const results = (base: number[] | null, head: number[]): Results => ({
  date: "2026-11-13T00:00:00.000Z",
  machine: "test",
  rounds: head.length,
  head: { sha: "aaaaaaaaaa", runs: { "website.zoom": { restyledPerFrame: head, fps: [60] } } },
  base: base
    ? { sha: "bbbbbbbbbb", runs: { "website.zoom": { restyledPerFrame: base, fps: [60] } } }
    : null,
  scenarios: [
    {
      id: "website.zoom",
      suite: "website",
      surface: "canvas",
      title: "Pinch zoom",
      headline: ["fps", "restyledPerFrame"],
    },
  ],
  suites: [{ id: "website", surface: "canvas", about: "Two tall pages." }],
  errors: [],
});

describe("the comment", () => {
  test("starts with its marker, so the workflow finds it again", () => {
    expect(report(results(null, [10])).startsWith(MARKER)).toBe(true);
  });

  test("names what got worse, and says when nothing moved", () => {
    const worse = report(results([650], [4500]));
    expect(worse).toContain("0 better, 1 worse");
    expect(worse).toContain("🔴 **website.zoom** Restyled / frame");
    expect(report(results([650], [651]))).toContain("**No change**");
  });

  test("draws main's trend from history", () => {
    const history = [0, 1, 2].map((i) => ({
      sha: `s${i}`,
      date: "",
      medians: { "website.zoom": { fps: 40 + i * 10 } },
    }));
    expect(report(results(null, [10]), history)).toContain(`${sparkline([40, 50, 60])} 60 fps`);
  });

  test("a history line holds each metric's median, and bad lines are skipped", () => {
    const entry = historyEntry(results(null, [3, 1, 2]));
    expect(entry.medians["website.zoom"]!.restyledPerFrame).toBe(2);
    expect(parseHistory(`${JSON.stringify(entry)}\nnot json\n`)).toEqual([entry]);
  });
});
