import { expect, test } from "bun:test";
import { BAND, centreDistance, detailScale, onScreen, visibleBand } from "./lod.ts";

const vp = { w: 1600, h: 1000 };

test("a board in the viewport or its margin is on screen", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  expect(onScreen({ x: 100, y: 100, w: 200, h: 200 }, cam, vp)).toBe(true);
  // Half a viewport past the right edge still renders, so a pan doesn't show it blank.
  expect(onScreen({ x: 2300, y: 0, w: 200, h: 200 }, cam, vp)).toBe(true);
  expect(onScreen({ x: 2500, y: 0, w: 200, h: 200 }, cam, vp)).toBe(false);
  expect(onScreen({ x: 0, y: -1800, w: 200, h: 200 }, cam, vp)).toBe(false);
});

test("on screen follows the camera", () => {
  const r = { x: 5000, y: 0, w: 1440, h: 900 };
  expect(onScreen(r, { x: 0, y: 0, zoom: 1 }, vp)).toBe(false);
  expect(onScreen(r, { x: 0, y: 0, zoom: 0.2 }, vp)).toBe(true);
  expect(onScreen(r, { x: -4800, y: 0, zoom: 1 }, vp)).toBe(true);
});

test("detail scale steps in quarter octaves", () => {
  expect(detailScale(0.5, 2)).toBe(1);
  expect(detailScale(0.51, 2)).toBe(1);
  expect(detailScale(0.2, 2)).toBeCloseTo(0.42, 2);
  // A tiny change in zoom doesn't change the step.
  expect(detailScale(0.2, 2)).toBe(detailScale(0.205, 2));
});

test("only a tall board gets a visible band, snapped to whole bands", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  expect(visibleBand({ x: 0, y: 0, w: 1440, h: 900 }, cam, vp)).toBeUndefined();
  const band = visibleBand({ x: 0, y: 0, w: 1440, h: 20000 }, { x: 0, y: -5000, zoom: 1 }, vp);
  expect(band).toBeDefined();
  expect(band!.y0 % BAND).toBe(0);
  expect(band!.y1 % BAND).toBe(0);
  // Covers the viewport (5000–6000) and half a viewport either side.
  expect(band!.y0).toBeLessThanOrEqual(4500);
  expect(band!.y1).toBeGreaterThanOrEqual(6500);
  expect(band!.y1 - band!.y0).toBeLessThan(3000);
});

test("distance from the middle of the view is in screen px, zero over it", () => {
  const cam = { x: 0, y: 0, zoom: 0.5 };
  // The view's centre is at world (1600, 1000).
  expect(centreDistance({ x: 1000, y: 500, w: 1440, h: 900 }, cam, vp)).toBe(0);
  expect(centreDistance({ x: 2000, y: 500, w: 1440, h: 900 }, cam, vp)).toBe(200);
  expect(centreDistance({ x: 0, y: 1400, w: 1000, h: 900 }, cam, vp)).toBe(Math.hypot(300, 200));
});
