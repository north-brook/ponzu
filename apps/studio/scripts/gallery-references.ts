/*
 * The cloud gallery's compositions against their references, in a real Chromium: the picture
 * for layout, the painted styles for color and type. They run in three files, one for each part
 * of the app (src/cloud/gallery/gallery.references.*.test.ts), so bun's workers draw them at
 * once; each composition is in exactly one. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { COMPOSITIONS, type Composition } from "../src/cloud/gallery/compositions.ts";
import { SETUP_COMPOSITIONS } from "../src/cloud/gallery/setup-compositions.ts";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  compare,
  fontsLoaded,
  launch,
  type Page,
  paintedStyles,
  REFERENCES,
  serve,
  shootComposition,
} from "./visual-lib.ts";

/**
 * At most this share of a picture may differ from its reference. Text is hidden in both, so what
 * is left is layout, grounds, icons and shadows; this leaves room for antialiasing between GPUs
 * and operating systems, and catches a moved row or a changed ground. Small things (a text or
 * icon color, a weight) are below it: the painted styles catch those.
 */
const TOLERANCE = 0.002;

/**
 * The part of the app a composition shows: the sidebar (with sharing and the thread rail beside
 * it), first run and settings (setup-compositions.ts), or the rest of the window.
 */
export type Area = "sidebar" | "setup" | "window";

const SETUP = new Set(SETUP_COMPOSITIONS.map((c) => c.id));

export function areaOf(c: Composition): Area {
  if (SETUP.has(c.id)) return "setup";
  if (/sidebar|^share|^thread-in-the-right-rail$/.test(c.id)) return "sidebar";
  return "window";
}

/** Registers, under "the cloud gallery", both comparisons for every composition in `area`. */
export function referenceTests(area: Area) {
  setDefaultTimeout(60_000);

  describe.skipIf(!chromiumPath)("the cloud gallery", () => {
    let built: Awaited<ReturnType<typeof buildGallery>>;
    let server: ReturnType<typeof serve>;
    let browser: Browser;
    let page: Page;
    let fonts = false;

    beforeAll(async () => {
      built = await buildGallery();
      server = serve(built.dir);
      browser = await launch();
      page = await browser.newPage();
      await page.goto(`${server.url}/gallery.html?board=team-sidebar`);
      fonts = await fontsLoaded(page);
    });
    afterAll(async () => {
      await browser?.close();
      server?.stop();
      built?.dispose();
    });

    for (const c of COMPOSITIONS.filter((c) => c.reference && areaOf(c) === area)) {
      for (const theme of ["light", "dark"] as const) {
        test(`${c.id} in ${theme} matches its reference`, async () => {
          // Without the app's fonts every line measures differently; that is the network, not us.
          if (!fonts) return console.warn("The app's fonts didn't load; references not compared.");
          const shot = await shootComposition(page, server.url, c, theme, { hideText: true });
          const reference = Buffer.from(
            await Bun.file(join(REFERENCES, `${c.id}-${theme}.png`)).arrayBuffer(),
          );
          const tool = await browser.newPage();
          const diff = await compare(tool, reference, shot);
          await tool.close();
          expect(diff.changed).toBeLessThan(TOLERANCE);
        });

        test(`${c.id} in ${theme} paints with its reference's styles`, async () => {
          await shootComposition(page, server.url, c, theme);
          const expected = await Bun.file(join(REFERENCES, `${c.id}-${theme}.styles.txt`)).text();
          expect(await paintedStyles(page)).toBe(expected);
        });
      }
    }
  });
}
