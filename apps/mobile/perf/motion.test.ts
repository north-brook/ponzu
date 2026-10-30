import { describe, expect, test } from "bun:test";
import {
  deviations,
  type FrameStep,
  hitches,
  meanDiff,
  motions,
  overall,
  shiftBetween,
  smoothness,
  spectrum,
} from "./motion.ts";

/** A picture of soft blobs, its content moved by (dx, dy): any fraction of a pixel. */
function blobs(size: number, dx: number, dy: number) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const spots = Array.from({ length: 40 }, () => ({
    x: rand() * size * 1.5 - size * 0.25,
    y: rand() * size * 1.5 - size * 0.25,
    r: 2 + rand() * 5,
    v: 60 + rand() * 180,
  }));
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 20;
      for (const s of spots) {
        const d2 = (x - dx - s.x) ** 2 + (y - dy - s.y) ** 2;
        v += s.v * Math.exp(-d2 / (2 * s.r * s.r));
      }
      out[y * size + x] = Math.min(255, Math.round(v));
    }
  return out;
}

describe("shiftBetween", () => {
  test("finds how far the content moved, to a fraction of a pixel", () => {
    const a = spectrum(blobs(64, 0, 0), 64);
    for (const [dx, dy] of [
      [5, -3],
      [-12, 7],
      [2.5, 0.4],
    ] as const) {
      const s = shiftBetween(a, spectrum(blobs(64, dx, dy), 64));
      expect(Math.abs(s.dx - dx)).toBeLessThan(0.35);
      expect(Math.abs(s.dy - dy)).toBeLessThan(0.35);
      expect(s.peak).toBeGreaterThan(0.1);
    }
  });

  test("the same picture hasn't moved, sure of it; a blank one gives nothing to go on", () => {
    const a = spectrum(blobs(64, 0, 0), 64);
    const same = shiftBetween(a, spectrum(blobs(64, 0, 0), 64));
    expect(Math.abs(same.dx) + Math.abs(same.dy)).toBeLessThan(0.01);
    expect(same.peak).toBeGreaterThan(0.9);
    const flat = spectrum(new Uint8Array(64 * 64).fill(128), 64);
    expect(shiftBetween(flat, flat).peak).toBe(0);
  });

  test("sizes that aren't a power of two are refused", () => {
    expect(() => spectrum(new Uint8Array(48 * 48), 48)).toThrow();
  });
});

test("meanDiff is the mean absolute difference", () => {
  expect(meanDiff(Uint8Array.of(0, 10, 20, 30), Uint8Array.of(4, 10, 16, 30))).toBe(2);
});

const FRAME = 1000 / 60;
/**
 * A recording: one frame per 60th of a second. `px` per frame, a step of 0 a held frame (the
 * picture repeated), null a still one outside any motion.
 */
function video(px: (number | null)[]): FrameStep[] {
  return [null, ...px].map((p, i) => ({
    t: i * FRAME,
    diff: p ? 20 : 0.02,
    dx: p ?? 0,
    dy: 0,
    peak: p ? 0.7 : 1,
  }));
}

describe("motions", () => {
  test("a steady pan with a dropped frame and a dropped pair: holds counted, the catch-up after each", () => {
    const steps = video([10, 10, 10, 0, 20, 10, 10, 0, 0, 30, 10, 10, 10]);
    const [m, ...rest] = motions(steps);
    expect(rest).toEqual([]);
    expect(m!.moved).toBe(10);
    expect(m!.held).toBe(3);
    expect(m!.maxGapMs).toBe(50);
    // 9 intervals over 12 frames.
    expect(m!.movesPerS).toBeCloseTo((9 / (12 * FRAME)) * 1000, 0);
    // Each catch-up lands where the clock says: the steps are even once the holds are taken out.
    expect(m!.jitter.median).toBe(0);
    expect(m!.peakSpeed).toBe(600);

    const h = hitches(steps, [m!]);
    expect(h.map((x) => [x.held, x.ms])).toEqual([
      [2, 50],
      [1, 33.3],
    ]);
    expect(h[0]!.before).toBe(600);
    expect(h[0]!.after).toBe(600);

    const all = overall(steps, [m!]);
    expect(all).toMatchObject({ motions: 1, moved: 10, held: 3, heldPct: 23.1, maxGapMs: 50 });
  });

  test("a long still between two pans is rest, not a hitch", () => {
    const pan = [10, 10, 10, 10, 10];
    const ms = motions(video([...pan, ...Array(70).fill(null), ...pan]));
    expect(ms.length).toBe(2);
    expect(ms.every((m) => m.held === 0 && m.maxGapMs === 16.7)).toBe(true);
  });

  test("a glide's last pixels, landing a frame here and there, end it rather than counting as hitches", () => {
    const ms = motions(video([20, 15, 10, 6, 3, 1, 0, 0, 1, 0, 0, 0, 1]));
    expect(ms.length).toBe(1);
    expect(ms[0]!.held).toBe(0);
  });

  test("a flicker of a frame or two isn't motion", () => {
    expect(motions(video([null, 5, null, null, null, 5, 5, null]))).toEqual([]);
  });
});

describe("deviations", () => {
  test("steady motion and a steady ease are smooth", () => {
    expect(smoothness(deviations(video(Array(12).fill(12)))).median).toBe(0);
    const ease = Array.from({ length: 20 }, (_, i) => 40 * (1 - i / 20) ** 2 + 4);
    const s = smoothness(deviations(video(ease)));
    expect(s.p95).toBeLessThan(5);
  });

  test("short-long steps, as a camera moved by touches as they arrive, are uneven", () => {
    const s = smoothness(deviations(video([6, 14, 6, 14, 6, 14, 6, 14, 6, 14, 6, 14])));
    expect(s.median).toBeGreaterThan(50);
    expect(s.uneven).toBe(100);
  });

  test("too slow to judge, nothing is judged", () => {
    expect(smoothness(deviations(video([1, 1, 1, 1, 1, 1, 1, 1]))).n).toBe(0);
  });
});
