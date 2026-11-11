import { expect, test } from "bun:test";
import type { Artboard } from "@ponzu/core";
import { circular, cornersCss, designCorners, largest, lengths, ringCorners } from "./corners.ts";

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

test("a radius the document can't give as px waits for the live board to measure it", () => {
  expect(designCorners(board({ "border-radius": "var(--radius)" }))).toBeNull();
  expect(designCorners(board({ "border-radius": "50%" }))).toBeNull();
  expect(designCorners(board({ "border-radius": "16px / 8px" }))).toBeNull();
});

test("a computed radius splits into its lengths at top-level spaces only", () => {
  expect(lengths("24px")).toEqual(["24px"]);
  expect(lengths("10% 20%")).toEqual(["10%", "20%"]);
  expect(lengths("calc(10% + 2px) 4px")).toEqual(["calc(10% + 2px)", "4px"]);
  expect(lengths("")).toEqual([]);
});

test("each corner is the design's or the canvas's few px, whichever is larger", () => {
  expect(cornersCss(circular([16, 16, 16, 16]), "var(--r)")).toBe("max(16px, var(--r))");
  expect(cornersCss(circular([0, 0, 0, 0]), "var(--r)")).toBe("var(--r)");
  expect(cornersCss(circular([16, 0, 16, 0]), "3px")).toBe("max(16px, 3px) 3px max(16px, 3px) 3px");
});

test("an elliptical corner keeps both its radii", () => {
  const r = { x: [32, 32, 32, 32], y: [20, 20, 20, 20] } as const;
  expect(cornersCss(r, "4px")).toBe("max(32px, 4px) / max(20px, 4px)");
  expect(ringCorners(r, 4, 4)).toBe(
    "max(calc(var(--z) * 32px + 4px), 8px) / max(calc(var(--z) * 20px + 4px), 8px)",
  );
  expect(largest(r)).toBe(32);
  expect(largest(null)).toBe(0);
});

test("the working ring keeps its gap round the board's corners at any zoom", () => {
  expect(ringCorners(null, 4, 4)).toBe("8px");
  expect(ringCorners(circular([16, 16, 16, 16]), 4, 4)).toBe(
    "max(calc(var(--z) * 16px + 4px), 8px)",
  );
});
