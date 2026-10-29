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

  test("an SVG whose parts point at another SVG on the board stays live", async () => {
    const uses = Array.from(
      { length: 60 },
      (_, i) => `<use class=r href="#shared" x="${(i % 10) * 20}" y="${Math.floor(i / 10) * 20}"/>`,
    ).join("");
    await board(
      `<style>@keyframes r{to{transform:rotate(60deg)}}.r{animation:r 2s infinite}</style><svg width=0 height=0 style="position:absolute"><defs><circle id=shared r=8 cx=8 cy=8 fill="#fc3"/></defs></svg><svg viewBox="0 0 200 120" width=400 height=240 style="overflow:hidden">${uses}</svg>`,
    );
    await frames(6);
    const state = await page.evaluate(() => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      return {
        image: !!root.querySelector("[data-pz-field]"),
        running: w.motion.running.size as number,
      };
    });
    // Drawn as an image it would lose the circle, and the grid would vanish.
    expect(state.image).toBe(false);
    expect(state.running).toBe(60);
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

  /** Detail as the canvas gives it on mounting: in the same task as Motion takes the board. */
  const mounted = (html: string, scale = 2) =>
    page.evaluate(
      ({ html, scale }) => {
        const w = window as any;
        const host = document.getElementById("host")!;
        const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        w.motion?.dispose();
        root.innerHTML = `<style data-pz-base>${w.pz.MOTION_CSS}${w.pz.STILL_CSS}</style><section data-artboard style="width:400px">${html}</section>`;
        w.motion = new w.pz.Motion(root);
        w.motion.reset();
        w.lod = new w.pz.BoardDetail(root, w.motion);
        w.lod.update({ hidden: false, scale, moving: false });
        return root.querySelectorAll("[data-pz-still]").length as number;
      },
      { html, scale },
    );
  /** Each `sel` element's computed `prop`, now and twice more 300 ms apart. */
  const over = (sel: string, prop: string) =>
    page.evaluate(
      async ({ sel, prop }) => {
        const root = document.getElementById("host")!.shadowRoot!;
        const read = () =>
          [...root.querySelectorAll(sel)].map((e) => getComputedStyle(e).getPropertyValue(prop));
        const out = [read()];
        for (let i = 0; i < 2; i++) {
          await new Promise((r) => setTimeout(r, 300));
          out.push(read());
        }
        return out;
      },
      { sel, prop },
    );

  test("a loop on SVG parts that grows from nothing, in a box that pops in from nothing, plays", async () => {
    const petals = Array.from(
      { length: 6 },
      (_, i) =>
        `<path style="--i:${i}" d="M32 32 L32 8 A6 6 0 0 1 38 14 Z" transform="rotate(${i * 60} 32 32)"/>`,
    ).join("");
    const held = await mounted(
      `<style>@keyframes pop{from{opacity:0;scale:0}}@keyframes bloom{0%{scale:0;rotate:-40deg}50%{scale:1;rotate:0deg}100%{scale:0;rotate:40deg}}.p{animation:pop .5s both}path{fill:red;transform-box:view-box;transform-origin:32px 32px;animation:bloom 1.6s ease-in-out calc(var(--i) * 50ms) both infinite}</style><div class=p><svg viewBox="0 0 64 64" width="64" height="64">${petals}</svg></div>`,
    );
    expect(held).toBe(0);
    const [a, b, c] = await over("path", "scale");
    expect(a!.join() !== b!.join() && b!.join() !== c!.join()).toBe(true);
  });

  test("a part that draws in after a delay, in a box that pops in from nothing, waits for it", async () => {
    const held = await mounted(
      `<style>@keyframes pop{from{opacity:0;scale:0}}@keyframes draw{from{stroke-dashoffset:30;opacity:0}}.p{animation:pop .4s both}.ck{fill:none;stroke:green;stroke-width:3;stroke-dasharray:30;animation:draw .4s .8s both}</style><div class=p><svg viewBox="0 0 24 24" width="24" height="24"><path class=ck d="M4 12 L10 18 L20 6"/></svg></div>`,
    );
    expect(held).toBe(0);
    // The box has popped in; the check's own delay hasn't passed.
    const [, before] = await over(".ck", "opacity");
    expect(before).toEqual(["0"]);
  });

  test("an HTML loop that grows from nothing plays", async () => {
    expect(
      await mounted(
        `<style>@keyframes grow{0%{scale:0}50%{scale:1}100%{scale:0}}.g{width:40px;height:40px;background:red;animation:grow 1.6s infinite}</style><div class=g></div>`,
      ),
    ).toBe(0);
  });

  test("a zero-size wrapper spinning its parts around it plays", async () => {
    expect(
      await mounted(
        `<style>@keyframes spin{to{rotate:1turn}}.o{position:relative;width:0;height:0;margin:60px;animation:spin 2s linear infinite}.o i{position:absolute;left:40px;width:16px;height:16px;background:red}</style><div class=o><i></i></div>`,
      ),
    ).toBe(0);
  });

  test("a loop caught near nothing on a later update plays", async () => {
    // Mounted hidden (a picture) and made ahead of time, then drawn live, zoomed in, a few cycles on.
    const held = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      w.motion?.dispose();
      root.innerHTML = `<style data-pz-base>${w.pz.MOTION_CSS}${w.pz.STILL_CSS}</style><section data-artboard style="width:400px;content-visibility:hidden"><style>@keyframes grow{0%{scale:0}50%{scale:1}100%{scale:0}}svg *{transform-box:view-box;transform-origin:32px 32px;animation:grow 1.6s calc(var(--i) * 50ms) both infinite}</style><svg viewBox="0 0 64 64" width="64" height="64">${Array.from({ length: 6 }, (_, i) => `<circle style="--i:${i}" cx="${12 + i * 8}" cy="32" r="4"/>`).join("")}</svg></section>`;
      w.motion = new w.pz.Motion(root);
      w.motion.reset();
      const lod = new w.pz.BoardDetail(root, w.motion);
      lod.update({ hidden: true, scale: 2, moving: false });
      w.motion.warm();
      root.querySelector<HTMLElement>("[data-artboard]")!.style.contentVisibility = "";
      // A later cycle's start, where every part has shrunk to nothing.
      for (const a of root.getAnimations())
        a.currentTime = 1600 + Number((a.effect as KeyframeEffect).getTiming().delay);
      lod.update({ hidden: false, scale: 16, moving: false });
      return root.querySelectorAll("[data-pz-still]").length;
    });
    expect(held).toBe(0);
  });

  test("a busy board freezes where it is over a crowded pan, and goes on from there", async () => {
    const dots = Array.from({ length: 70 }, () => "<i class=d></i>").join("");
    await board(
      `<style>@keyframes slide{to{transform:translateX(100px)}}.d{display:block;width:20px;height:20px;animation:slide 1s linear infinite}.d::after{content:"";display:block;width:10px;height:10px;animation:slide 1s linear infinite}</style>${dots}`,
    );
    await frames(2);
    const r = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const lod = new w.pz.BoardDetail(root, w.motion);
      const el = root.querySelector(".d")!;
      const x = (pseudo?: string) => new DOMMatrix(getComputedStyle(el, pseudo).transform).e;
      // Only a crowded view holds: a pan over a few boards keeps them moving.
      lod.update({ hidden: false, scale: 1, moving: true });
      const free = !root.querySelector("[data-pz-still]");
      await new Promise((res) => setTimeout(res, 200));
      const at = [x(), x("::after")];
      lod.update({ hidden: false, scale: 1, moving: true, hold: true });
      const pinned = [x(), x("::after")];
      const none = root
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect).target === el).length;
      await new Promise((res) => setTimeout(res, 200));
      const later = [x(), x("::after")];
      // The camera stops: it goes on from the frame it froze at.
      lod.update({ hidden: false, scale: 1, moving: false });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const a = root.getAnimations().find((a) => (a.effect as KeyframeEffect).target === el)!;
      return {
        free,
        frozen: Math.abs(pinned[0]! - at[0]!) < 5 && Math.abs(pinned[1]! - at[1]!) < 5,
        none,
        still: later[0] === pinned[0] && later[1] === pinned[1],
        back: !root.querySelector("[data-pz-still],[data-pz-pin]"),
        from: Math.abs((Number(a.currentTime) % 1000) - pinned[0]! * 10) < 60,
      };
    });
    expect(r).toEqual({ free: true, frozen: true, none: 0, still: true, back: true, from: true });
  });

  test("a frozen element zoomed out to tiny shows its own style, not the frame it froze at", async () => {
    const dots = Array.from({ length: 70 }, () => "<i class=d></i>").join("");
    await board(
      `<style>@keyframes slide{to{transform:translateX(100px)}}.d{display:block;width:20px;height:20px;animation:slide 1s linear infinite}</style>${dots}`,
    );
    await frames(2);
    const r = await page.evaluate(async () => {
      const w = window as any;
      const root = document.getElementById("host")!.shadowRoot!;
      const lod = new w.pz.BoardDetail(root, w.motion);
      const el = root.querySelector(".d")!;
      await new Promise((res) => setTimeout(res, 200));
      lod.update({ hidden: false, scale: 1, moving: true, hold: true });
      const pinned = getComputedStyle(el).transform !== "none";
      // The zoom ends with the 20 px dots at 5 device px: under STILL_PX.
      lod.update({ hidden: false, scale: 0.25, moving: false });
      return {
        pinned,
        held: el.hasAttribute("data-pz-still"),
        unpinned: !root.querySelector("[data-pz-pin]"),
        own: getComputedStyle(el).transform,
      };
    });
    expect(r).toEqual({ pinned: true, held: true, unpinned: true, own: "none" });
  });
});
