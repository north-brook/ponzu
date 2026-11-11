import { expect, test } from "bun:test";
import type { Artboard } from "@ponzu/core";
import { cornersCss, designCorners, ringCorners } from "./corners.ts";

const board = (style: Record<string, string>) =>
  ({ root: { style: { width: "320px", height: "200px", ...style } } }) as unknown as Artboard;

test("a design's root radius is read per corner, as the shorthand and longhands give it", () => {
  expect(designCorners(board({}))).toEqual([0, 0, 0, 0]);
  expect(designCorners(board({ "border-radius": "16px" }))).toEqual([16, 16, 16, 16]);
  expect(designCorners(board({ "border-radius": "16px 0" }))).toEqual([16, 0, 16, 0]);
  expect(designCorners(board({ "border-radius": "1px 2px 3px" }))).toEqual([1, 2, 3, 2]);
  expect(
    designCorners(board({ "border-radius": "24px", "border-bottom-left-radius": "0" })),
  ).toEqual([24, 24, 24, 0]);
});

test("a radius the canvas can't read as px is left to the design", () => {
  expect(designCorners(board({ "border-radius": "var(--radius)" }))).toBeNull();
  expect(designCorners(board({ "border-radius": "50%" }))).toBeNull();
  expect(designCorners(board({ "border-radius": "16px / 8px" }))).toBeNull();
});

test("each corner is the design's or the canvas's few px, whichever is larger", () => {
  expect(cornersCss([16, 16, 16, 16], "var(--r)")).toBe("max(16px, var(--r))");
  expect(cornersCss([0, 0, 0, 0], "var(--r)")).toBe("var(--r)");
  expect(cornersCss([16, 0, 16, 0], "3px")).toBe("max(16px, 3px) 3px max(16px, 3px) 3px");
});

test("the working ring keeps its gap round the board's corners at any zoom", () => {
  expect(ringCorners(null, 4, 4)).toBe("8px");
  expect(ringCorners([16, 16, 16, 16], 4, 4)).toBe("max(calc(var(--z) * 16px + 4px), 8px)");
});
