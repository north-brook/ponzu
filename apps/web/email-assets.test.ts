import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "./next.config.ts";
import {
  EMAIL_DIR,
  FONT,
  FONT_LICENSE,
  FONT_SOURCE,
  problems,
  renderTile,
  TILE,
  TILE_SIZE,
} from "./scripts/email-assets.ts";

/*
 * The files Ponzu's emails load from https://ponzu.design/email/ (scripts/email-assets.ts). An
 * email names them by these addresses for good, and a mail app caches them, so they must be
 * here, at the size the email draws them, and exactly what the script makes from the apps' own
 * slice and font.
 */

test("the committed email assets are what the script makes", () => {
  expect(problems()).toEqual([]);
});

test("the tile is 96 pixels square, yuzu with the slice in ink, and transparent at its corners", () => {
  const file = readFileSync(join(EMAIL_DIR, TILE));
  // The PNG header's width and height.
  expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([TILE_SIZE, TILE_SIZE]);
  // The committed file is the render (the first test), so its pixels are the render's.
  const { pixels } = renderTile();
  const width = TILE_SIZE;
  const at = (x: number, y: number) => [
    ...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ];
  // Rounded corners let the email's ground through.
  expect(at(0, 0)).toEqual([0, 0, 0, 0]);
  expect(at(95, 95)).toEqual([0, 0, 0, 0]);
  // The tile's yuzu, at an edge's middle and in the gap at the slice's centre.
  expect(at(48, 2)).toEqual([0xff, 0xc8, 0x1e, 255]);
  expect(at(48, 48)).toEqual([0xff, 0xc8, 0x1e, 255]);
  // Ink inside a segment (the left one, around (16, 32) on the slice's grid).
  expect(at(36, 48)).toEqual([0x11, 0x11, 0x10, 255]);
  // Small, as an image every email loads should be.
  expect(statSync(join(EMAIL_DIR, TILE)).size).toBeLessThan(4096);
});

test("the render has no clock or randomness in it", () => {
  expect(renderTile().png.equals(renderTile().png)).toBe(true);
});

test("the font is the display face the apps embed, with its license beside it", () => {
  const font = readFileSync(join(EMAIL_DIR, FONT));
  // The studio's file, which packages/core's display-face.test.ts holds equal to the face the
  // handoff pages embed.
  expect(font.equals(readFileSync(FONT_SOURCE))).toBe(true);
  expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
  expect(font.length).toBeLessThan(32 * 1024);
  expect(readFileSync(join(EMAIL_DIR, FONT_LICENSE), "utf8")).toContain("SIL OPEN FONT LICENSE");
});

test("the email assets may be loaded from any origin", async () => {
  const headers = await config.headers!();
  const rule = headers.find((h) => h.source === "/email/:file*");
  expect(rule?.headers).toContainEqual({ key: "Access-Control-Allow-Origin", value: "*" });
  for (const file of [TILE, FONT]) {
    const path = `/email/${file}`;
    const pattern = new RegExp(`^${rule!.source.replace(":file*", "(.*)")}$`);
    expect(pattern.test(path)).toBe(true);
  }
});
