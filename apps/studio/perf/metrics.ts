/*
 * The numbers a scenario reports, what each means, and how two runs of them compare. Pure, so
 * tested on its own (metrics.test.ts).
 *
 * Two kinds of number:
 *
 * - **Counts** (elements restyled, layout objects, paints, React commits): what the browser and
 *   React did. A gesture is a fixed number of frames, so these come out nearly the same on a
 *   laptop and on CI's runner, and a change of a few percent is a real change.
 * - **Times** (frame rate, main-thread ms, latencies): this machine's, and noisy. Compared only
 *   with a run of the base on the same machine in the same job, interleaved with it, and called
 *   a change only when it is bigger than the runs' own spread.
 */

export type Kind = "count" | "time";

export interface MetricInfo {
  label: string;
  unit: "ms" | "fps" | "" | "/frame";
  kind: Kind;
  better: "lower" | "higher";
  /** What it means, for the report's key. */
  means: string;
}

/**
 * The target: a ProMotion Mac's 120 frames a second, so 8.3 ms a frame. The harness draws as a
 * 120 Hz display would (probe.ts), with Chrome never held to 60 (app.ts).
 */
export const TARGET_FPS = 120;
export const BUDGET_MS = 1000 / TARGET_FPS;

/** A gesture holds the target at this frame rate or more (the clock's own overhead aside). */
export const HOLDS_FPS = TARGET_FPS * 0.95;

/**
 * Gestures whose frames only scroll (a pan moves the plane by scrolling it). Headless Chrome
 * draws a frame that only scrolls at about 57 a second however little it costs, so their frame
 * rate says nothing about 120 there; their main thread and counts still do. The desktop app,
 * uncapped, has no such limit.
 */
export function scrollsOnly(scenario: string): boolean {
  return /\.pan$/.test(scenario);
}

/** A frame that takes this much longer than the budget has missed a 120 Hz refresh. */
const MISSED = BUDGET_MS * 1.5;

export const METRICS: Record<string, MetricInfo> = {
  fps: {
    label: "Frame rate",
    unit: "fps",
    kind: "time",
    better: "higher",
    means: `Frames a second while the gesture played, of the ${TARGET_FPS} a ProMotion display shows.`,
  },
  missed: {
    label: "Missed frames",
    unit: "",
    kind: "time",
    better: "lower",
    means: `Frames of the gesture that took over 1.5 × ${round(BUDGET_MS, 1)} ms: each one misses a 120 Hz refresh.`,
  },
  frameP95: {
    label: "p95 frame",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: `The 95th percentile time between frames during the gesture; ${round(BUDGET_MS, 1)} ms holds 120 fps.`,
  },
  longFrames: {
    label: "Long frames",
    unit: "",
    kind: "time",
    better: "lower",
    means: "Frames that took over 50 ms: a visible hitch each.",
  },
  settleMs: {
    label: "Settle",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The longest frame in the rest after the gesture, when the canvas redraws sharp.",
  },
  latencyMs: {
    label: "Latency",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "From the action to the frame that shows its result.",
  },
  inputP95: {
    label: "Input p95",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "From a key pressed to just after the frame that showed it, p95.",
  },
  mainMs: {
    label: "Main thread",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The renderer's main thread busy during the scenario.",
  },
  scriptMs: {
    label: "Script",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "JavaScript on the main thread.",
  },
  styleMs: {
    label: "Style",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "Style recalculation on the main thread.",
  },
  layoutMs: {
    label: "Layout",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "Layout on the main thread.",
  },
  paintMs: {
    label: "Paint",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "Pre-paint, paint and layerizing on the main thread.",
  },
  rasterMs: {
    label: "Raster",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "Raster on the renderer's worker threads.",
  },
  gpuMs: {
    label: "GPU",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The GPU process's main thread.",
  },
  tiles: {
    label: "Tiles",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Tiles rastered during the scenario: how much was drawn again.",
  },
  restTiles: {
    label: "Tiles after",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Tiles rastered in the rest after the gesture, as the canvas redraws sharp.",
  },
  restGpuMs: {
    label: "GPU after",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The GPU process's main thread busy in the rest after the gesture (raster, mostly).",
  },
  restMainMs: {
    label: "Main after",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The renderer's main thread busy in the rest after the gesture.",
  },
  sharpMs: {
    label: "Sharp",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "From the gesture's end to the last tile rastered after it: when the canvas is sharp.",
  },
  longestTaskMs: {
    label: "Longest task",
    unit: "ms",
    kind: "time",
    better: "lower",
    means: "The longest single task on the main thread: the worst freeze.",
  },
  restyledPerFrame: {
    label: "Restyled / frame",
    unit: "/frame",
    kind: "count",
    better: "lower",
    means: "Elements whose style was recalculated, per frame of the gesture.",
  },
  laidOutPerFrame: {
    label: "Laid out / frame",
    unit: "/frame",
    kind: "count",
    better: "lower",
    means: "Layout objects laid out again, per frame of the gesture.",
  },
  restyled: {
    label: "Restyled",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Elements whose style was recalculated, in all.",
  },
  laidOut: {
    label: "Laid out",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Layout objects laid out again, in all.",
  },
  commits: {
    label: "React commits",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Times React committed a render to the page.",
  },
  domNodes: {
    label: "DOM elements",
    unit: "",
    kind: "count",
    better: "lower",
    means: "Elements in the page, shadow roots included, once the scenario has settled.",
  },
};

