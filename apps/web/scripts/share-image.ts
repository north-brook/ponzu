/**
 * Renders the share card (`/share`) into the images social sites show for a link.
 *
 *   bun run dev                  # in apps/web, in another terminal
 *   bun scripts/share-image.ts   # writes app/opengraph-image.jpg and app/twitter-image.jpg
 *
 * The card shows real boards from the example designs (public/share), so rerun this after they or
 * the brand change. Output is 2400×1260 (2× the 1200×630 card) for sharp previews on
 * high-density screens; X, LinkedIn, Slack, iMessage and Facebook all accept that size.
 */
import { fileURLToPath } from "node:url";
import { findChromium } from "@ponzu/render/chromium";
import { chromium } from "playwright-core";

const BASE = process.env.SHARE_BASE ?? "http://localhost:4321";
const OUT = new URL("../app/", import.meta.url);

// The same browser lookup Ponzu's screenshots use: Chrome, Chromium, Edge, Brave or $PONZU_CHROMIUM.
const executablePath = findChromium();
if (!executablePath) throw new Error("No Chromium-based browser found. Set PONZU_CHROMIUM.");
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await page.goto(`${BASE}/share`, { waitUntil: "networkidle" });
  // Let fonts and the boards settle, and drop the dev-only overlay.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());

  // JPEG at high quality: a fraction the size of a PNG of the screenshot-heavy card, so previews
  // load fast in the feed, with no visible loss.
  const card = page.locator("[data-share-card]");
  for (const name of ["opengraph-image.jpg", "twitter-image.jpg"]) {
    await card.screenshot({ path: fileURLToPath(new URL(name, OUT)), type: "jpeg", quality: 88 });
    console.log(`Wrote app/${name}`);
  }
} finally {
  await browser.close();
}
