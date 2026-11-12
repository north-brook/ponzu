import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY_FACE_RANGE, DISPLAY_FACE_WOFF2 } from "./display-face.ts";

const FONTS = join(import.meta.dir, "../../../apps/studio/src/cloud/styles/fonts");

test("the display face a handoff carries is the file the apps ship, byte for byte", () => {
  const shipped = readFileSync(join(FONTS, "funnel-display-latin.woff2"));
  expect(Buffer.from(DISPLAY_FACE_WOFF2, "base64").equals(shipped)).toBe(true);
});

test("and covers the characters the apps say that file covers", () => {
  const css = readFileSync(join(FONTS, "fonts.css"), "utf8");
  const face = css
    .split("@font-face")
    .find((block) => block.includes("funnel-display-latin.woff2"));
  const range = face?.match(/unicode-range:\s*([^;]+);/)?.[1]?.replace(/\s+/g, " ").trim();
  expect(range).toBe(DISPLAY_FACE_RANGE);
});
