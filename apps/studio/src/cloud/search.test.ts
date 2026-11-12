import { expect, test } from "bun:test";
import type { SearchResults } from "./model.ts";
import { moveSelection, resultKeys, segments } from "./search.ts";

test("a result's text splits at its matches", () => {
  expect(segments("Quieter shop hero", [[13, 17]])).toEqual([
    { text: "Quieter shop ", match: false },
    { text: "hero", match: true },
  ]);
  expect(segments("Hero, dark", [[0, 4]])).toEqual([
    { text: "Hero", match: true },
    { text: ", dark", match: false },
  ]);
});

test("matches out of order, overlapping or past the end are tolerated", () => {
  expect(
    segments("abcdef", [
      [4, 9],
      [0, 2],
      [1, 3],
    ]),
  ).toEqual([
    { text: "ab", match: true },
    { text: "c", match: true },
    { text: "d", match: false },
    { text: "ef", match: true },
  ]);
  expect(segments("abc", [])).toEqual([{ text: "abc", match: false }]);
});

test("the keyboard goes through canvases, then boards, then comments, stopping at the ends", () => {
  const results = {
    query: "x",
    canvases: [{ canvas: { id: "d1" } }, { canvas: { id: "d2" } }],
    boards: [{ id: "b1" }],
    comments: [{ id: "c1" }],
  } as unknown as SearchResults;
  expect(resultKeys(results)).toEqual(["canvas:d1", "canvas:d2", "board:b1", "comment:c1"]);
  expect(moveSelection(4, 0, "ArrowDown")).toBe(1);
  expect(moveSelection(4, 3, "ArrowDown")).toBe(3);
  expect(moveSelection(4, 0, "ArrowUp")).toBe(0);
  expect(moveSelection(4, -1, "ArrowDown")).toBe(0);
  expect(moveSelection(4, 2, "Home")).toBeNull();
  expect(moveSelection(0, 0, "ArrowDown")).toBeNull();
});
