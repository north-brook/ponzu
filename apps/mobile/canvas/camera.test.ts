import { expect, test } from "bun:test";
import {
  between,
  type Camera,
  clampToBox,
  easeOut,
  focusCamera,
  glide,
  labelCovers,
  overview,
  pinPoint,
  READABLE,
  reveal,
  type Screen,
  screenSized,
  threadPoint,
  toScreen,
  toWorld,
  zoomAt,
} from "./camera.ts";
import { velocity } from "./gestures.ts";

/** An iPhone 17 Pro, with the canvas's top bar and the home indicator over it. */
const phone: Screen = { w: 402, h: 874, insets: { top: 110, right: 0, bottom: 34, left: 0 } };
/** Kettle's App page: eight 390×844 screens in a row, 80px apart. */
const row = Array.from({ length: 8 }, (_, i) => ({
  id: `ab${i}`,
  x: i * 470,
  y: 0,
  w: 390,
  h: 844,
}));

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

test("screen and world points round-trip through the camera", () => {
  const c: Camera = { x: 30, y: -120, zoom: 0.4 };
  const w = toWorld(c, 200, 300);
  const s = toScreen(c, w.x, w.y);
  close(s.x, 200);
  close(s.y, 300);
});

test("zooming keeps the point under the fingers where it is", () => {
  const c: Camera = { x: 16, y: 200, zoom: 0.38 };
  const before = toWorld(c, 120, 400);
  const z = zoomAt(c, 0.9, 120, 400);
  const after = toScreen(z, before.x, before.y);
  close(after.x, 120);
  close(after.y, 400);
  expect(zoomAt(c, 100, 0, 0).zoom).toBe(8);
});

test("a row of phone screens opens readable, from its first board", () => {
  const c = overview(row, phone)!;
  // 150 of 390 in the design: about 155px on a 402px screen.
  close(row[0]!.w * c.zoom, 402 * READABLE, 3);
  // The first board starts 16px in from the left.
  close(toScreen(c, 0, 0).x, 16);
  // Centred in what the chrome leaves, under its label.
  const top = toScreen(c, 0, 0).y;
  const bottom = toScreen(c, 0, 844).y;
  close((top - 20 + bottom) / 2, (110 + 16 + (874 - 34 - 16)) / 2 + 0, 3);
});

test("a page that fits readably opens whole", () => {
  const two = row.slice(0, 1);
  const c = overview(two, phone)!;
  // One phone screen fits at the height the chrome leaves.
  const area = 874 - 110 - 34 - 32 - 20;
  close(c.zoom, area / 844);
  close(toScreen(c, 195, 0).x, 201);
});

test("double-tap focuses a phone screen edge to edge", () => {
  const board = row[5]!;
  expect(screenSized(board, phone)).toBe(true);
  const c = focusCamera(board, phone);
  // Fit to the width: 390 → 402.
  close(c.zoom, 402 / 390);
  close(toScreen(c, board.x, 0).x, 0);
  close(toScreen(c, board.x + board.w, 0).x, 402);
  // The 2px the aspect leaves split above and below.
  const top = toScreen(c, 0, board.y).y;
  close(top, (874 - 844 * (402 / 390)) / 2);
});

test("a tall board focuses across the width, from its top under the chrome", () => {
  const landing = { x: 1540, y: 0, w: 390, h: 3840 };
  expect(screenSized(landing, phone)).toBe(false);
  const c = focusCamera(landing, phone);
  close(c.zoom, 402 / 390);
  close(toScreen(c, landing.x, landing.y).y, 110);
});

test("a wide board focuses across the width, centred", () => {
  const desktop = { x: 0, y: 0, w: 1200, h: 720 };
  const c = focusCamera(desktop, phone);
  close(c.zoom, 402 / 1200);
  const mid = (toScreen(c, 0, 0).y + toScreen(c, 0, 720).y) / 2;
  close(mid, 437);
});

test("a focused board pans to its edges and no further", () => {
  const landing = { x: 0, y: 0, w: 390, h: 3840 };
  const c = focusCamera(landing, phone);
  // Pulled down past its top: back under the chrome.
  expect(clampToBox({ ...c, y: c.y + 500 }, landing, phone).y).toBeCloseTo(110);
  // Pushed up past its bottom: its end sits above the home indicator.
  const end = clampToBox({ ...c, y: -1e6 }, landing, phone);
  close(toScreen(end, 0, 3840).y, 874 - 34);
  // Across, it's exactly the screen's width: it stays put.
  close(clampToBox({ ...c, x: c.x + 80 }, landing, phone).x, c.x);
});

