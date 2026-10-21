import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtboardFile } from "@ponzu/core";
import type { Page } from "playwright-core";
import { ChromiumRenderer, findChromium } from "./chromium.ts";
import { STAGE_BUDGET_MS } from "./stages.ts";

/**
 * A stand-in for fonts.googleapis.com that is as strict as the real css2: it
 * serves only the exact requests Google accepts for the families it knows and
 * answers 400 to anything else, like a 100..900 request for Instrument Serif.
 * The font is a 1.6 KB subset of Instrument Serif (OFL) with just "Fernsmlio".
 */
const FONT = readFileSync(join(import.meta.dir, "fixtures/instrument-serif-ferns.woff2"));
const ACCEPTS: Record<string, string> = {
  "Instrument Serif:ital,wght@0,400;1,400": "normal",
};
const requested: string[] = [];
let offline = false;
/** Font files never arrive, as from a server that accepts the connection and goes quiet. */
let stalled = false;

async function fakeGoogle(page: Page) {
  await page.route("https://fonts.googleapis.com/**", (route) => {
    const family = new URL(route.request().url()).searchParams.get("family") ?? "";
    requested.push(family);
    if (offline) return route.abort("internetdisconnected");
    const style = ACCEPTS[family];
    if (!style)
      return route.fulfill({ status: 400, contentType: "text/html", body: "Bad request" });
    const name = family.split(":")[0];
    return route.fulfill({
      status: 200,
      contentType: "text/css",
      headers: { "access-control-allow-origin": "*" },
      body: `@font-face { font-family: '${name}'; font-style: ${style}; font-weight: 400; src: url(https://fonts.gstatic.com/fake.woff2) format('woff2'); }`,
    });
  });
  await page.route("https://fonts.gstatic.com/**", (route) =>
    stalled
      ? new Promise<void>(() => {})
      : offline
        ? route.abort("internetdisconnected")
        : route.fulfill({
            status: 200,
            contentType: "font/woff2",
            headers: { "access-control-allow-origin": "*" },
            body: FONT,
          }),
  );
}

const chromium = findChromium();
setDefaultTimeout(30_000);

describe.skipIf(!chromium)("fonts in Chromium", () => {
  const renderer = new ChromiumRenderer({
    executablePath: chromium ?? undefined,
    preparePage: fakeGoogle,
  });
  afterAll(() => renderer.close());

  const board = (body: string) =>
    parseArtboardFile(
      `<section data-artboard data-id="ab_f" data-name="Fonts" style="width:600px;height:300px;padding:24px;gap:12px;font-family:var(--font-text)">${body}</section>`,
      { id: "ab_f", name: "Fonts" },
    ).artboard;
  const missing = (issues: { kind: string; id: string; message: string }[]) =>
    issues.filter((i) => i.kind === "missing-font");

  test("a family with only a regular and an italic loads, and lint stays quiet", async () => {
    requested.length = 0;
    offline = false;
    const out = await renderer.render({
      artboard: board(
        `<h1 data-id="n_head" style="margin:0;font-family:var(--font-display);font-size:48px;font-weight:400">Ferns</h1>`,
      ),
      tokens: `:root { --font-display: "Instrument Serif", serif; --font-text: Georgia, serif; }`,
      lint: true,
    });
    expect(requested).toEqual(["Instrument Serif:ital,wght@0,400;1,400"]);
    expect(missing(out.issues)).toEqual([]);
  });

  test("one bad family doesn't stop the others, and lint names it", async () => {
    requested.length = 0;
    offline = false;
    const out = await renderer.render({
      artboard: board(
        `<h1 data-id="n_head" style="margin:0;font-family:'Instrument Serif', serif;font-size:48px">Ferns</h1>
<p data-id="n_typo" style="margin:0;font-family:'Instrument Serf', serif">Ferns</p>
<p data-id="n_again" style="margin:0;font-family:'Instrument Serf', serif">Ferns too</p>`,
      ),
      tokens: "",
      lint: true,
    });
    // Separate requests; the typo's 400 can't fail Instrument Serif.
    expect(requested).toContain("Instrument Serif:ital,wght@0,400;1,400");
    const issues = missing(out.issues);
    expect(issues.map((i) => i.id)).toEqual(["n_typo"]);
    expect(issues[0]!.message).toContain(`font "Instrument Serf" isn't a Google Font`);
    expect(issues[0]!.message).toContain("serif instead");
    expect(issues[0]!.message).toContain(`Did you mean "Instrument Serif"?`);
  });

  test("offline, lint says the Google Font didn't load", async () => {
    requested.length = 0;
    offline = true;
    try {
      const out = await renderer.render({
        artboard: board(
          `<h1 data-id="n_head" style="margin:0;font-family:'Instrument Serif', monospace;font-size:48px">Ferns</h1>`,
        ),
        tokens: "",
        lint: true,
      });
      // The first try and its retry.
      expect(requested).toHaveLength(2);
      const issues = missing(out.issues);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain(
        `font "Instrument Serif" didn't load from Google Fonts (offline?)`,
      );
      expect(issues[0]!.message).toContain("shows in monospace instead");
    } finally {
      offline = false;
    }
  });

  test("a family the page brings with @font-face isn't fetched, and is flagged if its file fails", async () => {
    requested.length = 0;
    const out = await renderer.render({
      artboard: board(
        `<style>@font-face { font-family: "Brand Sans"; src: url(data:font/woff2;base64,AAAA) format("woff2"); }</style>
<p data-id="n_brand" style="margin:0;font-family:'Brand Sans', sans-serif">Ferns</p>`,
      ),
      tokens: "",
      lint: true,
    });
    expect(requested).toEqual([]);
    expect(missing(out.issues).map((i) => i.message)).toEqual([
      `font "Brand Sans" didn't load; check its @font-face src. Its text shows in sans-serif instead`,
    ]);
  });

  test("a font that never arrives doesn't hold the screenshot, and lint names it", async () => {
    stalled = true;
    try {
      const started = Date.now();
      const out = await renderer.render({
        artboard: board(
          `<h1 data-id="n_head" style="margin:0;font-family:'Instrument Serif', monospace;font-size:48px">Ferns</h1>`,
        ),
        tokens: "",
        lint: true,
        scale: 2,
      });
      expect(Date.now() - started).toBeLessThan(STAGE_BUDGET_MS.assets + 5_000);
      expect(out.assetsTimedOut).toBe(true);
      // A whole PNG of the 600×300 artboard at 2x, from its header.
      const png = Buffer.from(out.bytes);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 600]);
      expect(missing(out.issues).map((i) => i.id)).toEqual(["n_head"]);
    } finally {
      stalled = false;
    }
  });
});
