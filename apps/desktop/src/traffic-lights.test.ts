import { expect, test } from "bun:test";
import { CHROME, trafficLights } from "./traffic-lights.ts";

// The sidebar toggle beside the lights is centred on the chrome: so are they.
const centre = (version: string, height: number) => trafficLights(version).y + height / 2;

test("the chrome is as tall as the studio draws it", async () => {
  const source = await Bun.file(
    new URL("../../studio/src/cloud/window/app-window.tsx", import.meta.url),
  ).text();
  expect(source).toContain(`app-drag flex h-[${CHROME}px] `);
});

test("the larger lights of macOS 26 and later sit centred on the chrome", () => {
  expect(centre("26.0", 14)).toBe(CHROME / 2);
  expect(centre("27.0.1", 14)).toBe(CHROME / 2);
});

test("the smaller lights of an older macOS sit centred too", () => {
  expect(centre("15.6.1", 12)).toBe(CHROME / 2);
  expect(centre("14.0", 12)).toBe(CHROME / 2);
});

test("a version it cannot read is taken for a current one", () => {
  expect(trafficLights("")).toEqual({ x: 16, y: (CHROME - 14) / 2 });
});
