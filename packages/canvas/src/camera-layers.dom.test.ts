import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import { launchChromium, type TestChromium } from "@ponzu/render/testing";
import { bundle } from "./dom-lib.ts";

/*
 * The boards' layer is a bitmap while the camera moves (useCanvas.ts, useCameraLayers): drawn
 * at the zoom it was promoted at. Zooming out within one gesture, Chromium keeps tiles for all
 * that comes into view at that zoom, which measured 1.1 to 1.5 GB of GPU memory in the Mac app
 * on a canvas of big boards. So the bitmap is drawn again once the zoom on screen falls below
 * half of it. Counted here as the ratio of the bitmap's zoom to the zoom on screen, frame by
 * frame, with a rest far longer than the gesture so no rest can redraw it instead.
 */

type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
const chromium = findChromium();
setDefaultTimeout(30_000);

const ENTRY = `
import { createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { cameraStore, useCameraLayers } from "./useCanvas.ts";

const camera = cameraStore({ x: 0, y: 0, zoom: 1 });
window.pzCamera = camera;
function Layers() {
  const scroller = useRef(null);
  const layer = useRef(null);
  const overlay = useRef(null);
  useCameraLayers(camera, scroller, layer, overlay, true, undefined, 600000);
  return createElement("div", { ref: scroller, style: { position: "fixed", inset: 0, overflow: "hidden" } },
    createElement("div", { style: { width: "262144px", height: "262144px", position: "relative" } },
      createElement("div", { id: "layer", ref: layer, style: { position: "absolute", width: "1440px", height: "4000px", background: "#eee" } }),
      createElement("div", { ref: overlay, style: { position: "absolute" } })));
}
window.pzMount = () => createRoot(document.getElementById("host")).render(createElement(Layers));
`;

describe.skipIf(!chromium)("the boards' layer while zooming, in Chromium", () => {
  let browser: TestChromium;
  let page: Page;

  beforeAll(async () => {
    const code = await bundle("camera-layers", ENTRY, { "process.env.NODE_ENV": '"production"' });
    browser = await launchChromium(chromium!);
    page = await browser.newPage();
    await page.setContent("<!doctype html><div id=host></div>");
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate(() => {
      // Each change to the layer's style: whether it is promoted, and the zoom it shows at.
      const w = window as unknown as {
        pzMount: () => void;
        pzSeen: { promotions: number; worst: number; drawn: number; was: string };
      };
      w.pzSeen = { promotions: 0, worst: 1, drawn: Number.NaN, was: "" };
      new MutationObserver(() => {
        const el = document.getElementById("layer")!;
        const seen = w.pzSeen;
        const promoted = el.style.willChange === "transform";
        const zoom = Number(/scale\(([^)]+)\)/.exec(el.style.transform)?.[1] ?? Number.NaN);
        if (promoted && seen.was !== "transform") {
          seen.promotions++;
          seen.drawn = zoom;
        }
        if (promoted) seen.worst = Math.max(seen.worst, seen.drawn / zoom);
        seen.was = el.style.willChange;
      }).observe(document.getElementById("host")!, {
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      w.pzMount();
    });
    await page.waitForSelector("#layer");
  });
  afterAll(() => browser?.close());

  /** Sets the zoom, then waits two frames: the camera's own, and the one after it. */
  const zoomTo = (zoom: number) =>
    page.evaluate(
      (zoom) =>
        new Promise<void>((done) => {
          const w = window as unknown as {
            pzCamera: { set(c: { x: number; y: number; zoom: number }): void };
          };
          w.pzCamera.set({ x: 0, y: 0, zoom });
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        }),
      zoom,
    );

  test("zooming out 16 times in one gesture keeps the bitmap within twice the zoom on screen", async () => {
    // A gesture from 100% to about 6%, a step a frame, as a pinch or ⌘-wheel would make it.
    for (let i = 1; i <= 40; i++) await zoomTo(0.933 ** i);
    const seen = await page.evaluate(
      () => (window as unknown as { pzSeen: { promotions: number; worst: number } }).pzSeen,
    );
    // Drawn at 100% and kept, it would be 16 times the zoom on screen by the end.
    expect(seen.worst).toBeLessThanOrEqual(2);
    // Redrawn about once per halving (four), never every frame.
    expect(seen.promotions).toBeGreaterThanOrEqual(4);
    expect(seen.promotions).toBeLessThanOrEqual(6);

    // Zooming back in keeps the bitmap it has: no redraw, as before.
    const before = seen.promotions;
    for (let i = 39; i >= 20; i--) await zoomTo(0.933 ** i);
    const after = await page.evaluate(
      () => (window as unknown as { pzSeen: { promotions: number } }).pzSeen.promotions,
    );
    expect(after).toBe(before);
  });
});
