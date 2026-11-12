#!/usr/bin/env bun
/**
 * The cloud gallery, drawn in headless Chromium.
 *
 *   bun scripts/visual.ts compare --design <path to a .design folder> [--out <dir>] [--only <id>]
 *     Draws every composition that names a board, and the design's own board, at the board's
 *     size in light and dark; writes ours, theirs, the difference and the two side by side to
 *     <out> (.context/visual by default), and prints how much differs, overall and outside the
 *     masked regions: what this code doesn't draw, and the chrome, which departs from the boards
 *     on purpose (no lockup, the toggles at the window's edges).
 *
 *   bun scripts/visual.ts references
 *     Redraws what the gallery test compares against: a picture of each composition in light with
 *     its text hidden (so it holds on any machine's font rendering), and the styles it paints with
 *     in light and dark (paintedStyles). Look at what changed before committing them.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CHROME_HEIGHT, COMPOSITIONS } from "../src/cloud/gallery/compositions.ts";
import {
  buildGallery,
  compare,
  fontsLoaded,
  launch,
  type Page,
  paintedStyles,
  REFERENCES,
  STUDIO,
  serve,
  shootBoard,
  shootComposition,
  type Theme,
} from "./visual-lib.ts";

const THEMES: Theme[] = ["light", "dark"];
const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { design: { type: "string" }, out: { type: "string" }, only: { type: "string" } },
});
const command = positionals[0];
if (command !== "compare" && command !== "references") {
  console.error("usage: bun scripts/visual.ts compare --design <dir> | references");
  process.exit(2);
}
if (command === "compare" && !values.design) {
  console.error("compare needs --design <path to the .design folder>");
  process.exit(2);
}

const built = await buildGallery();
const server = serve(built.dir);
const browser = await launch();
try {
  const page = await browser.newPage();
  const tool = await browser.newPage();
  const chosen = COMPOSITIONS.filter((c) => !values.only || c.id === values.only);

  if (command === "references") {
    mkdirSync(REFERENCES, { recursive: true });
    for (const c of chosen.filter((c) => c.reference)) {
      for (const theme of THEMES) {
        const shot = await shootComposition(page, server.url, c, theme, { hideText: true });
        if (!(await fontsLoaded(page)))
          throw new Error("The app's fonts didn't load; references would be wrong.");
        // The test compares a picture only in light, and not for a styles-only composition.
        if (theme === "light" && c.reference === true) {
          await Bun.write(join(REFERENCES, `${c.id}-${theme}.png`), shot);
        }
        await Bun.write(join(REFERENCES, `${c.id}-${theme}.styles.txt`), await paintedStyles(page));
        console.log(`${c.id}-${theme}`);
      }
    }
  } else {
    const out = resolve(values.out ?? join(STUDIO, "../../.context/visual"));
    mkdirSync(out, { recursive: true });
    const rows: string[] = [];
    for (const c of chosen.filter((c) => c.board)) {
      for (const theme of THEMES) {
        const ours = await shootComposition(page, server.url, c, theme);
        const theirs = await shootBoard(page, values.design!, c.board!, c, theme, out);
        // The chrome departs from the boards on purpose: masked, so the rest is still checked.
        const chrome = { x: 0, y: 0, width: c.width, height: CHROME_HEIGHT };
        const diff = await compare(tool, theirs, ours, [...(c.masks ?? []), chrome]);
        const name = `${c.id}-${theme}`;
        await Bun.write(join(out, `${name}.ours.png`), ours);
        await Bun.write(join(out, `${name}.theirs.png`), theirs);
        await Bun.write(join(out, `${name}.diff.png`), diff.image);
        await Bun.write(join(out, `${name}.pair.png`), await sideBySide(tool, theirs, ours));
        const pct = (n: number) => `${(n * 100).toFixed(2)}%`.padStart(7);
        rows.push(`${name.padEnd(34)} ${pct(diff.changed)}  ${pct(diff.changedOutsideMasks)}`);
        if (c.differs && theme === THEMES.at(-1)) rows.push(`  on purpose: ${c.differs}`);
      }
    }
    console.log(
      `${"composition".padEnd(34)} differs  outside masks\n${rows.join("\n")}\n\nPictures in ${out}`,
    );
  }
} finally {
  await browser.close();
  server.stop();
  built.dispose();
}

/** The design's board on the left, ours on the right. */
async function sideBySide(page: Page, left: Buffer, right: Buffer): Promise<Buffer> {
  const data = await page.evaluate(
    async ({ left, right }) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      };
      const [a, b] = await Promise.all([load(left), load(right)]);
      const canvas = new OffscreenCanvas(a.width + b.width + 16, Math.max(a.height, b.height));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ff00ff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(a, 0, 0);
      ctx.drawImage(b, a.width + 16, 0);
      const bytes = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
      );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    {
      left: `data:image/png;base64,${left.toString("base64")}`,
      right: `data:image/png;base64,${right.toString("base64")}`,
    },
  );
  return Buffer.from(data, "base64");
}
