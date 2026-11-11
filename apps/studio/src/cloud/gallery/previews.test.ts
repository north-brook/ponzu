/*
 * A sidebar row's preview while the agent works, in a real Chromium: its address moves on every
 * few seconds, each picture takes a while to arrive (one fails, two arrive out of order), and
 * every animation frame is recorded. Once a picture has shown, no frame may show the empty tile,
 * the pictures never go backwards, and the row never moves. Skips where there is no Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  launch,
  type Page,
  STUDIO,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

const ROW = "dsn_quieter";
/** The row's preview tile, the first box beside its name. */
const TILE = `[data-design-row="${ROW}"] span.relative > span:first-child`;
const PICTURES = ["hero", "pricing", "checkout", "brand"].map((name) =>
  join(STUDIO, "src/cloud/gallery/previews", `${name}.png`),
);

/** How each picture answers: after this many milliseconds, or a failure. */
const ANSWERS: Record<number, { ms: number; fails?: boolean }> = {
  1: { ms: 300 },
  2: { ms: 400 },
  3: { ms: 200, fails: true },
  // Asked for just before 5, and arrives well after it.
  4: { ms: 900 },
  5: { ms: 150 },
  6: { ms: 350 },
};

interface Frame {
  t: number;
  row: string;
  tile: string;
  layers: { seq: number; theme: string; loaded: boolean; opacity: number }[];
}