test("pins sit at their thread's spot, in artboard or page px", () => {
  const c: Camera = { x: 16, y: 200, zoom: 0.5 };
  const board = { x: 470, y: 0 };
  expect(pinPoint({ x: 100, y: 40 }, board, null, c)).toEqual({ x: 16 + 285, y: 220 });
  // On the open canvas, x and y are on the page.
  expect(pinPoint({ x: 100, y: 40 }, undefined, null, c)).toEqual({ x: 66, y: 220 });
  // A pin on a node that moved stays within the node's box.
  const node = { x: 200, y: 300, w: 50, h: 20 };
  expect(pinPoint({ x: 100, y: 40 }, board, node, c)).toEqual({ x: 16 + 335, y: 350 });
});

test("a long-press becomes a thread's coordinates, as a pin would show it", () => {
  const c: Camera = { x: 16, y: 200, zoom: 0.38 };
  const board = { x: 940, y: 0 };
  const at = toScreen(c, 940 + 118, 150);
  const p = threadPoint(c, at.x, at.y, board);
  expect(p).toEqual({ x: 118, y: 150 });
  const back = pinPoint(p, board, null, c);
  close(back.x, at.x);
  close(back.y, at.y);
  expect(threadPoint(c, at.x, at.y)).toEqual({ x: 1058, y: 150 });
});

test("reveal pans a point into what the chrome leaves", () => {
  const c: Camera = { x: 0, y: 0, zoom: 1 };
  const sheet: Screen = { ...phone, insets: { ...phone.insets, bottom: 400 } };
  const moved = reveal(c, { x: 200, y: 700 }, sheet);
  close(toScreen(moved, 200, 700).y, 874 - 400 - 48);
  expect(reveal(c, { x: 200, y: 300 }, sheet)).toBe(c);
});

test("a camera move starts and ends where it should and keeps zoom in ratio", () => {
  const a: Camera = { x: 16, y: 200, zoom: 0.38 };
  const b = focusCamera(row[2]!, phone);
  expect(between(a, b, 0, phone)).toEqual(a);
  expect(between(a, b, 1, phone)).toEqual(b);
  close(between(a, b, 0.5, phone).zoom, Math.sqrt(a.zoom * b.zoom));
  close(easeOut(0), 0);
  close(easeOut(1), 1);
  expect(easeOut(0.5)).toBeGreaterThan(0.8);
});

test("a flick glides and slows; a finger that rested doesn't", () => {
  const samples = [
    { t: 0, x: 0, y: 0 },
    { t: 16, x: 16, y: 0 },
    { t: 32, x: 32, y: 0 },
  ];
  const v = velocity(samples, 40);
  close(v.x, 1);
  expect(velocity(samples, 200)).toEqual({ x: 0, y: 0 });
  const g = glide(v, 16);
  expect(g.dx).toBeGreaterThan(15);
  expect(g.dx).toBeLessThan(16);
  expect(g.v.x).toBeLessThan(1);
});

test("labels hide when they'd lie over the board above", () => {
  const above = { id: "a", x: 0, y: 0, w: 390, h: 844 };
  const below = { id: "b", x: 0, y: 870, w: 390, h: 844 };
  expect(labelCovers(below, [above, below], 1)).toBe(false);
  expect(labelCovers(below, [above, below], 0.5)).toBe(true);
});

test("a fit-content board frames by its measured height, not the stand-in", () => {
  // Canvas.tsx frames a page before its fit-content boards are measured, with a 900px
  // stand-in, then again once they are: the two framings differ, so the refit matters.
  const standIn = overview([{ id: "page", x: 0, y: 0, w: 1440, h: 900 }], phone);
  const measured = overview([{ id: "page", x: 0, y: 0, w: 1440, h: 5200 }], phone);
  expect(standIn).not.toBeNull();
  expect(measured).not.toBeNull();
  expect(measured!.zoom).toBeLessThan(standIn!.zoom);
  // The whole of the long page fits on screen once it's measured.
  const bottom = toScreen(measured!, 0, 5200);
  expect(bottom.y).toBeLessThanOrEqual(phone.h - phone.insets.bottom + 0.5);
});
