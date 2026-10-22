import { expect, test } from "bun:test";
import type { Artboard } from "@ponzu/core";
import { labelCovers, size } from "./Canvas.tsx";

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
