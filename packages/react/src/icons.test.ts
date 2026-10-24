import { expect, test } from "bun:test";
import { PAGE_ICONS } from "@ponzu/core";
import { Icons } from "./icons.tsx";

test("every icon an agent can choose for a file or page is drawn, each its own", () => {
  expect(PAGE_ICONS.filter((name) => !(name in Icons))).toEqual([]);
  const glyphs = PAGE_ICONS.map((name) => Icons[name as keyof typeof Icons]);
  expect(new Set(glyphs).size).toBe(PAGE_ICONS.length);
});
