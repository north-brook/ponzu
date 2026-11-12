import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./app/page.tsx";
import { scaleSizes } from "./components/hero-shot.tsx";
import { PRICES } from "./components/pricing.ts";

/*
 * The home page (site slice S3): it no longer runs on Ponzu 1's local runtime, its product shots
 * are the gallery's and are all there, and its pricing band says what rate card v1 bills.
 */

const ROOT = import.meta.dir;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = ["app", "components"]
  .flatMap((d) => walk(join(ROOT, d)))
  .concat(
    ["next.config.ts", "mdx-components.tsx", "instrumentation-client.ts"].map((f) => join(ROOT, f)),
  )
  .filter((p) => /\.(tsx?|mdx|css)$/.test(p) && existsSync(p));

test("the site imports neither @ponzu/store nor @ponzu/render", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  expect(Object.keys(deps)).not.toContain("@ponzu/store");
  expect(Object.keys(deps)).not.toContain("@ponzu/render");
  // Nothing builds the canvas package's stylesheet for the site any more.
  expect(Object.keys(pkg.scripts)).not.toContain("prebuild");
  expect(Object.keys(pkg.scripts)).not.toContain("predev");
  const importers = sources.filter((p) =>
    /["']@ponzu\/(store|render)(\/[^"']*)?["']/.test(readFileSync(p, "utf8")),
  );
  expect(importers.map((p) => relative(ROOT, p))).toEqual([]);
  // The old demo and its assets are gone.
  for (const gone of ["components/demo", "app/demo", "public/demo", "public/home"])
    expect(existsSync(join(ROOT, gone))).toBe(false);
});

test("every product shot the pages show is committed in light and dark", () => {
  const used = new Set<string>();
  for (const p of sources) {
    for (const m of readFileSync(p, "utf8").matchAll(/<HeroShot[\s\S]*?\bid="([^"]+)"/g))
      used.add(m[1]!);
  }
  expect([...used].sort()).toEqual([
    "pull-request-tab",
    "team-sidebar",
    "thread-in-the-right-rail",
    "together-on-a-canvas",
  ]);
  for (const id of used) {
    for (const theme of ["light", "dark"]) {
      const file = join(ROOT, "public/product", `${id}-${theme}.png`);
      expect(existsSync(file)).toBe(true);
      // Drawn at twice 1440×900, which HeroShot's width and height say (no layout shift).
      const bytes = readFileSync(file);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2880, 1800]);
    }
  }
});

test("the pricing band reads rate card v1 through pricing.ts and says it exactly", () => {
  const page = readFileSync(join(ROOT, "app/page.tsx"), "utf8");
  expect(page).toContain('import { PRICES } from "@/components/pricing";');
  // No dollar amount is written into the page: each one comes from the rate card.
  expect(page.match(/\$\d/g)).toBeNull();
  const html = renderToStaticMarkup(Home());
  const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  expect(text).toContain(
    "$0.10 a credit. An awake canvas uses 5 credits an hour; asleep, nothing. 100 credits a month on us, per person.",
  );
  expect(text).toContain("Free to start: 100 credits a month.");
  expect(PRICES.credit).toBe("$0.10");
});

test("a cropped shot asks the optimizer for the width it is really drawn at", () => {
  expect(scaleSizes("(min-width: 1024px) 700px, 100vw", 2)).toBe(
    "(min-width: 1024px) 1400px, 200vw",
  );
  expect(scaleSizes("calc(100vw - 40px)", 1.5)).toBe("calc(150vw - 60px)");
});
