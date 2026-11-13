#!/usr/bin/env bun
/**
 * The pictures of the emails (designs/email.md §7), for the founder to look at and for a
 * reviewer to see a change: each fixture below drawn in headless Chromium, in light and dark
 * (`prefers-color-scheme` emulated), at a phone's 390px and a desktop's 720px, plus a forced
 * inversion (`filter: invert(1) hue-rotate(180deg)` on the light phone render, pictures turned
 * back), which approximates what Gmail and Outlook do to a light email in dark mode. It is an
 * approximation, not Gmail. Each fixture becomes one sheet, references/<fixture>.png.
 *
 * Never merged by hand: take main's and draw them again. The tile and the display face are
 * served from the site's files when they exist (apps/web/public/email, drawn by
 * scripts/email-assets.ts); until then the tile is drawn here as a stand-in with the same look.
 *
 *   bun run --cwd packages/email shots            # every sheet
 *   bun run --cwd packages/email shots recap-3    # just these
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DISPLAY_FACE_WOFF2 } from "../../core/src/display-face.ts";
import { DISPLAY_FONT_URL, TILE_URL } from "../src/brand.ts";
import { FIXTURES } from "../src/fixtures.ts";
import { renderEmail } from "../src/render.ts";
import { LIGHT } from "../src/tokens.ts";

/** One sheet per look worth seeing: each template, and the variants that change its shape. */
export const SHOTS = [
  "billing-free-used",
  "billing-cap-warning",
  "billing-payment-failed",
  "billing-payment-no-invoice",
  "team-4",
  "team-12",
  "recap-3",
  "recap-first",
  "recap-counts-only",
  "digest-two",
  "digest-many",
  "notice-billing-starts",
  "notice-terms-change",
  "notice-suspension-workspace",
] as const;

const ROOT = resolve(import.meta.dir, "../../..");
const REFERENCES = resolve(import.meta.dir, "../references");
const SITE_EMAIL = join(ROOT, "apps/web/public/email");

/** The slice, as the apps draw it (packages/canvas/src/slice.ts), on a yuzu tile. */
const SLICE = [
  "M36 25.07L36 4.99A27.3 27.3 0 0 1 53.39 15.03Z",
  "M40 32L57.39 21.96A27.3 27.3 0 0 1 57.39 42.04Z",
  "M36 38.93L53.39 48.97A27.3 27.3 0 0 1 36 59.01Z",
  "M28 38.93L28 59.01A27.3 27.3 0 0 1 10.61 48.97Z",
  "M24 32L6.61 42.04A27.3 27.3 0 0 1 6.61 21.96Z",
  "M28 25.07L10.61 15.03A27.3 27.3 0 0 1 28 4.99Z",
];
const TILE_STAND_IN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${LIGHT.yuzu}"/><g transform="translate(12.8 12.8) scale(0.6)" fill="${LIGHT.ink}" stroke="${LIGHT.ink}" stroke-width="3.4" stroke-linejoin="round">${SLICE.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;

function asset(url: string): { body: Buffer; contentType: string } | null {
  const file = join(SITE_EMAIL, new URL(url).pathname.replace(/^\/email\//, ""));
  if (url === TILE_URL) {
    return existsSync(file)
      ? { body: readFileSync(file), contentType: "image/png" }
      : { body: Buffer.from(TILE_STAND_IN), contentType: "image/svg+xml" };
  }
  if (url === DISPLAY_FONT_URL) {
    return {
      body: existsSync(file) ? readFileSync(file) : Buffer.from(DISPLAY_FACE_WOFF2, "base64"),
      contentType: "font/woff2",
    };
  }
  return null;
}

interface Page {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(options: { colorScheme: "light" | "dark" }): Promise<void>;
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  screenshot(options: { fullPage?: boolean; type?: "png" }): Promise<Buffer>;
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      fulfill(o: { body: Buffer; contentType: string }): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newPage(options?: { deviceScaleFactor?: number }): Promise<Page>;
  close(): Promise<void>;
}

/** Headless Chromium through the repository's own tooling (@ponzu/render's playwright-core). */
async function launch(): Promise<Browser> {
  const studio = join(ROOT, "apps/studio");
  const chromium = Bun.resolveSync("@ponzu/render/chromium", studio);
  const { findChromium } = (await import(chromium)) as { findChromium(): string | null };
  const executablePath = findChromium();
  if (!executablePath) throw new Error("No Chrome or Chromium found (set PONZU_CHROMIUM).");
  const { chromium: playwright } = (await import(
    Bun.resolveSync("playwright-core", dirname(chromium))
  )) as { chromium: { launch(o: object): Promise<Browser> } };
  return playwright.launch({ executablePath, headless: true });
}

const INVERT =
  "html{filter:invert(1) hue-rotate(180deg);background:#fff}img{filter:invert(1) hue-rotate(180deg)}";

async function draw(
  browser: Browser,
  html: string,
  width: number,
  scheme: "light" | "dark",
  invert = false,
): Promise<Buffer> {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    await page.route("**/*", async (route) => {
      const found = asset(route.request().url());
      if (found) await route.fulfill(found);
      else await route.abort();
    });
    await page.setViewportSize({ width, height: 400 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setContent(html, { waitUntil: "load" });
    if (invert) await page.addStyleTag({ content: INVERT });
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await page.close();
  }
}

const PANELS = [
  { label: "Light, 390", width: 390, scheme: "light" },
  { label: "Dark, 390", width: 390, scheme: "dark" },
  { label: "Inverted, 390", width: 390, scheme: "light", invert: true },
  { label: "Light, 720", width: 720, scheme: "light" },
  { label: "Dark, 720", width: 720, scheme: "dark" },
] as const;

async function sheet(browser: Browser, name: string): Promise<Buffer> {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`No fixture named ${name}.`);
  const email = await renderEmail(fixture.kind, fixture.props as never);
  const panels: string[] = [];
  for (const panel of PANELS) {
    const png = await draw(browser, email.html, panel.width, panel.scheme, "invert" in panel);
    panels.push(
      `<figure><figcaption>${panel.label}</figcaption><img src="data:image/png;base64,${png.toString("base64")}"></figure>`,
    );
  }
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    await page.setViewportSize({ width: 2400, height: 400 });
    await page.setContent(
      `<!doctype html><style>body{margin:0;padding:24px;background:#d9d6cf;font:14px/20px -apple-system,Helvetica,sans-serif;color:#111110;display:flex;gap:24px;align-items:flex-start;width:max-content}figure{margin:0}figcaption{margin:0 0 8px}img{display:block;box-shadow:0 0 0 1px #00000022}</style><body>${panels.join("")}</body>`,
      { waitUntil: "load" },
    );
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await page.close();
  }
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  const list = names.length > 0 ? names : [...SHOTS];
  mkdirSync(REFERENCES, { recursive: true });
  const browser = await launch();
  try {
    for (const name of list) {
      writeFileSync(join(REFERENCES, `${name}.png`), await sheet(browser, name));
      console.log(`Drew references/${name}.png`);
    }
  } finally {
    await browser.close();
  }
}
