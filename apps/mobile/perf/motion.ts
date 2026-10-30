/*
 * The numbers from a screen recording of the canvas: how far the picture moved between two frames
 * of the video, whether it moved at all, and what that says about pacing while it moved. Plain
 * functions over grayscale pixels and frame times, so they're tested without a video;
 * `recording.ts` decodes one and feeds them.
 */
import { cameraMoves, round } from "./metrics.ts";

/** A frame of the video, downscaled to `size`×`size` grayscale (0–255), as phase correlation wants it. */
export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
  size: number;
}

/** In-place radix-2 FFT of one row or column (`n` a power of two), `stride` apart from `offset`. */
function fft1(
  re: Float64Array,
  im: Float64Array,
  n: number,
  offset: number,
  stride: number,
  inverse: boolean,
) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      [re[a], re[b]] = [re[b]!, re[a]!];
      [im[a], im[b]] = [im[b]!, im[a]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = offset + (i + k) * stride;
        const b = offset + (i + k + len / 2) * stride;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, size: number, inverse = false) {
  for (let y = 0; y < size; y++) fft1(re, im, size, y * size, 1, inverse);
  for (let x = 0; x < size; x++) fft1(re, im, size, x, size, inverse);
}

/**
 * A frame's spectrum, for `shiftBetween`. Its mean is taken out and its edges faded (a Hann
 * window), so the picture's border, which doesn't move with the content, doesn't win.
 */
export function spectrum(gray: Uint8Array, size: number): Spectrum {
  if (size & (size - 1) || gray.length !== size * size)
    throw new Error("size must be a power of two");
  let mean = 0;
  for (const v of gray) mean += v;
  mean /= gray.length;
  const hann = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)),
  );
  const re = new Float64Array(size * size);
  const im = new Float64Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      re[y * size + x] = (gray[y * size + x]! - mean) * hann[x]! * hann[y]!;
  fft2(re, im, size);
  return { re, im, size };
}

/**
 * How far the content moved from `a` to `b`, in pixels of the downscaled frame, by phase
 * correlation: the peak of the normalised cross-power spectrum's inverse, refined to a fraction of
 * a pixel. `peak` is its height (1 for a pure shift, near 0 when nothing in the two lines up: a
 * zoom, a cut, a blank screen). Shifts wrap at half the frame.
 */
export function shiftBetween(a: Spectrum, b: Spectrum): { dx: number; dy: number; peak: number } {
  const n = a.size;
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let energy = 0;
  for (let i = 0; i < n * n; i++) {
    // B · conj(A): a delta where b's content sits relative to a's.
    const r = b.re[i]! * a.re[i]! + b.im[i]! * a.im[i]!;
    const m = b.im[i]! * a.re[i]! - b.re[i]! * a.im[i]!;
    const mag = Math.hypot(r, m);
    energy += mag;
    if (mag > 1e-9) {
      re[i] = r / mag;
      im[i] = m / mag;
    }
  }
  // Two flat frames: nothing to line up.
  if (energy < 1e-6) return { dx: 0, dy: 0, peak: 0 };
  fft2(re, im, n, true);
  let best = 0;
  for (let i = 1; i < n * n; i++) if (re[i]! > re[best]!) best = i;
  const px = best % n;
  const py = (best - px) / n;
  const at = (x: number, y: number) => re[((y + n) % n) * n + ((x + n) % n)]!;
  const vertex = (l: number, c: number, r: number) => {
    const d = l - 2 * c + r;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0;
  };
  const fx = vertex(at(px - 1, py), at(px, py), at(px + 1, py));
  const fy = vertex(at(px, py - 1), at(px, py), at(px, py + 1));
  const wrap = (v: number) => (v > n / 2 ? v - n : v);
  return { dx: wrap(px) + fx, dy: wrap(py) + fy, peak: at(px, py) / (n * n) };
}

/** The mean absolute difference of two frames, in gray levels (0–255). */
export function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** One frame of the video against the one before it. */
export interface FrameStep {
  /** Its presentation time, ms. */
  t: number;
  /** How different it is from the frame before, gray levels. */
  diff: number;
  /** How far the content moved since the frame before, in the recording's px. */
  dx: number;
  dy: number;
  /** How sure that is (phase correlation's peak, 0–1). */
  peak: number;
}