/** Frame-clock numbers for the frames between `from` and `to` (performance.now() ms). */
export function frameStats(
  frames: number[],
  from: number,
  to: number,
): {
  frames: number;
  fps: number;
  frameP95: number;
  missed: number;
  longFrames: number;
  maxFrame: number;
} {
  const f = frames.filter((t) => t >= from && t <= to);
  const gaps = f.slice(1).map((t, i) => t - f[i]!);
  const span = f.length > 1 ? f[f.length - 1]! - f[0]! : 0;
  return {
    frames: f.length,
    fps: span > 0 ? round(((f.length - 1) * 1000) / span, 1) : 0,
    frameP95: round(percentile(gaps, 0.95), 1),
    missed: gaps.filter((g) => g > MISSED).length,
    longFrames: gaps.filter((g) => g > 50).length,
    maxFrame: round(Math.max(0, ...gaps), 1),
  };
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]!;
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function round(n: number, digits = 0): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** A metric across a build's rounds: its median, and how far apart the rounds were. */
export interface Aggregate {
  median: number;
  min: number;
  max: number;
  n: number;
}

export function aggregate(values: number[]): Aggregate {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    n: values.length,
  };
}

export type Verdict = "better" | "worse" | "same";

/**
 * Whether head differs from base by more than noise: by 3% for a count and 10% for a time, past
 * both builds' own spread (their rounds' ranges don't overlap), and by more than a hair (one
 * element, 1 fps, 10 ms). A time is never called from fewer than three rounds a build. Counts
 * mostly repeat to within a percent or two, but a few lean on timing (how many frames a redraw
 * lands in, how React batches), and the spread tells those apart.
 */
export function compare(name: string, base: Aggregate, head: Aggregate): Verdict {
  const info = METRICS[name];
  if (!info) return "same";
  const diff = head.median - base.median;
  if (diff === 0) return "same";
  const rel = base.median === 0 ? Number.POSITIVE_INFINITY : Math.abs(diff) / base.median;
  // Two rounds of a time don't overlap one time in three by chance alone: a time needs three.
  if (info.kind === "time" && (base.n < 3 || head.n < 3)) return "same";
  const apart = head.min > base.max || head.max < base.min || (base.n === 1 && head.n === 1);
  // A few ms of main thread in a gesture of two seconds is noise however large a share.
  // A count wanders by an element or two between rounds when it's tiny: 1 → 2 is no change.
  const floor = info.unit === "ms" ? 10 : info.kind === "count" ? 5 : 1;
  const real = rel >= (info.kind === "count" ? 0.03 : 0.1) && Math.abs(diff) >= floor && apart;
  if (!real) return "same";
  const up = diff > 0;
  return up === (info.better === "higher") ? "better" : "worse";
}
