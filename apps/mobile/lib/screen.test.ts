import { expect, test } from "bun:test";
import { concentric, displayRadius } from "./screen";

test("the display's corner by its size, either way round, and the Pro's for one unknown", () => {
  expect(displayRadius(402, 874)).toBe(55);
  expect(displayRadius(874, 402)).toBe(55);
  expect(displayRadius(390, 844)).toBeCloseTo(47.33, 2);
  expect(displayRadius(500, 1000)).toBe(55);
});

test("a corner 8pt in from the edges is the display's less 8", () => {
  expect(concentric(402, 874, 8)).toBe(47);
  expect(concentric(390, 844, 8)).toBeCloseTo(39.33, 2);
  expect(concentric(375, 812, 60)).toBe(0);
});
