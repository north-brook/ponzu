#!/usr/bin/env bun
/**
 * Contact sheets of every gallery composition and the component states, in light and dark at 2x,
 * for looking at the icon and text ladder by eye. Not a test: it draws, it doesn't compare.
 *
 *   bun scripts/ladder-sheets.ts <out dir> [--only <id>] [--ladder]
 *
 * Writes one picture per composition and theme, the states page, and a sheet per theme that sets
 * them all side by side. With --ladder it also draws `?ladder`, the ladder itself.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMPOSITIONS } from "../src/cloud/gallery/compositions.ts";
import { buildGallery, launch, type Page, serve, type Theme } from "./visual-lib.ts";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { only: { type: "string" }, ladder: { type: "boolean" } },
});
const out = resolve(positionals[0] ?? ".context/ladder-sheets");
mkdirSync(out, { recursive: true });

const built = await buildGallery();
const server = serve(built.dir);
const browser = await launch();
const THEMES: Theme[] = ["light", "dark"];
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const tool = await browser.newPage();
  for (const theme of THEMES) {
    const shots: { name: string; png: Buffer }[] = [];
    for (const c of COMPOSITIONS.filter((c) => !values.only || c.id === values.only)) {
      await page.setViewportSize({ width: c.width, height: c.height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(`${server.url}/gallery.html?board=${c.id}&theme=${theme}`);
      await page.waitForFunction(
        () => (window as { galleryReady?: boolean }).galleryReady === true,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      if (c.open) {
        await page.click(c.open);
        await page.waitForTimeout(250);
      }
      await page.mouse.move(c.width - 1, c.height - 1);
      const png = await page.screenshot({ animations: "disabled", caret: "hide" });
      await Bun.write(join(out, `${c.id}-${theme}.png`), png);
      shots.push({ name: c.id, png });
    }
    for (const view of values.ladder ? ["states", "ladder"] : ["states"]) {
      await page.setViewportSize({ width: 1440, height: view === "ladder" ? 1900 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(`${server.url}/gallery.html?${view}&theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(out, `_${view}-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    if (!values.only) await Bun.write(join(out, `_sheet-${theme}.png`), await sheet(tool, shots));
    console.log(`${theme}: ${shots.length} compositions`);
  }
} finally {
  await browser.close();
  server.stop();
  built.dispose();
}

/** Every shot in a grid, four across, each at half its 2x size, labelled. */
async function sheet(page: Page, shots: { name: string; png: Buffer }[]): Promise<Buffer> {
  const data = await page.evaluate(
    async (items) => {
      const imgs = await Promise.all(
        items.map(async (s) => {
          const img = new Image();
          img.src = s.src;
          await img.decode();
          return { name: s.name, img };
        }),
      );
      const cols = 4;
      const cellW = 1440;
      const cellH = 940;
      const rows = Math.ceil(imgs.length / cols);
      const canvas = new OffscreenCanvas(cols * cellW + 40, rows * cellH + 40);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      imgs.forEach(({ name, img }, i) => {
        const x = 20 + (i % cols) * cellW;
        const y = 20 + Math.floor(i / cols) * cellH;
        const scale = Math.min((cellW - 20) / img.width, (cellH - 50) / img.height);
        ctx.drawImage(img, x, y + 30, img.width * scale, img.height * scale);
        ctx.fillStyle = "#fff";
        ctx.font = "600 22px system-ui";
        ctx.fillText(name, x, y + 22);
      });
      const bytes = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
      );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    shots.map((s) => ({ name: s.name, src: `data:image/png;base64,${s.png.toString("base64")}` })),
  );
  return Buffer.from(data, "base64");
}
