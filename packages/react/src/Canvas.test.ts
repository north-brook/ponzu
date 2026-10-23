import { expect, test } from "bun:test";
import type { Artboard } from "@ponzu/core";
import { boardsIn, labelCovers, outOfSight, size } from "./Canvas.tsx";

const board = (style: Record<string, string>) =>
  ({ id: "ab_1", name: "A", x: 0, y: 0, root: { style } }) as unknown as Artboard;

test("a px height is the artboard's height", () => {
  expect(size(board({ width: "1440px", height: "900px" }))).toEqual({ w: 1440, h: 900 });
});

test("a height that isn't a px length is measured instead", () => {
  expect(size(board({ width: "1440px", height: "fit-content" })).h).toBeNull();
  // Ends in px but isn't a number; parsing it gave NaN and froze the camera.
  expect(size(board({ width: "1440px", height: "fit-contentpx" })).h).toBeNull();
});

test("a board's title hides when it would sit on the board above", () => {
  // Kettle's Brand page: two rows of 1200×720 boards, 100px apart.
  const above = { id: "a", x: 1300, y: 0, w: 1200, h: 720 };
  const below = { id: "b", x: 1300, y: 820, w: 1200 };
  const boards = [above, { ...below, h: 720 }];
  // At 100% the 22px title fits in the 100px gap; at 6% it needs 367px and covers the row above.
  expect(labelCovers(below, boards, 1)).toBe(false);
  expect(labelCovers(below, boards, 0.06)).toBe(true);
  // A board beside, not above, is no obstacle; nor is a board with nothing over it.
  expect(labelCovers({ id: "c", x: 2600, y: 820, w: 1200 }, [above], 0.06)).toBe(false);
  expect(labelCovers({ id: "a", x: 1300, y: 0, w: 1200 }, boards, 0.06)).toBe(false);
});

test("a selection box takes every board it touches, drawn either way", () => {
  const boards = [
    { id: "a", x: 0, y: 0, w: 400, h: 300 },
    { id: "b", x: 500, y: 0, w: 400, h: 300 },
    { id: "c", x: 0, y: 400, w: 400, h: 300 },
  ];
  // Clipping a corner of a board is enough, as in Figma.
  expect(boardsIn({ x: -50, y: -50 }, { x: 550, y: 50 }, boards)).toEqual(["a", "b"]);
  expect(boardsIn({ x: 550, y: 50 }, { x: -50, y: -50 }, boards)).toEqual(["a", "b"]);
  // The gap between boards takes none.
  expect(boardsIn({ x: 420, y: 320 }, { x: 480, y: 380 }, boards)).toEqual([]);
});

test("a board's loops hold off screen and as a thumbnail, and play in view", () => {
  const view = { w: 1280, h: 800 };
  const phone = { x: 0, y: 0, w: 393, h: 852 };
  // At 100% on screen it plays; panned past any edge, it holds.
  expect(outOfSight(phone, { x: 100, y: 0, zoom: 1 }, view)).toBe(false);
  expect(outOfSight(phone, { x: -400, y: 0, zoom: 1 }, view)).toBe(true);
  expect(outOfSight(phone, { x: 1280, y: 0, zoom: 1 }, view)).toBe(true);
  expect(outOfSight(phone, { x: 0, y: -900, zoom: 1 }, view)).toBe(true);
  // Partly in view is in view.
  expect(outOfSight(phone, { x: -300, y: -700, zoom: 1 }, view)).toBe(false);
  // iphone.design's Connect page fit to the window: 36 phones about 96px tall. Thumbnails.
  expect(outOfSight(phone, { x: 0, y: 0, zoom: 0.11 }, view)).toBe(true);
  expect(outOfSight(phone, { x: 0, y: 0, zoom: 0.25 }, view)).toBe(false);
});
