/**
 * Records how wide Chrome on a Mac sets text in each system font that has a
 * stand-in on Linux (packages/render/src/stand-ins.ts), into
 * packages/render/src/fixtures/mac-font-widths.json. stand-ins.test.ts holds
 * the stand-ins to these widths wherever they are installed.
 *
 * Run it on a Mac after changing the stand-ins or their test lines:
 *
 *   bun scripts/font-widths.ts
 */
import { writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { parseArtboardFile } from "../packages/core/src/index.ts";
import { ChromiumRenderer, findChromium } from "../packages/render/src/chromium.ts";
import { fontCases, fontCasesBoard } from "../packages/render/src/fixtures/font-cases.ts";

if (process.platform !== "darwin")
  throw new Error("The reference is Chrome on a Mac: run this on one.");
const chrome = findChromium();
if (!chrome) throw new Error("No Chrome found.");

const cases = fontCases();
const renderer = new ChromiumRenderer({ executablePath: chrome });
try {
  // A font this Mac lacks would record the width of whatever it fell back to.
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
  const version = Bun.spawnSync([chrome, "--version"]).stdout.toString().trim();
  const recorded = { browser: version, os: `macOS (Darwin ${release()})` };
  const path = join(import.meta.dir, "../packages/render/src/fixtures/mac-font-widths.json");
  await writeFile(path, `${JSON.stringify({ recorded, widths }, null, 2)}\n`);
  console.log(`Wrote ${cases.length} widths to ${path}`);
} finally {
  await renderer.close();
}
