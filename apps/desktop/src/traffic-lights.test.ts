import { expect, test } from "bun:test";
import { trafficLights } from "./traffic-lights.ts";

// The chrome is 44px tall and the sidebar toggle beside the lights is centred on it, at 22.
const centre = (version: string, height: number) => trafficLights(version).y + height / 2;

test("the larger lights of macOS 26 and later sit centred on the chrome", () => {
  expect(centre("26.0", 14)).toBe(22);
  expect(centre("27.0.1", 14)).toBe(22);
});

test("the smaller lights of an older macOS sit centred too", () => {
  expect(centre("15.6.1", 12)).toBe(22);
  expect(centre("14.0", 12)).toBe(22);
});

test("a version it cannot read is taken for a current one", () => {
  expect(trafficLights("")).toEqual({ x: 16, y: 15 });
});
