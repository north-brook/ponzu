import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const seen: { browser?: Browser; page?: Page; density?: number; stalled: number } = {
      stalled: 0,
    };
    const renderer = new ChromiumRenderer({
      executablePath: chromium ?? undefined,
      assetsMs: opts.assetsMs,
      limits,
      preparePage: async (page: Page) => {
        seen.page = page;
        seen.browser = page.context().browser()!;
        // Device pixels per CSS pixel the page is held at.
        seen.density = await page.evaluate("devicePixelRatio");
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

    test("a node comes back at the scale asked, however big the board around it", async () => {
      // Hairlines a CSS pixel wide: each is four device pixels at 4x, and a
      // smear in an image stretched up from a lower scale.
      const hairlines = Array.from(
        { length: 64 },
        (_, i) => `<i style="width:1px;background:${i % 2 ? "#fff" : "#000"}"></i>`,
      ).join("");
      const page = (height: number) =>
        board(
          `<div data-id="n_logo" style="display:flex;width:64px;height:64px;margin:20px;flex-shrink:0">${hairlines}</div>
<div data-id="n_big" style="width:600px;height:600px;flex-shrink:0"></div>`,
          `width:1440px;height:${height}px`,
        );
      // A landing page: 1440×5200 is past the budget at 2x, let alone 4x.
      const ask = { tokens: "", nodeId: "n_logo", scale: 4 };
      const tall = await ordinary.render({ artboard: page(5200), ...ask });
      expect(tall.scale).toBe(4);
      expect(pngSize(tall.bytes)).toEqual({ width: 256, height: 256 });
      // Drawn at that scale, not stretched to it: the image a board that fits at 4x gives.
      const short = await ordinary.render({ artboard: page(900), ...ask });
      expect(Buffer.from(tall.bytes).equals(Buffer.from(short.bytes))).toBe(true);
      const jpeg = await ordinary.render({ artboard: page(5200), ...ask, format: "jpeg" });
      expect(jpeg).toMatchObject({ scale: 4, mime: "image/jpeg" });
      // A node too big for one image is held to the budget like a board is.
      const { renderer } = make({ maxPixels: 1_000_000 });
      const big = await renderer.render({
        artboard: page(5200),
        tokens: "",
        nodeId: "n_big",
        scale: 4,
      });
      expect(big.scale).toBe(1.666);
      expect(pngSize(big.bytes)).toEqual({ width: 1000, height: 1000 });
    });

    test("a board that grows when it is drawn at a lower density still comes back as an image", async () => {
      // 9000px tall on a dense screen, 30000px on any other. Held to the
      // budget by loading the page again at the scale that fit, it grew past
      // that scale too, and the render answered with no image at all.
      const dense = board(
        `<style>.hero { height: 9000px } @media (max-resolution: 1.5dppx) { .hero { height: 30000px } }</style>
<div data-id="n_hero" class="hero" style="flex-shrink:0"></div>`,
        "width:1440px;height:fit-content",
      );
      const out = await ordinary.render({ artboard: dense, tokens: "", scale: 2 });
      // Laid out once, at the density asked for; only the picture of it is smaller.
      expect(out.height).toBe(9000);
      expect(out.scale).toBe(1.36);
      expect(pngSize(out.bytes)).toEqual({ width: 1958, height: 12240 });
    });

    test("a recording's page is held to the budget too, and its frames come out the same", async () => {
      // 3000×2000 is over twice the budget at 1x; the frames and the sheet are inside it.
      const { renderer, seen } = make({ maxPixels: 2_400_000 });
      const moving = board(
        `<style>@keyframes go { to { transform: translateX(200px) } } .dot { animation: go 1s linear both }</style>
<div data-id="n_dot" class="dot" style="width:40px;height:40px;background:#f60"></div>`,
        "width:3000px;height:2000px",
      );
      const held = await renderer.record({ artboard: moving, tokens: "", nodeId: "n_dot" });
      expect(seen.density).toBeCloseTo(0.632, 5);
      const whole = await ordinary.record({ artboard: moving, tokens: "", nodeId: "n_dot" });
      // The same moments of the same area, at the same size, whatever the page was held at.
      expect(held.steps).toEqual(whole.steps);
      expect(held.box).toEqual(whole.box);
      expect(held.frames.map(pngSize)).toEqual(whole.frames.map(pngSize));
      expect(pngSize(held.bytes)).toEqual(pngSize(whole.bytes));
    });

    test("a job that runs past its time is stopped, and leaves no page or context behind", async () => {
      // Long enough for a loaded machine to launch Chrome and draw a plain board, far short of the assets' wait.
      const { renderer, seen } = make({ jobMs: 5_000 }, { assetsMs: 60_000 });
      const started = Date.now();
      const errors = await Promise.all(
        [1, 2].map((scale) =>
          renderer.render({ artboard: stalling, tokens: "", scale }).catch((e) => e),
        ),
      );
      expect(Date.now() - started).toBeLessThan(20_000);
      for (const err of errors) {
        expect(err).toBeInstanceOf(RenderError);
        expect(err).toMatchObject({ failure: "timeout" });
        expect(err.message).toBe("The render took too long (stopped after 5s).");
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

  test.skipIf(process.platform === "win32")(
    "a Chrome the kernel won't let sandbox its pages says so, and how to go without",
    async () => {
      // Stands in for Chrome where user namespaces are off: it gives up at
      // launch unless told not to sandbox.
      const dir = mkdtempSync(join(tmpdir(), "ponzu-chrome-"));
      const chrome = join(dir, "chrome");
      writeFileSync(
        chrome,
        `#!/bin/sh
case "$*" in
  *--no-sandbox*) echo "Started without a sandbox, and has nothing to draw with." >&2; exit 0 ;;
  *) echo "FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!" >&2; exit 1 ;;
esac
`,
      );
      chmodSync(chrome, 0o755);
      const draw = (sandbox?: boolean) => {
        const renderer = new ChromiumRenderer({ executablePath: chrome, sandbox });
        renderers.push(renderer);
        return renderer.render({ artboard: plain, tokens: "" }).catch((e) => e);
      };
      const before = process.env.PONZU_CHROMIUM_SANDBOX;
      try {
        delete process.env.PONZU_CHROMIUM_SANDBOX;
        const refused = await draw(true);
        expect(refused).toBeInstanceOf(RenderError);
        expect(refused.message).toStartWith("Chrome can't sandbox its pages on this machine");
        expect(refused.message).toContain("PONZU_CHROMIUM_SANDBOX=0");
        expect(refused.message).toContain("`sandbox: false`");
        // Not the launch log it came from.
        expect(refused.message).not.toContain("zygote");
        // The variable is the way out for a caller that can't pass an option. It
        // gets Chrome started; this one just can't draw.
        process.env.PONZU_CHROMIUM_SANDBOX = "0";
        const started = await draw();
        expect(started).toBeInstanceOf(Error);
        expect(started.message).not.toContain("sandbox its pages");
        // An option given in code still decides.
        expect((await draw(true)).message).toContain("sandbox its pages");
      } finally {
        if (before === undefined) delete process.env.PONZU_CHROMIUM_SANDBOX;
        else process.env.PONZU_CHROMIUM_SANDBOX = before;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
    const MB = 1024 * 1024;
    /** How much of its big files the server has been asked to send. */
    let streamed = 0;
    const chunk = new Uint8Array(MB);
    /** `bytes` of nothing in particular, sent as fast as they are taken. */
    const stream = (bytes: number) => {
      let left = bytes;
      return new ReadableStream({
        pull(controller) {
          if (left <= 0) return controller.close();
          const size = Math.min(left, chunk.length);
          controller.enqueue(chunk.subarray(0, size));
          left -= size;
          streamed += size;
        },
      });
    };
    // A dev server as they come: no CORS headers on its static files.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        requests.push(`${req.headers.get("host")}${pathname}`);
        // A product video, where a dev server keeps them.
        if (pathname === "/demo.mp4")
          return new Response(stream(300 * MB), {
            headers: { "content-type": "video/mp4", "content-length": String(300 * MB) },
          });
        // A response that says no length and never ends.
        if (pathname === "/endless.png")
          return new Response(stream(Number.POSITIVE_INFINITY), {
            headers: { "content-type": "image/png" },
          });
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
      // An image that asks for CORS, as every font does, gets the header the dev server didn't send.
      const cors = await renderer.render({
        artboard: board(
          `<img data-id="n_cors" crossorigin="anonymous" src="http://${local}/pixel.png" style="width:20px;height:20px">`,
        ),
        tokens: "",
        lint: true,
      });
      expect(assetIssues(cors.issues)).toEqual([]);
    });

    /**
     * Draws `heavy` with a plain board beside it. Resolves with both results,
     * how much this process grew while they drew, and how much of its big
     * files the server went on sending once they were done.
     */
    async function beside(
      renderer: ChromiumRenderer,
      heavy: Parameters<typeof renderer.render>[0],
    ) {
      await renderer.render({ artboard: plain, tokens: "" });
      streamed = 0;
      const before = process.memoryUsage().rss;
      let peak = before;
      const watch = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 20);
      try {
        const [out, other] = await Promise.all([
          renderer.render(heavy),
          renderer.render({ artboard: plain, tokens: "" }),
        ]);
        // A moment for the server to hear that its connections have closed.
        await Bun.sleep(300);
        const sent = streamed;
        await Bun.sleep(500);
        return { out, other, grewMB: (peak - before) / MB, sentAfterMB: (streamed - sent) / MB };
      } finally {
        clearInterval(watch);
      }
    }
    const heavyBody = (base: string) =>
      `<video data-id="n_video" src="${base}demo.mp4" style="width:100px;height:100px"></video>
<img data-id="n_endless" src="${base}endless.png" style="width:20px;height:20px">
<p data-id="n_p">Beside a video</p>`;

    test("with loopback on, a video and a response that never ends cost this process nothing", async () => {
      const renderer = new ChromiumRenderer({
        executablePath: chromium ?? undefined,
        loopback: true,
        assetsMs: 3_000,
      });
      renderers.push(renderer);
      const { out, other, grewMB, sentAfterMB } = await beside(renderer, {
        artboard: board(heavyBody(`http://${local}/`)),
        tokens: "",
        lint: true,
      });
      expect(pngSize(out.bytes)).toEqual({ width: 400, height: 300 });
      expect(pngSize(other.bytes)).toEqual({ width: 400, height: 300 });
      // Chrome loads them itself, in pieces. Held here on their way to it,
      // 300 MB of video took this process past a gigabyte.
      expect(grewMB).toBeLessThan(150);
      // And the page gone, nothing is still being read.
      expect(sentAfterMB).toBe(0);
    });

    test("what is fetched from here for a page is refused past a size, and stops with the page", async () => {
      // No loopback: the asset base is a server on this machine, so every file comes through this process.
      const renderer = new ChromiumRenderer({
        executablePath: chromium ?? undefined,
        assetBase: `http://${local}`,
        assetsMs: 3_000,
      });
      renderers.push(renderer);
      const { out, other, grewMB, sentAfterMB } = await beside(renderer, {
        artboard: board(
          `<img data-id="n_video" src="demo.mp4" style="width:20px;height:20px">
<img data-id="n_endless" src="endless.png" style="width:20px;height:20px">
<img data-id="n_img" src="pixel.png" style="width:20px;height:20px">`,
        ),
        tokens: "",
        lint: true,
      });
      // Both are refused, one by the length it states and one once it passes the limit, and lint says so.
      expect(assetIssues(out.issues).sort()).toEqual(["n_endless", "n_video"]);
      expect(out.assetsTimedOut).toBeUndefined();
      expect(pngSize(other.bytes)).toEqual({ width: 400, height: 300 });
      // 25 MB of the endless one was read before it was dropped, the server
      // having queued some more behind it, and nothing after.
      expect(streamed / MB).toBeLessThan(200);
      expect(grewMB).toBeLessThan(250);
      expect(sentAfterMB).toBe(0);
    });

    test("a smaller limit on fetched assets is honoured", async () => {
      const renderer = new ChromiumRenderer({
        executablePath: chromium ?? undefined,
        assetBase: `http://${local}`,
        limits: { maxAssetBytes: 10 },
      });
      renderers.push(renderer);
      // The 68-byte pixel that loaded under the default limit.
      const out = await renderer.render({
        artboard: board(`<img data-id="n_img" src="pixel.png" style="width:20px;height:20px">`),
        tokens: "",
        lint: true,
      });
      expect(assetIssues(out.issues)).toEqual(["n_img"]);
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
