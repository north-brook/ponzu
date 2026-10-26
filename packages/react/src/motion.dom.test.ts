import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname, join } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";

/*
 * Motion and BoardDetail in a real browser: animation events, CSS animations
 * and SVG images don't exist outside one. The modules are bundled and run in
 * a page with a shadow root like an artboard's. Playwright comes from
 * @ponzu/render, which already depends on it, rather than as a dependency here.
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

const ENTRY = `
import { fieldsOf, Motion, MOTION_CSS } from "./motion.ts";
import { BoardDetail, STILL_CSS } from "./lod.ts";
import { handoffToVideos, reload, syncLiveToVideos, unload } from "./loops.tsx";
window.pz = { fieldsOf, Motion, MOTION_CSS, BoardDetail, STILL_CSS, handoffToVideos, syncLiveToVideos, unload, reload };
`;

describe.skipIf(!chromium)("motion in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const dir = import.meta.dir;
    const entry = join(dir, ".motion-entry.ts");
    await Bun.write(entry, ENTRY);
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
    await Bun.file(entry).delete();
    const code = await built.outputs[0]!.text();
    browser = await playwright.launch({ executablePath: chromium!, headless: true });
    page = await browser.newPage();
    await page.setContent("<!doctype html><div id=host></div>");
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pz" in window);
  });
  afterAll(() => browser?.close());

  /** Fill the host's shadow root with a board, and start Motion on it. */
  const board = (html: string) =>
    page.evaluate((html) => {
      const w = window as any;
      const host = document.getElementById("host")!;
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      w.motion?.dispose();
      root.innerHTML = `<style data-pz-base>${w.pz.MOTION_CSS}${w.pz.STILL_CSS}</style><section data-artboard style="width:400px">${html}</section>`;
      w.motion = new w.pz.Motion(root);
      w.motion.reset();
      return w.motion.running.size as number;
    }, html);
  const frames = (n: number) =>
    page.evaluate(
      (n) =>
        new Promise<void>((r) => {
          const tick = (k: number) => (k ? requestAnimationFrame(() => tick(k - 1)) : r());
          tick(n);
        }),
      n,
    );

  test("it lists a board's running animations, and keeps the list as they start and stop", async () => {
    const spin = "@keyframes spin{to{transform:rotate(1turn)}}";
    expect(
      await board(
        `<style>${spin}.s{animation:spin 1s linear infinite}</style><div class=s></div><div class=s></div>`,
      ),
    ).toBe(2);
    // One more starts: the animationstart event adds it, without asking the document again.
    const n = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const d = document.createElement("div");
      d.className = "s";
      root.querySelector("section")!.append(d);
      await new Promise((r) => setTimeout(r, 100));
      return w.motion.running.size as number;
    });
    expect(n).toBe(3);
    // One is removed: animationcancel drops it.
    const m = await page.evaluate(async () => {
      const w = window as any;
      document.getElementById("host")!.shadowRoot!.querySelector(".s")!.remove();
      await new Promise((r) => setTimeout(r, 100));
      return w.motion.running.size as number;
    });
    expect(m).toBe(2);
  });

  test("an SVG with many animated parts becomes an image of itself, and its parts leave the list", async () => {
    const uses = Array.from(
      { length: 60 },
      (_, i) => `<use class=r href="#d" x="${(i % 10) * 20}" y="${Math.floor(i / 10) * 20}"/>`,
    ).join("");
    await board(
      `<style>@keyframes r{to{transform:rotate(60deg)}}.r{animation:r 2s infinite}</style><svg viewBox="0 0 200 120" width=400 height=240 style="overflow:hidden"><defs><circle id=d r=8 cx=8 cy=8 fill="#fc3"/></defs>${uses}</svg>`,
    );
    await page.waitForFunction(
      () => !!document.getElementById("host")!.shadowRoot!.querySelector("[data-pz-field]"),
    );
    await frames(3);
    const state = await page.evaluate(() => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      return {
        running: w.motion.running.size as number,
        image: !!root.querySelector("svg > image[data-pz-image]"),
        // The live parts hold still under the image.
        live: root.getAnimations().filter((a) => a.playState === "running").length,
      };
    });
    expect(state.image).toBe(true);
    expect(state.running).toBe(0);
    expect(state.live).toBe(0);
  });

  test("a field tells its board time, and shows a time it's given", async () => {
    // The field from the test before: its parts are in a region a loop could film.
    const clock = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const svg = root.querySelector("svg")!;
      svg.querySelector("use")!.setAttribute("data-id", "n_use");
      const [f] = w.pz.fieldsOf(root, ["n_use"]);
      if (!f) return null;
      const a = f.time() as number;
      await new Promise((r) => setTimeout(r, 200));
      const b = f.time() as number;
      // Set to 5 s on: it shows that pose once its image loads again, and runs on from there.
      await f.phase(5000);
      const c = f.time() as number;
      return { ticks: b - a, at: c };
    });
    expect(clock).not.toBeNull();
    // Its clock runs with the page's.
    expect(clock!.ticks).toBeGreaterThan(150);
    expect(clock!.ticks).toBeLessThan(400);
    expect(clock!.at).toBeGreaterThanOrEqual(5000);
    expect(clock!.at).toBeLessThan(5300);
  });

  test("a held board's field image holds its pose, and goes on from it when let go", async () => {
    // The field from the tests before.
    const r = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const [f] = w.pz.fieldsOf(root, ["n_use"]);
      const lod = new w.pz.BoardDetail(root, w.motion);
      const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
      const loaded = () =>
        new Promise((res) =>
          root.querySelector("image[data-pz-image]")!.addEventListener("load", res, { once: true }),
        );
      const shown = loaded();
      lod.update({ hidden: false, scale: 4, moving: false, hold: true });
      await shown;
      const a = f.time() as number;
      await wait(250);
      const b = f.time() as number;
      const href = root.querySelector("image[data-pz-image]")!.getAttribute("href")!;
      const blob = await (await fetch(href)).text();
      const back = loaded();
      lod.update({ hidden: false, scale: 4, moving: false, hold: false });
      await back;
      const c = f.time() as number;
      await wait(250);
      const d = f.time() as number;
      return {
        still: b - a,
        paused: blob.includes("animation-play-state: paused"),
        from: c - b,
        runs: d - c,
      };
    });
    // Held: no time passes in the image, which is drawn with its animations paused.
    expect(r.still).toBe(0);
    expect(r.paused).toBe(true);
    // Let go: from the pose it held, running again.
    expect(Math.abs(r.from)).toBeLessThan(50);
    expect(r.runs).toBeGreaterThan(150);
  });

  test("a handoff leaves an animation the design paused paused, after the next thaw too", async () => {
    await board(
      `<style>@keyframes spin{to{transform:rotate(1turn)}}.s{width:40px;height:40px;animation:spin 1s linear infinite}.p{animation-play-state:paused}</style><div class=s data-id=n_run></div><div class="s p" data-id=n_paused></div>`,
    );
    await frames(2);
    const r = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const layer = document.createElement("div");
      layer.append(document.createElement("video"), document.createElement("video"));
      const loops = {
        t0: 0,
        regions: [
          { x: 0, y: 0, width: 40, height: 40, period: 1000, src: "", ids: ["n_run"] },
          { x: 0, y: 40, width: 40, height: 40, period: 1000, src: "", ids: ["n_paused"] },
        ],
      };
      // The videos have no source: the handoff doesn't wait on them.
      for (const v of layer.querySelectorAll("video"))
        Object.defineProperty(v, "readyState", { value: 1 });
      await w.pz.handoffToVideos(
        root,
        layer,
        loops,
        () => {},
        () => false,
      );
      const [run, held] = ["n_run", "n_paused"].map(
        (id) => root.querySelector(`[data-id=${id}]`)!.getAnimations()[0]!,
      );
      const during = [run!.playState, held!.playState];
      w.pz.syncLiveToVideos(root, null);
      return { during, after: [run!.playState, held!.playState] };
    });
    expect(r.during).toEqual(["paused", "paused"]);
    expect(r.after).toEqual(["running", "paused"]);
  });

  test("a board's video unloaded to save its decoder goes on where it was", async () => {
    const r = await page.evaluate(async () => {
      const w = window as any;
      const v = document.createElement("video");
      let at = 2.5;
      // A video at 2.5 s, without a real file: the time it's set to is what's checked.
      Object.defineProperty(v, "readyState", { get: () => 1 });
      Object.defineProperty(v, "currentTime", {
        get: () => at,
        set: (t: number) => {
          at = t;
        },
      });
      v.load = () => {
        at = 0;
      };
      w.pz.unload(v);
      const reset = at;
      w.pz.reload(v, "about:blank#v");
      v.dispatchEvent(new Event("loadedmetadata"));
      const first = at;
      // And again, the next time it loses its turn.
      at = 4;
      w.pz.unload(v);
      w.pz.reload(v, "about:blank#v");
      v.dispatchEvent(new Event("loadedmetadata"));
      return { reset, first, second: at };
    });
    expect(r).toEqual({ reset: 0, first: 2.5, second: 4 });
  });

  test("a finished fill-forwards animation whose end is the element's own style lets go", async () => {
    await board(
      `<style>@keyframes in{from{opacity:0}to{opacity:1}}.f{animation:in 50ms forwards}</style><div class=f>hi</div>`,
    );
    await page.waitForTimeout(300);
    const left = await page.evaluate(
      () => document.getElementById("host")!.shadowRoot!.getAnimations().length,
    );
    expect(left).toBe(0);
  });

  test("tiny animations hold still, and come back where they'd be by now", async () => {
    await board(
      `<style>@keyframes spin{to{transform:rotate(1turn)}}.s{width:4px;height:4px;animation:spin 1s linear infinite}</style><div class=s></div>`,
    );
    // Started: its start time is set on its first frame.
    await frames(2);
    const r = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const lod = new w.pz.BoardDetail(root, w.motion);
      const start = root.getAnimations()[0]!.startTime;
      // Drawn at 1 device px per CSS px, the 4 px spinner is under STILL_PX.
      lod.update({ hidden: false, scale: 1, moving: false });
      const held = !!root.querySelector("[data-pz-still]");
      await new Promise((res) => setTimeout(res, 200));
      // Zoomed in, it goes again on the same timeline.
      lod.update({ hidden: false, scale: 8, moving: false });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const a = root.getAnimations()[0];
      return { held, back: !root.querySelector("[data-pz-still]"), same: a?.startTime === start };
    });
    expect(r).toEqual({ held: true, back: true, same: true });
  });
});
