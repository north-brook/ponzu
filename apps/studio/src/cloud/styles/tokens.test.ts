/*
 * Contrast of the tokens, read from tokens.css, in both themes. Text that carries meaning holds
 * WCAG AA (4.5:1) on every ground it sits on; icons, the focus ring and control edges hold 3:1.
 * `faint` (metadata, placeholders, section labels) is the design's deliberate exception and is
 * pinned at what it is, so it can't drift lower unnoticed.
 */
import { expect, test } from "bun:test";

const css = await Bun.file(new URL("./tokens.css", import.meta.url)).text();

function token(name: string): [string, string] {
  const value = css.match(new RegExp(`--c-${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) throw new Error(`No --c-${name}`);
  const pair = value.match(/^light-dark\(([^,]+),\s*([^)]+)\)$/);
  return pair ? [pair[1]!.trim(), pair[2]!.trim()] : [value, value];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const GROUNDS = ["chrome", "canvas", "surface"];
const worst = (fg: string, theme: 0 | 1) =>
  Math.min(...GROUNDS.map((g) => contrast(token(fg)[theme], token(g)[theme])));

for (const [theme, i] of [
  ["light", 0],
  ["dark", 1],
] as const) {
  test(`text holds AA in ${theme}`, () => {
    expect(worst("ink", i)).toBeGreaterThanOrEqual(4.5);
    expect(worst("muted", i)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("action-ink")[i], token("action")[i])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("yuzu-ink")[i], token("yuzu")[i])).toBeGreaterThanOrEqual(4.5);
  });

  test(`icons and the focus ring hold 3:1 in ${theme}`, () => {
    expect(worst("icon-strong", i)).toBeGreaterThanOrEqual(3);
    expect(worst("icon-soft", i)).toBeGreaterThanOrEqual(3);
    const ring = token("focus")[0].match(/#[0-9a-f]{6}/gi)!;
    expect(contrast(i === 0 ? ring[0]! : ring[1]!, token("chrome")[i])).toBeGreaterThanOrEqual(3);
  });

  test(`faint stays where the design puts it in ${theme}`, () => {
    expect(worst("faint", i)).toBeGreaterThanOrEqual(i === 0 ? 1.8 : 2.9);
  });
}
