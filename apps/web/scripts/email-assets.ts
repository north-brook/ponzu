#!/usr/bin/env bun
/**
 * The files Ponzu's emails load from this site (apps/web/public/email), made from the apps' own
 * sources so they never drift:
 *
 * - tile-96.png: the yuzu tile, 96 pixels square, which an email shows at 32. The slice's six
 *   segments (@ponzu/canvas/slice, the drawing every app uses) in ink on a yuzu rounded square,
 *   rendered by resvg, as apps/mobile/scripts/tab-icons.ts renders the phone's icons. A
 *   self-contained tile reads the same on white, in a mail app's dark theme and under Gmail's or
 *   Outlook's inversion, so it has no dark twin. Clients cache images, so if the art ever
 *   changes, the file gets a new name.
 * - funnel-display-600.woff2: the Latin subset of Funnel Display that the apps embed, byte for
 *   byte, for the mail apps that load a web font (Apple Mail and iOS Mail). It is under the SIL
 *   Open Font License, whose text goes beside it.
 *
 *   bun apps/web/scripts/email-assets.ts           write them
 *   bun apps/web/scripts/email-assets.ts --check   exit 1 if what is committed is not what this draws
 *
 * email-assets.test.ts runs the check.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLICE, SLICE_STROKE } from "@ponzu/canvas/slice";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(import.meta.dir, "..", "..", "..");
export const EMAIL_DIR = join(ROOT, "apps", "web", "public", "email");
const FONTS = join(ROOT, "apps", "studio", "src", "cloud", "styles", "fonts");

/** The published names, which the emails link to as https://ponzu.design/email/<name>. */
export const TILE = "tile-96.png";
export const FONT = "funnel-display-600.woff2";
export const FONT_LICENSE = "OFL-FunnelDisplay.txt";
export const FONT_SOURCE = join(FONTS, "funnel-display-latin.woff2");
const FONT_LICENSE_SOURCE = join(FONTS, FONT_LICENSE);

/** The tile's size in pixels. */
export const TILE_SIZE = 96;
/** The slice's 64-unit grid, 60 pixels across, in the middle of the tile. */
const SCALE = 60 / 64;
const OFFSET = (TILE_SIZE - 64 * SCALE) / 2;
const YUZU = "#ffc81e";
const INK = "#111110";

/** The tile as SVG: a yuzu square with 22% rounded corners, and the slice on it in ink. */
export function tileSvg(): string {
  const segments = SLICE.map((d) => `<path d="${d}"/>`).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">`,
    `<rect width="${TILE_SIZE}" height="${TILE_SIZE}" rx="${TILE_SIZE * 0.22}" fill="${YUZU}"/>`,
    `<g transform="translate(${OFFSET} ${OFFSET}) scale(${SCALE})" fill="${INK}" stroke="${INK}" stroke-width="${SLICE_STROKE}" stroke-linejoin="round">`,
    segments,
    "</g></svg>",
  ].join("");
}

/** The tile, rendered: its PNG file and its RGBA pixels, row by row. */
export function renderTile(): { png: Buffer; pixels: Uint8Array } {
  const image = new Resvg(tileSvg(), { fitTo: { mode: "original" } }).render();
  return { png: image.asPng(), pixels: new Uint8Array(image.pixels) };
}

/** What differs between the committed files and what this script makes; empty when none. */
export function problems(dir = EMAIL_DIR): string[] {
  const found: string[] = [];
  const tile = join(dir, TILE);
  if (!existsSync(tile)) found.push(`${TILE} is missing`);
  else if (!readFileSync(tile).equals(renderTile().png)) {
    found.push(`${TILE} is not what the script draws`);
  }
  for (const [name, source] of [
    [FONT, FONT_SOURCE],
    [FONT_LICENSE, FONT_LICENSE_SOURCE],
  ] as const) {
    const file = join(dir, name);
    if (!existsSync(file)) found.push(`${name} is missing`);
    else if (!readFileSync(file).equals(readFileSync(source))) {
      found.push(`${name} is not the apps' copy`);
    }
  }
  return found;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const found = problems();
    for (const problem of found) console.error(problem);
    process.exit(found.length ? 1 : 0);
  }
  mkdirSync(EMAIL_DIR, { recursive: true });
  writeFileSync(join(EMAIL_DIR, TILE), renderTile().png);
  writeFileSync(join(EMAIL_DIR, FONT), readFileSync(FONT_SOURCE));
  writeFileSync(join(EMAIL_DIR, FONT_LICENSE), readFileSync(FONT_LICENSE_SOURCE));
  console.log(`wrote ${TILE}, ${FONT} and ${FONT_LICENSE} in apps/web/public/email`);
}
