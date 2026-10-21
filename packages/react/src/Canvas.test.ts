import { expect, test } from "bun:test";
import type { Artboard } from "@ponzu/core";
import { size } from "./Canvas.tsx";

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
