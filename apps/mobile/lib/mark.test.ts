import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SLICE as WEB_SLICE, SLICE_STROKE as WEB_STROKE } from "../../../packages/react/src/slice";
import { LAUNCH, LAUNCH_LIFT, SLICE, SLICE_STROKE } from "./mark";

test("the phone draws the same slice as the web", () => {
  expect(SLICE).toEqual(WEB_SLICE);
  expect(SLICE_STROKE).toBe(WEB_STROKE);
});

test("the splash image leaves room for the slice to sit where the launch screen draws it", () => {
  expect(LAUNCH_LIFT).toBe(36);
  const script = readFileSync(join(import.meta.dir, "../scripts/make-images.swift"), "utf8");
  expect(script).toContain(`let lift = ${LAUNCH_LIFT}.0`);
  expect(script).toContain(`let mark = ${LAUNCH.mark}.0`);
  const { expo } = JSON.parse(readFileSync(join(import.meta.dir, "../app.json"), "utf8"));
  const splash = expo.plugins.find(
    (p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen",
  );
  expect(splash[1].imageWidth).toBe(LAUNCH.mark);
});
