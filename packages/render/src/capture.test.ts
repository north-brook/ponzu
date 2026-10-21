import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { chromium as playwright } from "playwright-core";
import { captureLimit, captureScale, clampScale, MAX_CAPTURE_PX } from "./capture.ts";
import { ChromiumRenderer, findChromium } from "./chromium.ts";

test("capture scale keeps the image within the GPU's texture size", () => {
  expect(clampScale(undefined)).toBe(1);
  expect(clampScale(0.1)).toBe(0.25);
  expect(clampScale(9)).toBe(4);
  // Fits: the scale asked for, fractional ones included.
  expect(captureScale(1440, 8000, 0.45)).toBe(0.45);
  expect(captureScale(1440, 8000, 2)).toBe(2);
  // 8000 × 3 is 24000 device px: less, but no less than fits.
  const s = captureScale(1440, 8000, 3);
  expect(s).toBeLessThan(3);
  expect(Math.ceil(8000 * s)).toBeLessThanOrEqual(MAX_CAPTURE_PX);
  expect(Math.ceil(8000 * s)).toBeGreaterThan(MAX_CAPTURE_PX - 20);
  // A smaller GPU, a smaller limit; unknown means the default.
  expect(Math.ceil(8000 * captureScale(1440, 8000, 2, captureLimit(8192)))).toBeLessThanOrEqual(
    8192,
  );
  expect(captureLimit(0)).toBe(MAX_CAPTURE_PX);
  expect(captureLimit(32768)).toBe(MAX_CAPTURE_PX);
});

const chromium = findChromium();

// Real Chrome, and big images.
setDefaultTimeout(60_000);

describe.skipIf(!chromium)("tall artboards in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  // A second browser that only reads pixels back out of the images.
  const reader = playwright.launch({ executablePath: chromium ?? undefined, headless: true });
  afterAll(async () => {
    await renderer.close();
    await (await reader).close();
  });

  /** RGB at fractions of the image's height, sampled down its middle. */
  async function pixels(png: Uint8Array, at: number[]) {
    const page = await (await reader).newPage();
    try {
      return await page.evaluate(
        async ({ src, at }) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = 1;
          c.height = 1;
          const g = c.getContext("2d")!;
          return {
            width: img.naturalWidth,
            height: img.naturalHeight,
            rgb: at.map((f) => {
              const y = Math.min(img.naturalHeight - 1, Math.floor(img.naturalHeight * f));
              g.clearRect(0, 0, 1, 1);
              g.drawImage(img, img.naturalWidth >> 1, y, 1, 1, 0, 0, 1, 1);
              return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
            }),
          };
        },
        { src: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, at },
      );
    } finally {
      await page.close();
    }
  }

  // 1440 wide, fit-content, 8000px of 100px bands: band i is rgb(i*3, 255-i*3, 128).
  // A 100vh hero on top: screenshots keep the viewport the artboard's size, so it stays 900px.
  const BANDS = 71;
  const band = (i: number) => [i * 3, 255 - i * 3, 128];
  const artboard = parseArtboardFile(
    `<section data-artboard data-id="ab_tall" data-name="Tall" style="width:1440px;height:fit-content">
<div data-id="n_hero" style="height:100vh;flex-shrink:0;background:rgb(255,0,0)"></div>
${Array.from({ length: BANDS }, (_, i) => `<div data-id="n_b${i}" data-name="Band ${i}" style="height:100px;flex-shrink:0;background:rgb(${band(i).join(",")})"><p data-id="n_t${i}" style="margin:0;font-size:14px">Band ${i}</p></div>`).join("\n")}
</section>`,
    { id: "ab_tall", name: "Tall" },
  ).artboard;
  const base = { artboard, tokens: "", lint: true };
  const height = 900 + BANDS * 100;

  test("the whole artboard, at fractional and large scales", async () => {
    for (const scale of [0.25, 0.45, 1, 2]) {
      const out = await renderer.render({ ...base, scale });
      expect(out.mime).toBe("image/png");
      expect(out.height).toBe(height);
      expect(out.contentHeight).toBe(height);
      expect(out.scale).toBe(scale);
      expect(out.issues).toEqual([]);
      const px = await pixels(out.bytes, [0.05, 0.999]);
      expect(px.width).toBe(Math.round(1440 * scale));
      expect(Math.abs(px.height - height * scale)).toBeLessThanOrEqual(1);
      expect(px.rgb[0]).toEqual([255, 0, 0]);
      // The last band, not blank and not a repeat of the top.
      expect(px.rgb[1]).toEqual(band(BANDS - 1));
    }
  });

  test("past the GPU's limit, the scale comes down instead of failing", async () => {
    const out = await renderer.render({ ...base, scale: 3 });
    expect(out.scale).toBeLessThan(3);
    expect(out.scale).toBeGreaterThan(1.5);
    const px = await pixels(out.bytes, [0.05, 0.5, 0.999]);
    expect(px.height).toBeLessThanOrEqual(MAX_CAPTURE_PX);
    expect(px.rgb[0]).toEqual([255, 0, 0]);
    expect(px.rgb[2]).toEqual(band(BANDS - 1));
  });

  test("nodes anywhere in it, at any scale", async () => {
    for (const [id, i] of [
      ["n_b0", 0],
      ["n_b40", 40],
      ["n_b70", 70],
    ] as const) {
      for (const scale of [0.45, 1, 3]) {
        const out = await renderer.render({ ...base, nodeId: id, scale });
        expect(out.height).toBe(100);
        expect(out.scale).toBe(scale);
        const px = await pixels(out.bytes, [0.9]);
        expect(px.width).toBe(Math.round(1440 * scale));
        expect(px.rgb[0]).toEqual(band(i));
      }
    }
  });

  test("lint measures the artboard at its full height", async () => {
    // Text below the first 900px isn't offscreen or clipped.
    const out = await renderer.render({ ...base, nodeId: "n_t70" });
    expect(out.issues).toEqual([]);
    const fixed = parseArtboardFile(
      `<section data-artboard data-id="ab_fixed" style="width:400px;height:900px">
${Array.from({ length: 12 }, (_, i) => `<div data-id="n_f${i}" style="height:100px;flex-shrink:0">${i}</div>`).join("")}
</section>`,
      { id: "ab_fixed", name: "Fixed" },
    ).artboard;
    const over = await renderer.render({ artboard: fixed, tokens: "", lint: true });
    expect(over.issues.find((i) => i.id === "ab_fixed")?.message).toContain("needs 1200px");
  });

  test("records a node below the first screenful", async () => {
    const out = await renderer.record({ artboard, tokens: "", nodeId: "n_b70" });
    // Nothing animates, so one frame; a contact sheet around it on #ececec.
    expect(out.steps).toHaveLength(1);
    const px = await pixels(out.bytes, [0.6]);
    expect(px.rgb[0]).toEqual(band(70));
  });
});
