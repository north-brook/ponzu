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

test("a comment's picture takes the Mac's ground, board edge and pin colours", async () => {
  // canvas.css copies them from packages/canvas's styles.css for the picture's scene alone, so
  // the phone's pictures match the Mac's. A change there must be made here too.
  const phone = await readFile(join(import.meta.dir, "canvas.css"), "utf8");
  const mac = await readFile(
    join(import.meta.dir, "../../../packages/canvas/src/styles.css"),
    "utf8",
  );
  const block = (css: string, selector: string) => {
    const at = css.search(new RegExp(`(?:^|\\n)${selector.replaceAll(".", "\\.")}\\s*\\{`));
    expect(at).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    return new Map(
      [...body.matchAll(/(--pz-[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
    );
  };
  for (const selector of [".pz-root", ".pz-root.pz-dark"]) {
    const copied = block(phone, selector);
    const theirs = block(mac, selector);
    expect(copied.size).toBeGreaterThan(0);
    for (const [name, value] of copied) expect([name, theirs.get(name)]).toEqual([name, value]);
  }
});
