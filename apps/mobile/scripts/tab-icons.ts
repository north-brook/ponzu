/**
 * Draws the tab bar's marks from Hugeicons into assets/native/, at @1x, @2x
 * and @3x, 25pt: `tab-<name>.png` for a tab in the back and
 * `tab-<name>-fill.png` for the one in front. The free set has outline icons
 * only, so the one in front is the same outline drawn heavier. Black on
 * clear: the tab bar draws them as templates and tints them. Rerun when a
 * mark changes:
 *
 *   bun apps/mobile/scripts/tab-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DashboardSquare01Icon,
  Notification01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Resvg } from "@resvg/resvg-js";

type IconSvg = readonly (readonly [string, Record<string, string | number>])[];

/** Each tab's mark: desktop's names for the same concepts (packages/react/src/icons.tsx). */
const MARKS: Record<string, IconSvg> = {
  /** Designs: desktop's `board`. */
  designs: DashboardSquare01Icon,
  search: Search01Icon,
  /** Activity: the bell it was on Designs. */
  activity: Notification01Icon,
};

/** The tab bar's glyph box, in points. */
const SIZE = 25;
/** Hugeicons' 24-unit grid, in that box. The outline at the bar's weight, and heavier in front. */
const STROKE = { default: 1.6, fill: 2.2 };

function svg(icon: IconSvg, stroke: number): string {
  const parts = icon.map(([tag, attrs]) => {
    const a = Object.entries(attrs)
      .filter(([k]) => k !== "key")
      .map(([k, v]) => {
        const name = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        if (name === "stroke-width") return `${name}="${stroke}"`;
        return `${name}="${v === "currentColor" ? "#000" : v}"`;
      })
      .join(" ");
    return `<${tag} ${a}/>`;
  });
  // A half-point margin, as the bar's own glyphs sit in their box.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="-0.5 -0.5 25 25" fill="none">${parts.join("")}</svg>`;
}

const out = join(import.meta.dir, "../assets/native");
mkdirSync(out, { recursive: true });
for (const [name, icon] of Object.entries(MARKS)) {
  for (const [state, stroke] of Object.entries(STROKE)) {
    for (const scale of [1, 2, 3]) {
      const png = new Resvg(svg(icon, stroke), {
        fitTo: { mode: "width", value: SIZE * scale },
        background: "rgba(0,0,0,0)",
      })
        .render()
        .asPng();
      const file = `tab-${name}${state === "fill" ? "-fill" : ""}${scale > 1 ? `@${scale}x` : ""}.png`;
      writeFileSync(join(out, file), png);
    }
  }
}
console.log(`tab icons: ${Object.keys(MARKS).length * 6} files in assets/native`);
