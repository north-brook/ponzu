import { expect, test } from "bun:test";
import { parseArtboardFile, serializeArtboardElement } from "@ponzu/core";
import { artboardPage, originalUrl, renditionUrl } from "@ponzu/render";
import {
  backgroundWidth,
  chooseStep,
  contentWidth,
  copyStep,
  firstStep,
  markupUrl,
} from "./images.ts";

const BASE = "http://127.0.0.1:7777/files/%2Fa.design";
const asset = (p: string) => `${BASE}/assets/${p}`;

test("a design's images and remote ones have copies; others don't", () => {
  const img = { tag: "img", attr: "src" };
  expect(markupUrl(asset("a.jpg"), BASE, img, 512)).toBe(`${asset("a.jpg")}?w=512`);
  expect(markupUrl("https://x.com/p.png?v=2", BASE, img, 256)).toBe(
    "http://127.0.0.1:7777/api/image?w=256&url=https%3A%2F%2Fx.com%2Fp.png%3Fv%3D2",
  );
  // A remote URL without an extension is an image where only an image can go.
  expect(markupUrl("https://cdn.x.com/photo/123", BASE, img, 256)).toContain("/api/image?");
  expect(markupUrl("https://cdn.x.com/font", BASE, { tag: "link", attr: "href" }, 256)).toBe(
    "https://cdn.x.com/font",
  );
  // SVG, GIF (may animate), video and data: URLs stay as they are.
  expect(markupUrl(asset("a.svg"), BASE, img, 512)).toBe(asset("a.svg"));
  expect(markupUrl(asset("a.gif"), BASE, img, 512)).toBe(asset("a.gif"));
  expect(markupUrl(asset("a.mp4"), BASE, { tag: "video", attr: "src" }, 512)).toBe(asset("a.mp4"));
  expect(markupUrl("data:image/png;base64,AA", BASE, img, 512)).toBe("data:image/png;base64,AA");
});

test("a copy's URL leads back to its original", () => {
  for (const u of [asset("a.jpg"), asset("a b.png#x"), "https://x.com/p.png?v=2"]) {
    const copy = renditionUrl(u, 1024, BASE)!;
    expect(copyStep(copy, BASE)).toBe(1024);
    expect(originalUrl(copy, BASE)).toBe(u);
    expect(copyStep(u, BASE)).toBe(0);
  }
  // Asking again replaces the width rather than adding one.
  expect(renditionUrl(`${asset("a.jpg")}?w=256`, 512, BASE)).toBe(`${asset("a.jpg")}?w=512`);
});

test("markup starts small, as wide as the board is drawn", () => {
  expect(firstStep(1440, 0.08 * 2)).toBe(256);
  expect(firstStep(1440, 0.25 * 2)).toBe(512);
  expect(firstStep(1440, 2)).toBe(512);
});

test("a copy goes up as soon as it's drawn bigger, and down only well under", () => {
  expect(chooseStep(300, 256)).toBe(512);
  expect(chooseStep(500, 512)).toBe(512);
  expect(chooseStep(300, 512)).toBe(512);
  expect(chooseStep(200, 512)).toBe(512);
  expect(chooseStep(160, 512)).toBe(256);
  expect(chooseStep(3000, 512)).toBe(4096);
  // Past the largest copy, the largest.
  expect(chooseStep(20000, 4096)).toBe(8192);
});

test("object-fit and background-size decide how wide an image is drawn", () => {
  // A 3:2 image covering a square box draws 1.5× the box's width.
  expect(contentWidth(400, 400, 3000, 2000, "cover")).toBe(600);
  expect(contentWidth(400, 400, 3000, 2000, "contain")).toBe(400);
  expect(contentWidth(400, 400, 3000, 2000, "fill")).toBe(600);
  expect(backgroundWidth(400, 400, "cover", 1.5)).toBe(600);
  expect(backgroundWidth(400, 400, "50%")).toBe(200);
  expect(backgroundWidth(400, 400, "100px 50px", undefined, undefined, 2)).toBe(200);
  expect(backgroundWidth(400, 400, "auto")).toBe(Number.POSITIVE_INFINITY);
  expect(backgroundWidth(400, 400, "auto", 1.5, 900)).toBe(900);
});

test("srcset candidates, inline url()s and image-set() all get copies; the stored design doesn't change", () => {
  const html = `<section data-artboard style="width:1440px;height:900px">
<picture><source srcset="assets/a.jpg 1x, assets/b.jpg 2x"><img src="assets/c.jpg" srcset="assets/c.jpg 1x"></picture>
<div style="background:url('assets/d.jpg') center/cover"></div>
<div style="background-image:image-set('assets/e.jpg' 1x, url(assets/f.webp) 2x)"></div>
<svg><image href="assets/g.png"/></svg>
<style>.x{background:url(assets/h.jpg)}</style>
</section>`;

  const { artboard: ab } = parseArtboardFile(html, { id: "ab", name: "A" });
  const out = serializeArtboardElement(ab, {
    rewriteUrl: (u, ctx) => markupUrl(`${BASE}/${u}`, BASE, ctx, 256),
  });
  for (const f of ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.webp", "g.png", "h.jpg"])
    expect(out).toContain(`${asset(f)}?w=256`);
  expect(out).toContain(`${asset("b.jpg")}?w=256 2x`);
  // Screenshots and exports: the originals.
  const page = artboardPage(ab, { tokens: "", assetBase: BASE });
  expect(page).not.toContain("?w=");
  expect(page).toContain(asset("c.jpg"));
  // A thumbnail render asks for copies the size of the thumbnail.
  expect(artboardPage(ab, { tokens: "", assetBase: BASE, imageScale: 0.25 })).toContain(
    `${asset("c.jpg")}?w=512`,
  );
});
