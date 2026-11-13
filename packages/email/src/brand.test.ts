import { expect, test } from "bun:test";
import { ENTITY } from "../../../apps/web/components/site.ts";
import { COMPANY, DISPLAY_FONT_URL, SITE_URL, TILE_URL } from "./brand.ts";
import { DARK, LIGHT } from "./tokens.ts";

test("COMPANY is the site's ENTITY, so the footer and the site never disagree", () => {
  expect({ name: COMPANY.name, address: COMPANY.address } as Record<string, string | null>).toEqual(
    { name: ENTITY.name, address: ENTITY.address },
  );
});

test("the pictures come from the site, over https", () => {
  expect(SITE_URL).toBe("https://ponzu.design");
  expect(TILE_URL).toBe("https://ponzu.design/email/tile-96.png");
  expect(DISPLAY_FONT_URL).toBe("https://ponzu.design/email/funnel-display-600.woff2");
});

/** WCAG's contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("every pairing of text and ground reads at 4.5:1 or more, light and dark", () => {
  for (const palette of [LIGHT, DARK]) {
    expect(contrast(palette.ink, palette.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.muted, palette.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.actionInk, palette.action)).toBeGreaterThanOrEqual(4.5);
  }
});
