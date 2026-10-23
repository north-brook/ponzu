import { expect, test } from "bun:test";
import { at, bezier, CURVES, IDLE, TO_DESIGNS, TO_TILE } from "./handoff";

test("curves start at 0, end at 1 and only go up", () => {
  for (const c of Object.values(CURVES)) {
    expect(bezier(0, c)).toBe(0);
    expect(bezier(1, c)).toBe(1);
    for (let x = 0.05; x <= 1; x += 0.05) expect(bezier(x, c)).toBeGreaterThan(bezier(x - 0.05, c));
  }
  // ease-out is quick to start, ease-in slow.
  expect(bezier(0.3, CURVES.out)).toBeGreaterThan(0.6);
  expect(bezier(0.3, CURVES.in)).toBeLessThan(0.15);
});

test("a part waits for its stretch, then settles in place", () => {
  expect(at(0, TO_TILE.rise, CURVES.out)).toBe(0);
  expect(at(TO_TILE.rise[0], TO_TILE.rise, CURVES.out)).toBe(0);
  expect(at(TO_TILE.end, TO_TILE.rise, CURVES.out)).toBe(1);
  expect(at(IDLE, TO_DESIGNS.glide, CURVES.out)).toBe(1);
  // A staggered part runs its delay later.
  expect(at(TO_DESIGNS.rise[1], TO_DESIGNS.rise, CURVES.out, 165)).toBeLessThan(1);
});

test("the studies' order: the wordmark leaves first, the content comes last", () => {
  expect(TO_TILE.word[0]).toBeLessThan(TO_TILE.shrink[0]);
  expect(TO_TILE.shrink[1]).toBeLessThan(TO_TILE.rise[1]);
  expect(TO_DESIGNS.glide[1]).toBeLessThan(TO_DESIGNS.end);
  expect(TO_DESIGNS.rise[1] + TO_DESIGNS.delays.at(-1)!).toBe(TO_DESIGNS.end);
  // About 1.1s from the slice setting off to it landing in the lockup.
  expect(TO_DESIGNS.glide[1] - TO_DESIGNS.glide[0]).toBe(1100);
});
