/**
 * Renders the share card (`/share`) into the images social sites show for a link.
 *
 *   bun run dev                  # in apps/web, in another terminal
 *   bun scripts/share-image.ts   # writes app/opengraph-image.jpg and app/twitter-image.jpg
 *
 * The card holds the real product demo on the moment you comment on a design, so rerun this after
 * the demo or the brand changes. Output is 2400×1260 (2× the 1200×630 card) for sharp previews on
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
  await page.goto(`${BASE}/share?demo=comment`, { waitUntil: "networkidle" });
  // Let fonts, photos and the canvas's camera settle, and drop the dev-only overlay.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());

  // JPEG at high quality: about a third the size of a PNG of the photo-heavy card, so previews
  // load fast in the feed, with no visible loss.
  const card = page.locator("[data-share-card]");
  for (const name of ["opengraph-image.jpg", "twitter-image.jpg"]) {
    await card.screenshot({ path: fileURLToPath(new URL(name, OUT)), type: "jpeg", quality: 88 });
    console.log(`Wrote app/${name}`);
  }
} finally {
  await browser.close();
}
