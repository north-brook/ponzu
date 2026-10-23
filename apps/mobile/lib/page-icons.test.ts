import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Icons } from "../../../packages/react/src/icon-names.ts";
import { FALLBACK, pageIcon, pageIconImage, pageIconName } from "./page-icons";

const catalog = new Set(
  readdirSync(join(import.meta.dir, "../assets/native"))
    .filter((f) => f.startsWith("hi-") && !f.includes("@"))
    .map((f) => f.slice(0, -4)),
);

test("every page icon the menu names has its image, and draws the same glyph in the header", () => {
  for (const name of Object.keys(Icons)) {
    expect(pageIconImage(name)).toBe(`hi-${name}`);
    expect(catalog.has(pageIconImage(name))).toBe(true);
    expect(pageIcon(name)).toBe(Icons[name as keyof typeof Icons]);
  }
});

test("an unknown or missing icon is the board, in the menu and the header alike", () => {
  for (const name of [undefined, "", "nope", "toString", "__proto__"]) {
    expect(pageIconName(name)).toBe(FALLBACK);
    expect(pageIconImage(name)).toBe("hi-board");
    expect(pageIcon(name)).toBe(Icons.board);
  }
});
