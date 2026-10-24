import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SLICE as WEB_SLICE, SLICE_STROKE as WEB_STROKE } from "../../../packages/react/src/slice";
import { LAUNCH, LAUNCH_LIFT, SLICE, SLICE_STROKE } from "./mark";

test("the phone draws the same slice as the web", () => {
  expect(SLICE).toEqual(WEB_SLICE);
  expect(SLICE_STROKE).toBe(WEB_STROKE);
});

test("the native splash is the launch screen's yuzu alone, with no mark to jump from", () => {
  expect(LAUNCH_LIFT).toBe(36);
  const { expo } = JSON.parse(readFileSync(join(import.meta.dir, "../app.json"), "utf8"));
  const splash = expo.plugins.find(
    (p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen",
  );
  expect(splash[1].backgroundColor).toBe("#ffc81e");
  // A clear pixel: the plugin keeps the background only with an image.
  expect(splash[1].imageWidth).toBe(1);
  expect(LAUNCH.mark).toBe(112);
});
