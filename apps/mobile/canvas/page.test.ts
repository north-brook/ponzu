import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("the page turns off iOS text autosizing", async () => {
  // Small text in a block wider than the screen (every board) is enlarged by iOS unless pinned:
  // an 11px code block drew at 19px and ran out of its box.
  const css = await readFile(join(import.meta.dir, "canvas.css"), "utf8");
  const html = css.match(/(?:^|\n)html\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(html).toContain("-webkit-text-size-adjust: 100%");
  expect(html).toContain("text-size-adjust: 100%");
});