export interface Options {
  /** A frame at most this different from the one before shows the same picture (encoder noise). */
  stillDiff: number;
  /** The picture held still this long is at rest: a new motion starts with the next change. */
  restMs: number;
  /**
   * px/s. A hold out of motion slower than this is a stop (a glide's last px land a frame here and
   * there), not a hitch; and slower than this, a step isn't judged for smoothness.
   */
  restSpeed: number;
  /** A measured shift needs a phase correlation peak this high. */
  minPeak: number;
  /** Motions with fewer changed frames than this are flickers, not motion. */
  minFrames: number;
}

export const DEFAULTS: Options = {
  stillDiff: 0.35,
  restMs: 1000,
  restSpeed: 150,
  minPeak: 0.08,
  minFrames: 4,
};

export interface Motion {
  /** Frame indices of its first change and its last. */
  from: number;
  to: number;
  /** ms into the video. */
  start: number;
  end: number;
  /** Frames in which the picture changed, and frames inside the motion that repeated the one before. */
  moved: number;
  held: number;
  /** Changed frames per second of moving, and the longest wait between two: as `cameraMoves`. */
  movesPerS: number;
  maxGapMs: number;
  /** The fastest the content moved, px/s, and how far in all, px. */
  peakSpeed: number;
  distance: number;
  /** How evenly it stepped: see `deviations`. */
  jitter: Smoothness;
}

export interface Smoothness {
  /** Steps judged. */
  n: number;
  /** How far each was from where a smooth curve puts it, median and 95th percentile, %. */
  median: number;
  p95: number;
  /** Steps more than a quarter off, %. */
  uneven: number;
}

/** A wait of more than one frame inside a motion. */
export interface Hitch {
  /** ms into the video of the last change before it, and how long until the next. */
  at: number;
  ms: number;
  /** Frames repeated in it. */
  held: number;
  /** How fast the content moved into it and out of it, px/s (NaN where it couldn't be measured). */
  before: number;
  after: number;
}

const changedAt = (steps: FrameStep[], o: Options) =>
  steps.map((s, i) => i > 0 && s.diff > o.stillDiff);

/** px/s of the step at `i`, over the time since the change at `prev` (the step covers any held frames). */
function speed(steps: FrameStep[], i: number, prev: number, o: Options) {
  const s = steps[i]!;
  const dt = s.t - steps[prev]!.t;
  return s.peak >= o.minPeak && dt > 0 ? (Math.hypot(s.dx, s.dy) / dt) * 1000 : Number.NaN;
}

/**
 * Where the picture moved. Changed frames (more than `stillDiff` from the one before) are moves;
 * runs of them make a motion, which ends at a hold of `restMs`, or at any hold out of motion
 * already slower than `restSpeed`. Inside a motion, a held frame is one the person saw twice.
 */
export function motions(steps: FrameStep[], opts: Partial<Options> = {}): Motion[] {
  const o = { ...DEFAULTS, ...opts };
  const changed = changedAt(steps, o);
  const out: Motion[] = [];
  let first = -1;
  let prev = -1;
  let last = -1;
  const close = () => {
    const idx: number[] = [];
    for (let i = first; i <= last; i++) if (changed[i]) idx.push(i);
    if (first >= 0 && idx.length >= o.minFrames) out.push(summarize(steps, idx, o));
    first = prev = last = -1;
  };
  for (let i = 1; i < steps.length; i++) {
    if (!changed[i]) continue;
    if (first >= 0) {
      const gap = steps[i]!.t - steps[last]!.t;
      const frame = steps[last]!.t - steps[last - 1]!.t;
      // A motion's first change is timed from the frame before it.
      const slow = speed(steps, last, prev >= 0 ? prev : last - 1, o) < o.restSpeed;
      if (gap >= o.restMs || (slow && gap > frame * 1.5)) close();
    }
    if (first < 0) first = i;
    else prev = last;
    last = i;
  }
  close();
  return out;
}

function summarize(steps: FrameStep[], idx: number[], o: Options): Motion {
  const from = idx[0]!;
  const to = idx.at(-1)!;
  const span: [number, number] = [steps[from]!.t, steps[to]!.t];
  const { movesPerS, maxGapMs } = cameraMoves(
    idx.map((i) => steps[i]!.t),
    [span],
  );
  let peakSpeed = 0;
  let distance = 0;
  for (const [k, i] of idx.entries()) {
    const s = steps[i]!;
    if (s.peak < o.minPeak) continue;
    distance += Math.hypot(s.dx, s.dy);
    const v = k > 0 ? speed(steps, i, idx[k - 1]!, o) : Number.NaN;
    if (v > peakSpeed) peakSpeed = v;
  }
  return {
    from,
    to,
    start: round(span[0]),
    end: round(span[1]),
    moved: idx.length,
    held: to - from + 1 - idx.length,
    movesPerS,
    maxGapMs,
    peakSpeed: round(peakSpeed, 0),
    distance: round(distance, 0),
    jitter: smoothness(deviations(steps.slice(from - 1, to + 1), o)),
  };
}