describe.skipIf(!chromiumPath)("a sidebar row's live preview", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  let asked: string[];

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    built?.dispose();
  });

  const open = async (reducedMotion: "reduce" | "no-preference") => {
    page = await browser.newPage();
    asked = [];
    await page.route("**/live/**", async (route) => {
      const url = new URL(route.request().url());
      asked.push(url.pathname);
      const [, seq, theme] = url.pathname.match(/\/live\/(\d+)-(light|dark)\.png$/) ?? [];
      const answer = ANSWERS[Number(seq)] ?? { ms: 100 };
      await new Promise((r) => setTimeout(r, answer.ms + (theme === "dark" ? 50 : 0)));
      if (answer.fails) return route.fulfill({ status: 500, body: "" });
      const file = PICTURES[(Number(seq) + (theme === "dark" ? 2 : 0)) % PICTURES.length]!;
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(await Bun.file(file).arrayBuffer()),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion });
    await page.goto(`${server.url}/gallery.html?board=sidebar-previews-updating&still&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    // Every frame from here: the row's box, the tile's, and each picture in the tile.
    await page.evaluate((row) => {
      const frames: Frame[] = [];
      (window as unknown as { frames_: Frame[] }).frames_ = frames;
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return `${r.x},${r.y},${r.width},${r.height}`;
      };
      const tick = () => {
        const el = document.querySelector(`[data-design-row="${row}"]`);
        const tile = el?.querySelector("span.relative > span:first-child");
        if (el && tile) {
          frames.push({
            t: performance.now(),
            row: box(el),
            tile: box(tile),
            layers: [...tile.querySelectorAll("img")].flatMap((img) => {
              const m = img.src.match(/\/live\/(\d+)-(light|dark)\.png$/);
              if (!m) return [];
              const css = getComputedStyle(img);
              return [
                {
                  seq: Number(m[1]),
                  theme: m[2]!,
                  loaded: img.complete && img.naturalWidth > 0 && !img.hidden,
                  opacity:
                    css.display === "none" || css.visibility !== "visible"
                      ? 0
                      : Number(css.opacity),
                },
              ];
            }),
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, ROW);
  };

  const showPreview = (seq: number) =>
    page.evaluate(
      ([row, seq]) =>
        window.livePreviews!.patch(row as string, {
          preview: { light: `/live/${seq}-light.png`, dark: `/live/${seq}-dark.png` },
        }),
      [ROW, seq] as const,
    );
  const wait = (ms: number) => page.waitForTimeout(ms);
  const frames = () => page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);

  /** What each frame shows: the newest picture drawn, and whether one covers the whole tile. */
  const read = (all: Frame[]) =>
    all.map((f) => {
      const drawn = f.layers.filter((l) => l.loaded && l.opacity > 0);
      return {
        ...f,
        newest: drawn.length ? Math.max(...drawn.map((l) => l.seq)) : null,
        covered: drawn.some((l) => l.opacity >= 0.999),
        themes: drawn.map((l) => l.theme),
      };
    });

  test("never the empty tile once a picture has shown, never backwards, never a moved row", async () => {
    await open("no-preference");
    await showPreview(1);
    await wait(1400);
    await showPreview(2);
    await wait(1600);
    await showPreview(3); // fails
    await wait(1200);
    await showPreview(4); // slow
    await wait(60);
    await showPreview(5); // quick: arrives before 4
    await wait(2000);
    // A live update that isn't about the picture: a new preview object, the same addresses.
    const before = await page.$eval(`${TILE} img`, (img) => {
      (img as HTMLImageElement & { mark?: boolean }).mark = true;
      return (img as HTMLImageElement).src;
    });
    const askedBefore = asked.length;
    await page.evaluate((row) => {
      window.livePreviews!.patch(row, { needsYou: 1, agentState: "working" });
      window.livePreviews!.patch(row, {
        preview: { light: "/live/5-light.png", dark: "/live/5-dark.png" },
      });
    }, ROW);
    await wait(300);
    const kept = await page.$$eval(`${TILE} img`, (imgs) =>
      imgs.map((img) => ({
        src: (img as HTMLImageElement).src,
        mark: (img as HTMLImageElement & { mark?: boolean }).mark === true,
      })),
    );
    const askedAfter = asked.length;

    await showPreview(6);
    await wait(1600);
    // The other theme: its picture swaps in without the empty tile between.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await wait(1200);

    const all = read(await frames());
    const first = all.findIndex((f) => f.newest !== null);
    expect(first).toBeGreaterThanOrEqual(0);
    // Before the first picture, the empty tile; it fades in from there.
    const afterFirst = all.slice(first);
    const firstCovered = afterFirst.findIndex((f) => f.covered);
    const shown = afterFirst.slice(firstCovered);
    const empty = shown.filter((f) => !f.covered);
    expect(empty.length).toBe(0);
    // Never backwards, and never the one that failed or the one that came too late.
    let newest = 0;
    for (const f of shown) {
      expect(f.newest!).toBeGreaterThanOrEqual(newest);
      newest = f.newest!;
    }
    const seen = [...new Set(shown.map((f) => f.newest))];
    expect(seen).toEqual([1, 2, 5, 6]);
    expect(shown.at(-1)!.themes).toEqual(["dark"]);
    // The row and its tile hold their boxes the whole time.
    expect(new Set(all.map((f) => f.row)).size).toBe(1);
    expect(new Set(all.map((f) => f.tile)).size).toBe(1);
    // The unrelated update kept the very same picture element, and asked for nothing.
    expect(kept).toEqual([{ src: before, mark: true }]);
    expect(askedAfter).toBe(askedBefore);
    // It did cross-fade: some frame drew the new picture partly over the old.
    expect(
      shown.some((f) => f.layers.some((l) => l.loaded && l.opacity > 0 && l.opacity < 1)),
    ).toBe(true);
    await page.close();
  });

  test("with reduced motion a new picture swaps at once, still with no empty frame", async () => {
    await open("reduce");
    await showPreview(1);
    await wait(1400);
    await showPreview(2);
    await wait(1400);
    const all = read(await frames());
    const shown = all.slice(all.findIndex((f) => f.covered));
    expect(shown.filter((f) => !f.covered).length).toBe(0);
    expect(all.some((f) => f.layers.some((l) => l.opacity > 0 && l.opacity < 1))).toBe(false);
    expect([...new Set(shown.map((f) => f.newest))]).toEqual([1, 2]);
    await page.close();
  });
});
