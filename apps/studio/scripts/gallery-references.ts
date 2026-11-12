/*
 * The cloud gallery's compositions against their references, in a real Chromium: the light
 * picture for layout, the painted styles in both themes for color, type, shadows and which
 * picture each image shows. They run in seven files, one for each part
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
 * The part of the app a composition shows: first run's steps; creating a design; a workspace's
 * GitHub, environments and plan in settings; the rest of settings and the dialogs beside them
 * (setup-compositions.ts); the sidebar; the people in a design (sharing, the thread rail, working
 * together); or the window around the canvas (its chrome, a question, the pull request tab, the
 * smallest window).
 */
export type Area = "setup" | "create" | "workspace" | "settings" | "sidebar" | "people" | "window";

const SETUP = new Set(SETUP_COMPOSITIONS.map((c) => c.id));

export function areaOf(c: Composition): Area {
  if (c.id.startsWith("setup-")) return "setup";
  if (/^create(-model-menu)?$|^pick-a-project|^fresh-start|^claude-sets-it-up$/.test(c.id)) {
    return "create";
  }
  if (/^settings-(github|environments|plan)|^free-credits/.test(c.id)) return "workspace";
  if (SETUP.has(c.id)) return "settings";
  if (c.id.includes("sidebar")) return "sidebar";
  if (/^share|^thread-in-the-right-rail$|^together-on-a-canvas$/.test(c.id)) return "people";
  return "window";
}

/** Registers, under "the cloud gallery", the comparisons for every composition in `area`. */
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

    const styles = async (c: Composition, theme: "light" | "dark") =>
      expect(await paintedStyles(page), `${c.id} in ${theme} paints with other styles`).toBe(
        await Bun.file(join(REFERENCES, `${c.id}-${theme}.styles.txt`)).text(),
      );

    for (const c of COMPOSITIONS.filter((c) => c.reference && areaOf(c) === area)) {
      // Light is the one picture, read from the same load as its styles (hiding the text changes
      // only its fill, which the styles don't read). Dark differs from light only in its colors,
      // shadows and a theme's own pictures, all of which its styles hold exactly.
      if (c.reference === "styles") {
        test(`${c.id} in light paints with its reference's styles`, async () => {
          await shootComposition(page, server.url, c, "light");
          await styles(c, "light");
        });
      } else {
        test(`${c.id} in light matches its reference`, async () => {
          // The fonts ship with the app (src/cloud/styles/fonts), so they always load; without them
          // every line measures differently and the comparison would mean nothing.
          expect(fonts, "the app's fonts didn't load").toBe(true);
          const shot = await shootComposition(page, server.url, c, "light", { hideText: true });
          await styles(c, "light");
          const reference = Buffer.from(
            await Bun.file(join(REFERENCES, `${c.id}-light.png`)).arrayBuffer(),
          );
          const tool = await browser.newPage();
          const diff = await compare(tool, reference, shot);
          await tool.close();
          expect(diff.changed, `${c.id}'s picture differs from its reference`).toBeLessThan(
            TOLERANCE,
          );
        });
      }

      test(`${c.id} in dark paints with its reference's styles`, async () => {
        await shootComposition(page, server.url, c, "dark");
        await styles(c, "dark");
      });
    }
  });
}
