import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brand, dark, light } from "./tokens";

const css = readFileSync(join(import.meta.dir, "../global.css"), "utf8");
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const normal = (value: string) => value.replace(/\s+/g, "");

/** `--name: value` pairs in a block of CSS. */
function variables(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out[name!] = normal(value!);
  }
  return out;
}

const root = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(
  css.indexOf("@media (prefers-color-scheme: dark)"),
  css.indexOf("@theme"),
);
const theme = css.slice(css.indexOf("@theme"));

test("global.css carries the same light and dark surfaces as tokens.ts", () => {
  const lightCss = variables(root);
  const darkCss = variables(darkBlock);
  for (const [name, value] of Object.entries(light)) {
    expect(lightCss[`--c-${kebab(name)}`]).toBe(normal(value));
  }
  for (const [name, value] of Object.entries(dark)) {
    expect(darkCss[`--c-${kebab(name)}`]).toBe(normal(value));
  }
});

test("every surface has a class name, and the brand colors match", () => {
  const classes = variables(theme);
  for (const name of Object.keys(light)) {
    expect(classes[`--color-c-${kebab(name)}`]).toBe(`var(--c-${kebab(name)})`);
  }
  for (const [name, value] of Object.entries(brand)) {
    expect(classes[`--color-${name}`]).toBe(value);
  }
});
