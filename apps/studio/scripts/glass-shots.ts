#!/usr/bin/env bun
/**
 * The shell as it sits on a Mac's glass, as near as a headless browser can draw it: a
 * composition with `data-glass` set, and under <html>'s tint a stand-in for the window's
 * material (its own appearance's grey over a blurred, vivid wallpaper). It shows how the tint,
 * the canvas's edge and what sits on the shell read over a wallpaper; the real material, its
 * blur and saturation, and how it changes when the window loses focus, only the Mac shows.
 *
 *   bun scripts/glass-shots.ts <out dir> [composition id…]
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPOSITIONS } from "../src/cloud/gallery/compositions.ts";
import { buildGallery, launch, serve, shootComposition, type Theme } from "./visual-lib.ts";

const [outArg, ...ids] = Bun.argv.slice(2);
if (!outArg) {
  console.error("usage: bun scripts/glass-shots.ts <out dir> [composition id…]");
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

// A wallpaper loud enough to show any bleed: a sunset's oranges and a sea's blues.
const WALLPAPER =
  "radial-gradient(60% 80% at 15% 20%, #ff6a3d, transparent), radial-gradient(60% 80% at 85% 80%, #1f6fff, transparent), linear-gradient(135deg, #2b1055, #d53369)";
// The material: its appearance's grey, most of the way opaque, over that wallpaper.
const MATERIAL = { light: "rgba(236, 236, 236, 0.7)", dark: "rgba(40, 40, 40, 0.7)" };

const glass = (theme: Theme) => `
  :root[data-glass] {
    background:
      linear-gradient(var(--c-chrome-glass), var(--c-chrome-glass)),
      linear-gradient(${MATERIAL[theme]}, ${MATERIAL[theme]}),
      ${WALLPAPER} !important;
  }`;

const built = await buildGallery();
const server = serve(built.dir);
const browser = await launch();
try {
  const page = await browser.newPage();
  const chosen = COMPOSITIONS.filter((c) => ids.length === 0 || ids.includes(c.id));
  for (const c of chosen) {
    for (const theme of ["light", "dark"] as Theme[]) {
      for (const ground of ["solid", "glass"] as const) {
        await shootComposition(page, server.url, c, theme);
        if (ground === "glass") {
          await page.evaluate(() => {
            document.documentElement.dataset.glass = "";
          });
          await page.addStyleTag({ content: glass(theme) });
          await page.waitForTimeout(50);
        }
        const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
        await Bun.write(join(out, `${c.id}-${theme}-${ground}.png`), shot);
        console.log(`${c.id}-${theme}-${ground}`);
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
  built.dispose();
}
