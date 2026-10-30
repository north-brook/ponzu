import { expect, test } from "bun:test";
import type { CatalogFile } from "@ponzu/core";
import { isUnseen, look } from "./seen";

const file = (id: string, modified: number) => ({ id, modified }) as CatalogFile;

test("designs seen for the first time count as seen", () => {
  const seen = look({}, [file("a", 1000), file("b", 2000)]);
  expect(seen).toEqual({ a: 1000, b: 2000 });
  expect(isUnseen(seen, file("a", 1000))).toBe(false);
});

test("a design changed since wears the dot; the one in front stays seen", () => {
  const seen = { a: 1000, b: 1000 };
  const files = [file("a", 5000), file("b", 5000)];
  const next = look(seen, files, "b");
  expect(next).toEqual({ a: 1000, b: 5000 });
  expect(isUnseen(next, files[0]!)).toBe(true);
  expect(isUnseen(next, files[1]!)).toBe(false);
});

test("nothing moved: the same object, and an edit within a second isn't a change", () => {
  const seen = { a: 1000 };
  expect(look(seen, [file("a", 1000)], "a")).toBe(seen);
  expect(isUnseen(seen, file("a", 1800))).toBe(false);
  expect(isUnseen(seen, file("z", 9000))).toBe(false);
});
