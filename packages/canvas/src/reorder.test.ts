import { expect, test } from "bun:test";
import { clampShift, dropIndex, makeRoom, restAt, type Span } from "./reorder.ts";

// Three tabs, 2px apart: 0–50, 52–132, 134–164.
const spans: Span[] = [
  { left: 0, width: 50 },
  { left: 52, width: 80 },
  { left: 134, width: 30 },
];

test("a tab lands past each neighbour whose middle its leading edge crosses", () => {
  expect(dropIndex(spans, 0, 0)).toBe(0);
  // Its right edge (50) has to pass the next tab's middle (92).
  expect(dropIndex(spans, 0, 41)).toBe(0);
  expect(dropIndex(spans, 0, 43)).toBe(1);
  expect(dropIndex(spans, 0, 114)).toBe(2);
  // Its left edge (134) has to pass the middle before it (92), then the first (25).
  expect(dropIndex(spans, 2, -41)).toBe(2);
  expect(dropIndex(spans, 2, -43)).toBe(1);
  expect(dropIndex(spans, 2, -110)).toBe(0);
});

test("a tab wider than the first still reaches the start", () => {
  const row: Span[] = [
    { left: 0, width: 30 },
    { left: 32, width: 120 },
  ];
  expect(dropIndex(row, 1, clampShift(row, 1, -1000))).toBe(0);
  expect(dropIndex(row, 0, clampShift(row, 0, 1000))).toBe(1);
});

test("it stays within the row", () => {
  expect(clampShift(spans, 0, -20)).toBe(0);
  expect(clampShift(spans, 0, 500)).toBe(114);
  expect(clampShift(spans, 2, -500)).toBe(-134);
});

test("the tabs it passes make room for it, by its width and gap", () => {
  // The first tab over the last slot: the other two shift left by 52.
  expect([0, 1, 2].map((i) => makeRoom(spans, 0, 2, i))).toEqual([0, -52, -52]);
  // The last tab over the first slot: the other two shift right by 32.
  expect([0, 1, 2].map((i) => makeRoom(spans, 2, 0, i))).toEqual([32, 32, 0]);
  expect([0, 1, 2].map((i) => makeRoom(spans, 1, 1, i))).toEqual([0, 0, 0]);
});

test("let go, it rests where its new place is", () => {
  expect(restAt(spans, 0, 2)).toBe(114);
  expect(restAt(spans, 2, 0)).toBe(-134);
  expect(restAt(spans, 0, 1)).toBe(82);
  // With room made, the row tiles again: the tab that made room, the gap, then the one put down.
  const made = spans[1]!.left + makeRoom(spans, 0, 1, 1);
  expect(made).toBe(0);
  expect(spans[0]!.left + restAt(spans, 0, 1)).toBe(made + spans[1]!.width + 2);
  expect(restAt(spans, 1, 1)).toBe(0);
});