/**
 * How unevenly the content stepped, apart from the frames it held: for each change, its velocity
 * (its step over the time since the last change, so the catch-up after a held frame is where it
 * should be) against where a smooth curve through the two changes either side puts it (a
 * parabola, so a glide's slowing isn't counted), as a share of that. Steady motion and a steady
 * ease give 0; a camera that moves by touches as they happen to arrive, rather than by the clock,
 * steps short then long. Only changes whose neighbours were all measured, moving faster than
 * `restSpeed`, are judged.
 */
export function deviations(steps: FrameStep[], opts: Partial<Options> = {}): number[] {
  const o = { ...DEFAULTS, ...opts };
  const changed = changedAt(steps, o);
  const v: ({ x: number; y: number } | null)[] = [];
  let prev = 0;
  for (let i = 1; i < steps.length; i++) {
    if (!changed[i]) continue;
    const s = steps[i]!;
    const dt = s.t - steps[prev]!.t;
    v.push(dt > 0 && s.peak >= o.minPeak ? { x: s.dx / dt, y: s.dy / dt } : null);
    prev = i;
  }
  const dev: number[] = [];
  for (let i = 2; i < v.length - 2; i++) {
    const c = v[i];
    const [a, b, d, e] = [v[i - 2], v[i - 1], v[i + 1], v[i + 2]];
    if (!c || !a || !b || !d || !e) continue;
    // The least-squares parabola through the four at -2, -1, 1 and 2, at 0.
    const mx = (4 * (b.x + d.x) - (a.x + e.x)) / 6;
    const my = (4 * (b.y + d.y) - (a.y + e.y)) / 6;
    const sp = Math.hypot(mx, my);
    if (sp * 1000 < o.restSpeed) continue;
    dev.push(Math.hypot(c.x - mx, c.y - my) / sp);
  }
  return dev;
}

export function smoothness(dev: number[]): Smoothness {
  if (!dev.length) return { n: 0, median: 0, p95: 0, uneven: 0 };
  const s = [...dev].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  return {
    n: dev.length,
    median: round(q(0.5) * 100),
    p95: round(q(0.95) * 100),
    uneven: round((dev.filter((d) => d > 0.25).length / dev.length) * 100),
  };
}

/** Every wait of more than one frame inside the motions, longest first. */
export function hitches(steps: FrameStep[], ms: Motion[], opts: Partial<Options> = {}): Hitch[] {
  const o = { ...DEFAULTS, ...opts };
  const changed = changedAt(steps, o);
  const out: Hitch[] = [];
  for (const m of ms) {
    let before = -1;
    let prev = -1;
    for (let i = m.from; i <= m.to; i++) {
      if (!changed[i]) continue;
      if (prev >= 0 && i - prev > 1)
        out.push({
          at: round(steps[prev]!.t),
          ms: round(steps[i]!.t - steps[prev]!.t),
          held: i - prev - 1,
          before: round(before >= 0 ? speed(steps, prev, before, o) : Number.NaN, 0),
          after: round(speed(steps, i, prev, o), 0),
        });
      before = prev;
      prev = i;
    }
  }
  return out.sort((a, b) => b.ms - a.ms || a.at - b.at);
}

/** Every motion together: the recording's line. */
export function overall(steps: FrameStep[], ms: Motion[], opts: Partial<Options> = {}) {
  const o = { ...DEFAULTS, ...opts };
  const changed = changedAt(steps, o);
  const moves = steps.filter((_, i) => changed[i]).map((s) => s.t);
  const span = steps.length > 1 ? steps.at(-1)!.t - steps[0]!.t : 0;
  const moved = ms.reduce((s, m) => s + m.moved, 0);
  const held = ms.reduce((s, m) => s + m.held, 0);
  return {
    frames: steps.length,
    videoFps: span > 0 ? round(((steps.length - 1) / span) * 1000) : 0,
    motions: ms.length,
    movingMs: round(ms.reduce((s, m) => s + m.end - m.start, 0)),
    moved,
    held,
    heldPct: moved + held ? round((held / (moved + held)) * 100) : 0,
    ...cameraMoves(
      moves,
      ms.map((m) => [m.start, m.end]),
    ),
    jitter: smoothness(ms.flatMap((m) => deviations(steps.slice(m.from - 1, m.to + 1), o))),
  };
}
