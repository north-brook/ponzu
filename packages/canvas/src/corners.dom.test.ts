import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";

/*
 * A board whose root has a border-radius, drawn by the canvas in a real browser: its corners are
 * the design's, not squared off by the canvas's own few px, and its sheet, shadow and working
 * ring follow them. The second run of the Mac app drew a 16px card square while the sandbox's
 * screenshot showed it round.
 */

type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
const { chromium: playwright } = (await import(
  Bun.resolveSync(
    "playwright-core",
    dirname(Bun.resolveSync("@ponzu/render/chromium", import.meta.dir)),
  )
)) as { chromium: { launch(o: object): Promise<Browser> } };
const chromium = findChromium();
setDefaultTimeout(30_000);

const YELLOW = [0xff, 0xf6, 0xb3];

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyDoc, parseArtboardFile } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { MemorySource } from "./connection.ts";

window.pzMount = (style) => {
  const doc = emptyDoc("Corners");
  const { artboard } = parseArtboardFile(
    '<section data-artboard data-id="ab_card" data-name="Card" style="' + style + '"></section>',
    { id: "ab_card", name: "Card" },
  );
  doc.pages.push({ id: "pg_a", name: "Page", artboards: [{ ...artboard, x: 0, y: 0 }] });
  window.pzSource = new MemorySource(doc);
  createRoot(document.getElementById("host")).render(
    createElement(Canvas, { source: window.pzSource }),
  );
};
`;

/** One pixel's red, green and blue from a 1×1 PNG (any filter reads as none on a single pixel). */
function pixel(png: Uint8Array): number[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let colorType = 6;
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IHDR") colorType = png[at + 8 + 9]!;
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const data = inflateSync(Buffer.concat(idat));
  expect([2, 6]).toContain(colorType);
  return [data[1]!, data[2]!, data[3]!];
}

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);

describe.skipIf(!chromium)("a board's corners in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    const dir = import.meta.dir;
    const entry = join(dir, ".corners-entry.tsx");
    await Bun.write(entry, ENTRY);
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await Bun.file(entry).delete();
    if (!built.success) throw new AggregateError(built.logs, "bundle failed");
    code = await built.outputs[0]!.text();
    const out = join(tmpdir(), `pz-corners-${process.pid}.css`);
    const tw = Bun.spawnSync(
      [join(dir, "../node_modules/.bin/tailwindcss"), "-i", join(dir, "styles.css"), "-o", out],
      { stderr: "pipe" },
    );
    if (tw.exitCode !== 0) throw new Error(tw.stderr.toString());
    css = await Bun.file(out).text();
    await Bun.file(out).delete();
    browser = await playwright.launch({ executablePath: chromium!, headless: true });
  });
  afterAll(() => browser?.close());

  const mount = async (style: string) => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate((s) => (window as any).pzMount(s), style);
    await page.waitForFunction(() =>
      document
        .querySelector("[data-pz-board] [data-artboard-host]")
        ?.shadowRoot?.querySelector("[data-artboard]"),
    );
    // Past the first framing and the board's arrival.
    await new Promise((r) => setTimeout(r, 600));
  };

  /** The board's sheet and live root: their radii, and the screen box and zoom they're drawn at. */
  const drawn = () =>
    page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("[data-pz-board]")!;
      const root = sheet
        .querySelector("[data-artboard-host]")!
        .shadowRoot!.querySelector<HTMLElement>("[data-artboard]")!;
      const r = sheet.getBoundingClientRect();
      return {
        sheet: getComputedStyle(sheet).borderTopLeftRadius,
        root: getComputedStyle(root).borderTopLeftRadius,
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        zoom: r.width / sheet.offsetWidth,
      };
    });

  const shot = async (x: number, y: number) =>
    pixel(
      await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } }),
    );

  test("a root with border-radius keeps its corners, and the sheet under it follows them", async () => {
    await mount("width:320px;height:200px;background:#fff6b3;border-radius:16px");
    const d = await drawn();
    expect(d.root).toBe("16px");
    expect(d.sheet).toBe("16px");
    // Just inside the corner is the canvas, not the card; a little further in, the card.
    const inset = 16 * d.zoom;
    expect(near(await shot(d.box.x + 1, d.box.y + 1), YELLOW)).toBe(false);
    expect(near(await shot(d.box.x + inset, d.box.y + inset), YELLOW)).toBe(true);
    expect(near(await shot(d.box.x + d.box.w - 2, d.box.y + d.box.h - 2), YELLOW)).toBe(false);
    await page.close();
  });

  test("a root with no radius, or a smaller one, takes the canvas's few px", async () => {
    await mount("width:320px;height:200px;background:#fff6b3");
    const plain = await drawn();
    expect(Number.parseFloat(plain.root)).toBeGreaterThan(0);
    expect(plain.root).toBe(plain.sheet);
    await page.close();
    await mount("width:320px;height:200px;background:#fff6b3;border-radius:1px");
    const tight = await drawn();
    expect(tight.root).toBe(plain.root);
    await page.close();
  });

  test("a radius in a token is the design's own, as the server's picture draws it", async () => {
    await mount("width:320px;height:200px;background:#fff6b3;border-radius:calc(8px * 3)");
    const d = await drawn();
    expect(d.root).toBe("24px");
    await page.close();
  });
});
