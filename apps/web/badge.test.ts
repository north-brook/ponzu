import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SLICE } from "@ponzu/canvas/slice";
import config from "./next.config.ts";

/*
 * ponzu.design/badge.svg is embedded in other projects' READMEs, so it stays. It was a route that
 * drew a label from `?label=`; it is now one static file (public/badge.svg), drawn once by that
 * route's code with its default label, so no 1.x route code remains. A README that asked for
 * another label gets this one.
 */

const svg = readFileSync(join(import.meta.dir, "public/badge.svg"), "utf8");

test("the badge is the shield it was: 20px tall, the ink label and the yuzu Ponzu half", () => {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="114" height="20"')).toBe(
    true,
  );
  expect(svg).toContain('aria-label="open in | Ponzu"');
  expect(svg).toContain("<title>open in | Ponzu</title>");
  expect(svg).toContain('fill="#1c1c1c"');
  expect(svg).toContain('fill="#ffc81e"');
  for (const d of SLICE) expect(svg).toContain(`<path d="${d}"/>`);
});

test("the badge carries no script, link or outside reference", () => {
  expect(svg).not.toMatch(/<script|<a\b|href=|<foreignObject|url\((?!#)/i);
});

test("no route serves /badge.svg in the file's place, and caches keep it a day", async () => {
  expect(existsSync(join(import.meta.dir, "app/badge.svg"))).toBe(false);
  const headers = await config.headers!();
  const rule = headers.find((h) => /:ext\(([^)]*\bsvg\b[^)]*)\)/.test(h.source));
  expect(rule?.headers).toContainEqual({ key: "cache-control", value: "public, max-age=86400" });
});
