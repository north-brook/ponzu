import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtboardFile } from "@ponzu/core";
import type { Browser, Page } from "playwright-core";
import { ChromiumRenderer, findChromium, type RenderLimits } from "./chromium.ts";
import { RenderError } from "./stages.ts";

const chromium = findChromium();
setDefaultTimeout(30_000);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const FONT = readFileSync(join(import.meta.dir, "fixtures/instrument-serif-ferns.woff2"));

const board = (body: string, style = "width:400px;height:300px") =>
  parseArtboardFile(
    `<section data-artboard data-id="ab_c" data-name="Board" style="${style}">${body}</section>`,
    { id: "ab_c", name: "Board" },
  ).artboard;
const plain = board(`<p data-id="n_p">Plain</p>`);
/** An image that never arrives: its render sits in the assets stage until that runs out. */
const stalling = board(`<img data-id="n_img" src="https://stall.test/never.png">`);

/** The size of a PNG, from its header. */
const pngSize = (bytes: Uint8Array) => {
  const png = Buffer.from(bytes);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

describe.skipIf(!chromium)("the Chromium renderer", () => {
  const renderers: ChromiumRenderer[] = [];
  afterAll(() => Promise.all(renderers.map((r) => r.close())), 30_000);

  /** A renderer, and the latest page it opened with the browser that page is in. */
  function make(limits: Partial<RenderLimits> = {}, opts: { assetsMs?: number } = {}) {
    const seen: { browser?: Browser; page?: Page; stalled: number } = { stalled: 0 };
    const renderer = new ChromiumRenderer({
      executablePath: chromium ?? undefined,
      assetsMs: opts.assetsMs,
      limits,
      preparePage: async (page: Page) => {
        seen.page = page;
        seen.browser = page.context().browser()!;
        // Never answered: a render that asks for one sits waiting on its assets.
        await page.route("https://stall.test/**", () => {
          seen.stalled++;
          return new Promise(() => {});
        });
      },
    });
    renderers.push(renderer);
    return { renderer, seen };
  }

  /** One with nothing special about it, for the tests that need no more. */
  const ordinary = make().renderer;

  /** Kills Chrome's main process, as a crash or the kernel's out-of-memory killer would. */
  async function kill(browser: Browser): Promise<void> {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    process.kill(processInfo.find((p) => p.type === "browser")!.id, "SIGKILL");
  }

  const openPages = (browser: Browser) => browser.contexts().flatMap((c) => c.pages()).length;

  async function until(done: () => boolean, ms = 5_000): Promise<void> {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(done()).toBe(true);
  }

  describe("when Chrome dies", () => {
    // One renderer through every death, as the one in a sandbox has to live through them.
    const { renderer, seen } = make({}, { assetsMs: 20_000 });

    test("between renders, the next one starts a new browser", async () => {
      await renderer.render({ artboard: plain, tokens: "" });
      const first = seen.browser!;
      await kill(first);
      // Straight away, without waiting to hear that it's gone: the job finds out for itself.
      const out = await renderer.render({ artboard: plain, tokens: "" });
      expect(pngSize(out.bytes)).toEqual({ width: 400, height: 300 });
      expect(seen.browser).not.toBe(first);
      expect(first.isConnected()).toBe(false);
    });

    test("during a render, that render fails saying so and the next succeeds", async () => {
      await renderer.measure({ artboard: plain, tokens: "", ids: ["n_p"] });
      const first = seen.browser!;
      seen.stalled = 0;
      // One at each device scale, so a page in the shared context and one in its own both go.
      const inFlight = [1, 2].map((scale) =>
        renderer.render({ artboard: stalling, tokens: "", scale }).catch((e) => e),
      );
      await until(() => seen.stalled === 2);
      await kill(first);
      for (const err of await Promise.all(inFlight)) {
        expect(err).toBeInstanceOf(RenderError);
        expect(err).toMatchObject({ failure: "render_error" });
        expect(err.message).toContain("The browser drawing this stopped partway");
      }
      const out = await renderer.record({ artboard: plain, tokens: "" });
      expect(out.steps).toHaveLength(1);
      expect(seen.browser).not.toBe(first);
    });

    test("a page that crashes fails alone, and the browser carries on", async () => {
      await renderer.render({ artboard: plain, tokens: "" });
      const browser = seen.browser!;
      seen.stalled = 0;
      const inFlight = renderer.render({ artboard: stalling, tokens: "" }).catch((e) => e);
      await until(() => seen.stalled === 1);
      // What running out of memory usually takes: the page's own process, not Chrome itself.
      const cdp = await seen.page!.context().newCDPSession(seen.page!);
      cdp.send("Page.crash").catch(() => {});
      const err = await inFlight;
      expect(err).toBeInstanceOf(RenderError);
      expect(err.message).toContain("The browser drawing this stopped partway");
      await renderer.render({ artboard: plain, tokens: "" });
      expect(seen.browser).toBe(browser);
      expect(browser.isConnected()).toBe(true);
    });
  });

  describe("limits", () => {
    test("an image past the pixel budget comes back at the largest scale that fits", async () => {
      const { renderer } = make({ maxPixels: 1_000_000 });
      // 1000×800 at 2x is 3.2 million pixels.
      const wide = board(
        `<div data-id="n_d" style="height:100px"></div>`,
        "width:1000px;height:800px",
      );
      const out = await renderer.render({ artboard: wide, tokens: "", scale: 2 });
      expect(out.scale).toBe(1.118);
      expect(pngSize(out.bytes)).toEqual({ width: 1118, height: 894 });
      // What fits is left alone.
      expect((await renderer.render({ artboard: wide, tokens: "", scale: 1 })).scale).toBe(1);
      // A board that grows past its viewport is held to the budget once it's measured.
      const tall = board(
        `<div data-id="n_t" style="height:3200px;flex-shrink:0"></div>`,
        "width:500px;height:fit-content",
      );
      const grown = await renderer.render({ artboard: tall, tokens: "", scale: 1 });
      expect(grown.height).toBe(3200);
      expect(grown.scale).toBe(0.79);
      expect(pngSize(grown.bytes)).toEqual({ width: 395, height: 2528 });
      // Measuring a board whose viewport is past the budget draws it small, and reads the same.
      const huge = board(
        `<div data-id="n_h" style="height:250px;margin:10px 30px"></div>`,
        "width:1000px;height:4000px",
      );
      const { boxes } = await renderer.measure({
        artboard: huge,
        tokens: "",
        ids: ["ab_c", "n_h"],
      });
      expect(boxes.ab_c).toMatchObject({ width: 1000, height: 4000 });
      expect(boxes.n_h).toMatchObject({ x: 30, y: 10, width: 940, height: 250 });
    });

    test("a job that runs past its time is stopped, and leaves no page or context behind", async () => {
      const { renderer, seen } = make({ jobMs: 600 }, { assetsMs: 20_000 });
      const started = Date.now();
      const errors = await Promise.all(
        [1, 2].map((scale) =>
          renderer.render({ artboard: stalling, tokens: "", scale }).catch((e) => e),
        ),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      for (const err of errors) {
        expect(err).toBeInstanceOf(RenderError);
        expect(err).toMatchObject({ failure: "timeout" });
        expect(err.message).toBe("The render took too long (stopped after 1s).");
      }
      const browser = seen.browser!;
      expect(openPages(browser)).toBe(0);
      // Only the shared context: the 2x job's own went with it.
      expect(browser.contexts()).toHaveLength(1);
      expect((await renderer.render({ artboard: plain, tokens: "" })).bytes.length).toBeGreaterThan(
        0,
      );
    });

    test("jobs past the concurrency limit wait their turn, and not for ever", async () => {
      const { renderer, seen } = make({ concurrency: 1, queueMs: 300 }, { assetsMs: 1_500 });
      await renderer.render({ artboard: plain, tokens: "" });
      const slow = renderer.render({ artboard: stalling, tokens: "" });
      const busy = await renderer.render({ artboard: plain, tokens: "" }).catch((e) => e);
      expect(busy).toMatchObject({ failure: "host_busy", stage: "queue" });
      // The one ahead of it was never more than one page.
      expect(openPages(seen.browser!)).toBe(1);
      expect((await slow).assetsTimedOut).toBe(true);
      // Its turn over, the next job gets one.
      const next = await renderer.measure({ artboard: plain, tokens: "", ids: ["n_p"] });
      expect(next.boxes.n_p).not.toBeNull();
    });

    test("a browser nothing is drawing in closes, and the next render starts another", async () => {
      const { renderer, seen } = make({ idleMs: 150 });
      await renderer.render({ artboard: plain, tokens: "" });
      const first = seen.browser!;
      await until(() => !first.isConnected());
      const out = await renderer.render({ artboard: plain, tokens: "" });
      expect(pngSize(out.bytes)).toEqual({ width: 400, height: 300 });
      expect(seen.browser).not.toBe(first);
    });
  });

  test("renders after this process has spawned children", async () => {
    // Under Bun, a page filled with setContent could leave evaluate waiting
    // for ever once the process had children; pages are navigated to instead.
    // A sandbox's runner always has children: a dev server, git, the agent.
    const kids = [
      Bun.spawn(["sleep", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(["sleep", "30"]),
    ];
    try {
      for (let i = 0; i < 3; i++) await Bun.spawn(["true"]).exited;
      for (let i = 0; i < 8; i++) {
        const artboard = board(`<p data-id="n_p" style="width:${100 + i}px">Round ${i}</p>`);
        const out = await ordinary.measure({ artboard, tokens: "", ids: ["n_p"] });
        expect(out.boxes.n_p?.width).toBe(100 + i);
        if (i % 4 === 0) await Bun.spawn(["true"]).exited;
      }
    } finally {
      for (const kid of kids) kid.kill();
    }
  });

  describe("where assets load from", () => {
    const requests: string[] = [];
    // A dev server as they come: no CORS headers on its static files.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const { pathname } = new URL(req.url);
        requests.push(`${req.headers.get("host")}${pathname}`);
        if (pathname === "/site.css")
          return new Response(".wide { width: 321px; }", {
            headers: { "content-type": "text/css" },
          });
        if (pathname === "/pixel.png")
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        if (pathname === "/serif.woff2") {
          // Not instant, like a dev server compiling: the artboard's own
          // @font-face loads a second time once the page is held to be drawn,
          // and the capture has to wait for that one too.
          await Bun.sleep(200);
          return new Response(FONT, { headers: { "content-type": "font/woff2" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    afterAll(() => server.stop(true));
    const local = `127.0.0.1:${server.port}`;
    const named = `localhost:${server.port}`;
    const page = board(
      `<style>@font-face { font-family: "Dev Serif"; src: url(http://${named}/serif.woff2) format("woff2"); }</style>
<img data-id="n_img" src="http://${local}/pixel.png" style="width:20px;height:20px">
<div data-id="n_wide" class="wide" style="height:10px"></div>
<p data-id="n_text" style="font-family:'Dev Serif', monospace">Ferns</p>`,
    );
    const tokens = `@import url("http://${named}/site.css");`;
    const assetIssues = (issues: { kind: string; id: string }[]) =>
      issues.filter((i) => i.kind === "broken-image" || i.kind === "missing-font").map((i) => i.id);

    test("a design can't reach servers on this machine unless the renderer is told it may", async () => {
      requests.length = 0;
      const out = await ordinary.render({ artboard: page, tokens, lint: true });
      // Chrome refuses a public page's requests to this machine before they are sent.
      expect(requests).toEqual([]);
      expect(assetIssues(out.issues).sort()).toEqual(["n_img", "n_text"]);
    });

    test("with loopback on, images, stylesheets and fonts load from localhost and 127.0.0.1", async () => {
      requests.length = 0;
      const renderer = new ChromiumRenderer({
        executablePath: chromium ?? undefined,
        loopback: true,
      });
      renderers.push(renderer);
      const out = await renderer.render({ artboard: page, tokens, lint: true });
      expect(assetIssues(out.issues)).toEqual([]);
      expect([...new Set(requests)].sort()).toEqual([
        `${local}/pixel.png`,
        `${named}/serif.woff2`,
        `${named}/site.css`,
      ]);
      const { boxes } = await renderer.measure({ artboard: page, tokens, ids: ["n_wide"] });
      expect(boxes.n_wide?.width).toBe(321);
    });

    test("an asset base on this machine is fetched from here, with or without loopback", async () => {
      requests.length = 0;
      const out = await ordinary.render({
        artboard: board(`<img data-id="n_img" src="pixel.png" style="width:20px;height:20px">`),
        tokens: "",
        lint: true,
        assetBase: `http://${local}`,
      });
      expect(assetIssues(out.issues)).toEqual([]);
      expect(requests).toEqual([`${local}/pixel.png`]);
    });

    test("a remote https asset base with a key in its path is loaded by Chrome itself", async () => {
      // As the cloud serves a design's files: the path is the capability.
      const assetBase = "https://assets.ponzu.test/k3y-9fQ2xLr7";
      const asked: string[] = [];
      const renderer = new ChromiumRenderer({
        executablePath: chromium ?? undefined,
        assetBase,
        preparePage: async (p: Page) => {
          // Stands in for the asset host. Chrome's request reaches it only if
          // the renderer leaves that request alone: one it fetched from here
          // itself would go to the real network and fail.
          await p.route("https://assets.ponzu.test/**", (route) => {
            const url = new URL(route.request().url());
            asked.push(url.pathname);
            const cors = { "access-control-allow-origin": "*" };
            if (url.pathname === "/k3y-9fQ2xLr7/assets/pixel.png")
              return route.fulfill({
                status: 200,
                contentType: "image/png",
                body: PNG,
                headers: cors,
              });
            if (url.pathname === "/k3y-9fQ2xLr7/assets/serif.woff2")
              return route.fulfill({
                status: 200,
                contentType: "font/woff2",
                body: FONT,
                headers: cors,
              });
            return route.fulfill({ status: 404, body: "Not found" });
          });
        },
      });
      renderers.push(renderer);
      const artboard = board(
        `<img data-id="n_img" src="assets/pixel.png" style="width:20px;height:20px">
<p data-id="n_text" style="font-family:'Brand', monospace">Ferns</p>`,
      );
      const brand = `@font-face { font-family: "Brand"; src: url(assets/serif.woff2) format("woff2"); }`;
      const out = await renderer.render({ artboard, tokens: brand, lint: true, scale: 2 });
      expect(assetIssues(out.issues)).toEqual([]);
      expect(asked.sort()).toEqual([
        "/k3y-9fQ2xLr7/assets/pixel.png",
        "/k3y-9fQ2xLr7/assets/serif.woff2",
      ]);
      const sized = await renderer.measure({ artboard, tokens: brand, ids: ["n_img"] });
      expect(sized.boxes.n_img).toMatchObject({ width: 20, height: 20 });
    });
  });
});
