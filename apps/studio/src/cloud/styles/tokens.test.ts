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
  if (!value.startsWith("light-dark(")) return [value, value];
  // Split at the comma between the two values, not one inside an rgba().
  const inner = value.slice("light-dark(".length, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    if (inner[i] === ")") depth--;
    if (inner[i] === "," && depth === 0)
      return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  throw new Error(`--c-${name} is not a pair`);
}

/** A #rrggbb, or an rgba() laid over `ground` (a #rrggbb), as channels from 0 to 1. */
function channels(color: string, ground?: string): number[] {
  const rgba = color.match(/^rgba\(([^)]+)\)$/);
  if (!rgba) return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255);
  const [r, g, b, a] = rgba[1]!.split(",").map(Number);
  const under = channels(ground!);
  return [r!, g!, b!].map((c, i) => (c / 255) * a! + under[i]! * (1 - a!));
}

function luminance(color: string): number {
  const [r, g, b] = channels(color);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const GROUNDS = ["chrome", "canvas", "surface", "selected"];

/** The glassy shell as measured (see the test): over the worst, a usual and the best backdrop. */
const GLASS = {
  light: {
    tint: "rgba(242, 241, 238, 0.6)",
    worst: "#e6e4e3",
    usual: "#eeedeb",
    best: "#f7f6f4",
  },
  dark: {
    tint: "rgba(22, 22, 21, 0.78)",
    worst: "#3b3d3d",
    usual: "#272727",
    best: "#161616",
  },
};
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
    expect(worst("icon-soft", i)).toBeGreaterThanOrEqual(3);
    const ring = token("focus")[0].match(/#[0-9a-f]{6}/gi)!;
    expect(contrast(i === 0 ? ring[0]! : ring[1]!, token("chrome")[i])).toBeGreaterThanOrEqual(3);
  });

  // The shell over the Mac's material, as measured on a real desktop (macOS 27.2, 11 Nov 2026:
  // the material from apps/desktop/src/shell-ground.ts with this tint over it, against a black,
  // a grey and a white backdrop). The worst for text is the backdrop furthest from the tint:
  // black in light, white in dark. These hold for exactly these tints and materials: change
  // either and the shell is measured again before these numbers are.
  test(`text holds AA on the glass in ${theme}`, () => {
    const measured = GLASS[theme];
    expect(token("chrome-glass")[i]).toBe(measured.tint);
    expect(contrast(token("ink")[i], measured.worst)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("muted")[i], measured.worst)).toBeGreaterThanOrEqual(4.5);
    // And it is the canvas's shade, a clear step off it whatever is behind the window (the
    // nearest backdrop included: white behind a light window, black behind a dark one), and
    // never a mid grey.
    for (const shell of [measured.worst, measured.usual, measured.best]) {
      const off = contrast(shell, token("canvas")[i]);
      expect(off).toBeGreaterThan(1.07);
      expect(off).toBeLessThan(2);
    }
  });

  test(`faint stays where the design puts it in ${theme}`, () => {
    // Dark's lowest is on the open row's ground, which the design doesn't draw.
    expect(worst("faint", i)).toBeGreaterThanOrEqual(i === 0 ? 1.8 : 2.75);
  });
}

// Light's open row is the design's canvas; dark's is derived, and must outrank a hovered row.
test("in dark the open row reads above a hovered one", () => {
  const chrome = token("chrome")[1];
  const lift = (c: string) => contrast(c, chrome);
  const hover = channels(token("hover")[1], chrome);
  const hex = `#${hover
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  expect(lift(token("selected")[1])).toBeGreaterThan(lift(hex) * 1.1);
});
