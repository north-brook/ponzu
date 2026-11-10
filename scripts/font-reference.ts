/**
 * Records how Chrome on a Mac sets text in each system font that has a
 * stand-in on Linux (packages/render/src/stand-ins.ts): the width and height
 * of a line, and the ascent, descent and line gap of each font a stand-in
 * borrows them from. It writes packages/render/src/fixtures/mac-fonts.json,
 * which stand-ins.test.ts holds the stand-ins to wherever they are installed.
 *
 * Run it on a Mac after changing the stand-ins or their test lines:
 *
 *   bun scripts/font-reference.ts
 */
import { writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { parseArtboardFile } from "../packages/core/src/index.ts";
import { ChromiumRenderer, findChromium } from "../packages/render/src/chromium.ts";
import { fontCases, fontCasesBoard } from "../packages/render/src/fixtures/font-cases.ts";
import { type Metrics, STAND_INS } from "../packages/render/src/stand-ins.ts";

if (process.platform !== "darwin")
  throw new Error("The reference is Chrome on a Mac: run this on one.");
const chrome = findChromium();
if (!chrome) throw new Error("No Chrome found.");

/**
 * In the page: each family's metrics as fractions of the font size. Chrome
 * rounds them to whole pixels, so they are read at the largest size it sets.
 */
const METRICS = (names: string[]) => {
  const size = 10_000;
  const ctx = document.createElement("canvas").getContext("2d")!;
  const round = (px: number) => Math.round((px / size) * 1e4) / 1e4;
  const out: Record<string, { ascent: number; descent: number; lineGap: number }> = {};
  for (const name of names) {
    const font = `${size}px ${JSON.stringify(name)}`;
    ctx.font = font;
    const m = ctx.measureText("x");
    const line = document.createElement("div");
    line.style.cssText = `font:${font};position:absolute;white-space:nowrap`;
    line.textContent = "x";
    document.body.append(line);
    const lineGap = line.offsetHeight - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent;
    line.remove();
    out[name] = {
      ascent: round(m.fontBoundingBoxAscent),
      descent: round(m.fontBoundingBoxDescent),
      lineGap: round(lineGap),
    };
  }
  return out;
};

const cases = fontCases();
let metrics: Record<string, Metrics> = {};
const renderer = new ChromiumRenderer({
  executablePath: chrome,
  // The renderer has no way to run a script on a page of its own; this hook sees every page it opens.
  preparePage: async (page) => {
    metrics = await page.evaluate(
      METRICS,
      STAND_INS.flatMap((s) => (s.metrics ? [...s.names] : [])),
    );
  },
});
try {
  // A font this Mac lacks would record the size of whatever it fell back to.
  // Missing, a name measures the same as each fallback put after it.
  const families = [...new Map(cases.map((c) => [c.name, c.font.replace(/^.*px /, "")]))];
  const bases = ["monospace", "serif"];
  const probes = families.flatMap(([, family], i) =>
    bases.flatMap((base) => [
      { id: `named_${i}_${base}`, family: `${family}, ${base}` },
      { id: `plain_${i}_${base}`, family: base },
    ]),
  );
  // Letters and digits: every one of these fonts has some of them, the emoji font included.
  const probed = await renderer.measure({
    artboard: parseArtboardFile(
      `<section data-artboard data-id="ab_probe" style="width:8000px;height:fit-content">${probes
        .map(
          (p) =>
            `<span data-id="${p.id}" style="font:40px ${p.family.replace(/"/g, "'")};white-space:nowrap;align-self:flex-start">Handgloves 0123456789</span>`,
        )
        .join("")}</section>`,
      { id: "ab_probe", name: "Probe" },
    ).artboard,
    tokens: "",
    ids: probes.map((p) => p.id),
  });
  const width = (id: string) => probed.boxes[id]!.width;
  const missing = families
    .filter((_, i) => bases.every((b) => width(`named_${i}_${b}`) === width(`plain_${i}_${b}`)))
    .map(([name]) => name);
  if (missing.length) throw new Error(`Not on this Mac: ${missing.join(", ")}.`);

  const { boxes } = await renderer.measure({
    artboard: fontCasesBoard(cases),
    tokens: "",
    ids: cases.map((c) => c.id),
  });
  const widths = Object.fromEntries(cases.map((c) => [c.id, boxes[c.id]!.width]));
  const heights = Object.fromEntries(cases.map((c) => [c.id, boxes[c.id]!.height]));
  const version = Bun.spawnSync([chrome, "--version"]).stdout.toString().trim();
  const recorded = { browser: version, os: `macOS (Darwin ${release()})` };
  const path = join(import.meta.dir, "../packages/render/src/fixtures/mac-fonts.json");
  await writeFile(path, `${JSON.stringify({ recorded, metrics, widths, heights }, null, 2)}\n`);
  console.log(`Wrote ${cases.length} lines and ${Object.keys(metrics).length} fonts to ${path}`);
} finally {
  await renderer.close();
}
