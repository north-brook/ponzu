import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Browser, Page, Route } from "playwright-core";
import { BrowserProcess } from "./browser.ts";
import { captureScale, IMAGES_READY_SCRIPT, MAX_CAPTURE_PX } from "./capture.ts";
import { artboardPage, cssPx } from "./document.ts";
import { linuxFonts } from "./linux-fonts.ts";
import { filmLoops, type LoopRequest, type LoopResult } from "./loop.ts";
import {
  type FrameDriver,
  FULL_LINT_SCRIPT,
  type MotionInfo,
  prepareScript,
  recordFrames,
} from "./motion.ts";
import { JobQueue } from "./queue.ts";
import {
  type LintIssue,
  type MeasureRequest,
  type MeasureResult,
  measureScript,
  type RecordRequest,
  type RecordResult,
  type Renderer,
  type RenderRequest,
  type RenderResult,
} from "./renderer.ts";
import { RenderError, STAGE_BUDGET_MS, stalled, withBudget, within } from "./stages.ts";

/** What one renderer may use of the machine it runs on. */
export interface RenderLimits {
  /** Jobs drawing at once. Each is a page in Chrome; the rest wait in line. */
  concurrency: number;
  /** How long a job waits in line before it fails as busy, in ms. */
  queueMs: number;
  /** How long a job may run before it is stopped and its page closed, in ms. */
  jobMs: number;
  /**
   * Device pixels in one image, and in the page's viewport at the scale it is
   * drawn at. An ask for more comes back at the largest scale that fits, with
   * that scale in the result.
   */
  maxPixels: number;
  /** How long a browser stays open with nothing to draw, in ms. */
  idleMs: number;
}

/**
 * Sized for a 4 GB sandbox that also runs a dev server and an agent. Chrome
 * holds about 20 bytes for each device pixel of an image while it captures
 * it, so a job at the pixel limit takes close to 500 MB over an idle
 * browser's 150 MB, and two of them at once stay near 1.1 GB. 24 million
 * pixels is a 1440×900 board at 4x, or a 1440×4000 page at 2x.
 */
export const DEFAULT_LIMITS: RenderLimits = {
  concurrency: 2,
  queueMs: STAGE_BUDGET_MS.queue,
  jobMs: 60_000,
  maxPixels: 24_000_000,
  idleMs: 120_000,
};

export interface ChromiumOptions {
  /** Path to a Chrome or Chromium binary. Found automatically when omitted. */
  executablePath?: string;
  /**
   * A browser Playwright finds itself, used when there's no `executablePath`.
   * "chromium-headless-shell" and "chromium" are the builds this version of
   * playwright-core is pinned to (`playwright-core install` downloads them);
   * "chrome" is the machine's own Google Chrome.
   */
  channel?: string;
  /**
   * Chromium's own sandbox around the pages it draws. On unless this runs as
   * root, which Chrome refuses to sandbox. Turn it off only where the kernel
   * won't allow it (a container without user namespaces).
   */
  sandbox?: boolean;
  /** More command-line switches for Chrome, after the renderer's own. */
  args?: string[];
  /** Base URL for relative asset paths, usually the server's /assets route. */
  assetBase?: string;
  /**
   * Lets a design load from servers on this machine (http://localhost:3000,
   * 127.0.0.1, [::1]): the repo's dev server, in a sandbox. Off by default,
   * because on a person's own computer a design could then reach whatever
   * they have listening locally.
   */
  loopback?: boolean;
  /** Runs on each new page before the artboard loads, e.g. to route its requests in tests. */
  preparePage?: (page: Page) => Promise<void>;
  /** How long fonts and images may take, so tests of one that never arrives needn't wait the full budget. */
  assetsMs?: number;
  limits?: Partial<RenderLimits>;
}

/**
 * Renders with a headless Chromium: the one at `executablePath` or `channel`,
 * or else a Chrome, Edge, Brave or Chromium already on the machine. It keeps
 * one browser open while there is work, in a queue that bounds how much runs
 * at once.
 */
export class ChromiumRenderer implements Renderer {
  private limits: RenderLimits;
  private queue: JobQueue;
  private main: BrowserProcess;
  /**
   * Filming gets a browser of its own, launched when first needed: without a
   * frame rate limit a capture takes 13-25 ms instead of waiting for the next
   * frame at 30 fps, which halves filming time. Screenshots keep paced frames.
   */
  private film: BrowserProcess;

  constructor(private opts: ChromiumOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.queue = new JobQueue(this.limits.concurrency, this.limits.queueMs);
    this.main = new BrowserProcess(
      // Headless Chrome on Linux has no GPU to draw with, on a desktop or in
      // a VM, and stands one in with GL emulated on the CPU. Compositing in
      // plain software instead halves the time a full Chrome takes to draw a
      // page there. (The headless shell does that anyway.)
      () => this.launch(platform() === "linux" ? ["--disable-gpu"] : []),
      this.limits.idleMs,
    );
    this.film = new BrowserProcess(
      () =>
        this.launch([
          // Render pages are served at this origin; secure, they get WebCodecs to encode.
          `--unsafely-treat-insecure-origin-as-secure=${RENDER_ORIGIN}`,
          "--disable-frame-rate-limit",
          "--disable-gpu-vsync",
        ]),
      this.limits.idleMs,
    );
  }

  private async launch(extra: string[]): Promise<Browser> {
    const { channel } = this.opts;
    const executablePath = this.opts.executablePath ?? (channel ? undefined : findChromium());
    if (!executablePath && !channel) {
      throw new Error(
        "No Chrome or Chromium found for screenshots. Install Google Chrome, or set PONZU_CHROMIUM to a Chromium binary.",
      );
    }
    const { chromium } = await import("playwright-core");
    const fonts = platform() === "linux" ? linuxFonts() : null;
    return chromium.launch({
      ...(executablePath ? { executablePath } : { channel }),
      headless: true,
      // Playwright turns the sandbox off unless told to keep it.
      chromiumSandbox: this.opts.sandbox ?? process.getuid?.() !== 0,
      args: [
        "--hide-scrollbars",
        "--font-render-hinting=none",
        ...(fonts?.args ?? []),
        ...extra,
        ...(this.opts.args ?? []),
      ],
      ...(fonts && { env: { ...definedEnv(), ...fonts.env } }),
    });
  }

  /**
   * One job: its turn in the queue, a page of its own, and no longer than
   * `ms`. The page is closed however the job ends, one that finished opening
   * after the job gave up on it included.
   */
  private job<T>(
    browser: BrowserProcess,
    scale: number,
    work: (page: Page) => Promise<T>,
    ms = this.limits.jobMs,
  ): Promise<T> {
    return this.queue.run(async () => {
      const opening = browser.open(scale);
      try {
        return await deadline(
          opening.then((lease) =>
            work(lease.page).catch((err) => {
              throw lease.explain(err);
            }),
          ),
          ms,
        );
      } finally {
        await opening.then(
          (lease) => lease.close(),
          () => {},
        );
      }
    });
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const out = await this.renderAt(req, this.pageScale(req.artboard, req.scale));
    // Too big to draw at that scale: again, at the largest that fits.
    return "retry" in out ? ((await this.renderAt(req, out.retry)) as RenderResult) : out;
  }

  /**
   * The device scale to load an artboard's page at: the one asked for, or
   * less when its viewport would be past the pixel budget. Chrome holds the
   * whole viewport at the device scale whether or not it is captured, so a
   * big board is held to the budget before it loads, not only once measured.
   */
  private pageScale(artboard: RenderRequest["artboard"], scale: number | undefined): number {
    const view = viewportOf(artboard);
    return captureScale(
      view.width,
      view.height,
      scale,
      Number.POSITIVE_INFINITY,
      this.limits.maxPixels,
    );
  }

  /**
   * Renders at `scale` device pixels per CSS pixel, or says which smaller
   * scale to try when an image that big can't be drawn.
   */
  private renderAt(req: RenderRequest, scale: number): Promise<RenderResult | { retry: number }> {
    return this.job(this.main, scale, async (page) => {
      const loaded = await this.load(page, req, req.thumbnail ? scale : undefined);
      const assetsTimedOut = loaded ? undefined : true;
      const motion = await withBudget(
        "prepare",
        page.evaluate<MotionInfo | { error: string }>(
          prepareScript({ interact: req.interact, at: req.at }),
        ),
      );
      if ("error" in motion) throw new Error(motion.error);

      // From the top of the page, not the viewport: the viewport stays the
      // artboard's own size, and a fit-content artboard runs on below it.
      const measured = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          box: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
          contentHeight: document.querySelector("[data-artboard]")?.scrollHeight ?? 0,
        };
      }, selectorFor(req.nodeId));
      if (!measured) throw new Error(`Node ${req.nodeId} is not in this artboard.`);
      const { box, contentHeight } = measured;
      if (req.format !== "pdf") {
        const fits = this.fit(box, scale);
        if (fits < scale) return { retry: fits };
      }

      const issues: LintIssue[] = req.lint
        ? ((await withBudget("lint", page.evaluate(FULL_LINT_SCRIPT))) as LintIssue[])
        : [];
      const size = { width: box.width, height: box.height, contentHeight };
      const timeout = STAGE_BUDGET_MS.capture;
      try {
        if (req.format === "pdf") {
          const bytes = await withBudget(
            "capture",
            page.pdf({
              width: `${Math.ceil(box.width)}px`,
              height: `${Math.ceil(box.height)}px`,
              printBackground: true,
              pageRanges: "1",
            }),
          );
          return {
            bytes: new Uint8Array(bytes),
            mime: "application/pdf",
            ...size,
            issues,
            motion,
            assetsTimedOut,
          };
        }
        const type = req.format === "jpeg" ? "jpeg" : "png";
        const bytes = await (loaded
          ? // fullPage makes the clip page-relative, so it can reach below the viewport.
            page.screenshot({
              type,
              clip: box,
              fullPage: true,
              omitBackground: type === "png",
              timeout,
              ...(type === "jpeg" ? { quality: 85 } : {}),
            })
          : // page.screenshot waits for fonts first, and these never came.
            withBudget("capture", captureNow(page, box, scale, type)));
        return {
          bytes: new Uint8Array(bytes),
          mime: `image/${type}`,
          ...size,
          scale,
          issues,
          motion,
          assetsTimedOut,
        };
      } catch (err) {
        // With lint, return it and what went wrong rather than nothing. Without, there's nothing to return.
        const message =
          (err as Error | null)?.name === "TimeoutError"
            ? stalled("capture", timeout)
            : err instanceof Error
              ? err.message
              : String(err);
        if (!req.lint) throw new RenderError(message, "capture_failed", "capture");
        return {
          bytes: new Uint8Array(),
          mime: "",
          ...size,
          issues,
          motion,
          assetsTimedOut,
          captureError: message,
        };
      }
    });
  }

  /** The scale an image of `box` can be captured at: `scale`, or less when that is past a limit. */
  private fit(box: { width: number; height: number }, scale: number): number {
    return captureScale(box.width, box.height, scale, MAX_CAPTURE_PX, this.limits.maxPixels);
  }

  record(req: RecordRequest): Promise<RecordResult> {
    return this.job(this.main, 1, async (page) => {
      const loaded = await this.load(page, req);
      const cdp = await page.context().newCDPSession(page);
      // Transparent where the design is, like screenshots.
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
      // A capture past the viewport from this session resets the viewport to
      // the window's own size, which changes 100vh and moves everything below
      // it between measuring a node and capturing it. Pinned here, it holds.
      const pin = async () => {
        const v = page.viewportSize();
        if (v)
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            ...v,
            deviceScaleFactor: 0,
            mobile: false,
          });
      };
      await pin();
      const driver: FrameDriver = {
        evaluate: (expression) => page.evaluate(expression),
        capture: async (box, scale) => {
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { ...box, scale: this.fit(box, scale) },
            // Renders the clip even below the viewport, which stays the artboard's own size.
            captureBeyondViewport: true,
          });
          return new Uint8Array(Buffer.from(shot.data, "base64"));
        },
        async show(html, width, height) {
          await page.setViewportSize({ width: Math.ceil(width), height: Math.ceil(height) });
          await pin();
          await show(page, html);
          await withBudget("load", page.evaluate(SHOWN));
        },
      };
      const out = await recordFrames(driver, {
        selector: selectorFor(req.nodeId),
        interact: req.interact,
        frames: req.frames,
        from: req.from,
        to: req.to,
        scroll: req.scroll,
        lint: req.lint,
      });
      await cdp.detach().catch(() => {});
      return { ...out, mime: "image/png", ...(loaded ? {} : { assetsTimedOut: true }) };
    });
  }

  loop(req: LoopRequest): Promise<LoopResult> {
    // A film runs for as long as its caller lets it: `signal` is its time limit.
    return this.job(
      this.film,
      1,
      async (page) => {
        // Given up on: closing the page fails whatever it's waiting on, and frees it.
        const abort = () => void page.close().catch(() => {});
        req.signal?.addEventListener("abort", abort, { once: true });
        if (req.signal?.aborted) abort();
        try {
          const loaded = await this.load(page, req, req.thumbnail ? req.scale : undefined);
          const cdp = await page.context().newCDPSession(page);
          const v = page.viewportSize();
          if (v)
            await cdp.send("Emulation.setDeviceMetricsOverride", {
              ...v,
              deviceScaleFactor: 0,
              mobile: false,
            });
          const driver: FrameDriver = {
            evaluate: (expression) => page.evaluate(expression),
            async capture(box, scale) {
              const shot = await cdp.send("Page.captureScreenshot", {
                format: "png",
                clip: { ...box, scale: captureScale(box.width, box.height, scale) },
                captureBeyondViewport: true,
              });
              return new Uint8Array(Buffer.from(shot.data, "base64"));
            },
            async show() {},
          };
          const out = await filmLoops(driver, req);
          await cdp.detach().catch(() => {});
          return loaded ? out : { ...out, assetsTimedOut: true };
        } finally {
          req.signal?.removeEventListener("abort", abort);
        }
      },
      Number.POSITIVE_INFINITY,
    );
  }

  measure(req: MeasureRequest): Promise<MeasureResult> {
    // Layout is in CSS px whatever the device scale, so a huge board measures the same drawn small.
    return this.job(this.main, this.pageScale(req.artboard, 1), async (page) => {
      await this.load(page, req);
      // At rest, like a screenshot: every finite animation finished.
      const motion = await page.evaluate<MotionInfo | { error: string }>(prepareScript({}));
      if ("error" in motion) throw new Error(motion.error);
      const out = await page.evaluate<MeasureResult | null>(measureScript(req.ids));
      if (!out) throw new Error("The artboard didn't render.");
      return out;
    });
  }

  /**
   * Puts the artboard on the page with fonts and images loaded, or as many as
   * load in time; resolves with whether all of them did. The viewport
   * is the artboard's own size (900px tall for fit-content, like the canvas
   * shows it), so 100vh means the same here; captures reach below it.
   */
  private async load(
    page: Page,
    req: {
      artboard: RenderRequest["artboard"];
      tokens: string;
      colorScheme?: "light" | "dark";
      assetBase?: string;
    },
    imageScale?: number,
  ): Promise<boolean> {
    await page.setViewportSize(viewportOf(req.artboard));
    if (req.colorScheme) await page.emulateMedia({ colorScheme: req.colorScheme });
    await this.opts.preparePage?.(page);
    const assetBase = req.assetBase ?? this.opts.assetBase;
    // Chrome won't let a page at a public origin reach a server on this
    // machine or its network (local network access), so those requests are
    // fetched from here instead: the asset base when it is such a server, and
    // with `loopback` anything a design loads from this machine. A public
    // https asset base is left to Chrome, which caches and streams.
    const local = assetBase && !isPublic(assetBase) ? `${assetBase.replace(/\/$/, "")}/` : null;
    const { loopback } = this.opts;
    if (local || loopback)
      await page.route(
        (url) => (local !== null && url.href.startsWith(local)) || (!!loopback && isLoopback(url)),
        fetchHere,
      );
    const html = artboardPage(req.artboard, {
      tokens: req.tokens,
      assetBase,
      colorScheme: req.colorScheme,
      imageScale,
    });
    await show(page, html);
    const all = await within(
      page
        .waitForLoadState("load", { timeout: 0 })
        .catch(() => {})
        .then(() => page.evaluate(`document.fonts.ready.then(() => ${IMAGES_READY_SCRIPT})`)),
      this.opts.assetsMs ?? STAGE_BUDGET_MS.assets,
    );
    // Give up on what's still coming, so fonts fall back and the page settles.
    if (!all) await page.evaluate("window.stop()").catch(() => {});
    return all;
  }

  async close(): Promise<void> {
    await Promise.all([this.main.close(), this.film.close()]);
  }
}

/** Where render pages are served from (routed, never fetched). */
const RENDER_ORIGIN = "http://ponzu.render";

/** The page size an artboard is drawn in: its own, or 1440×900 where it has no size in px. */
function viewportOf(artboard: RenderRequest["artboard"]): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil(cssPx(artboard.root.style.width) ?? 1440)),
    height: Math.max(1, Math.ceil(cssPx(artboard.root.style.height) ?? 900)),
  };
}

/** `work`, or a RenderError once it has run for `ms`. */
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RenderError(
            `The render took too long (stopped after ${Math.round(ms / 1000)}s).`,
            "timeout",
          ),
        ),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** This process's environment, for a browser launched with one of its own. */
function definedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

/** Whether a URL is on this machine: localhost, a name under .localhost, 127.0.0.0/8 or [::1]. */
function isLoopback(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Whether Chrome can load an asset base itself: an https origin that isn't this machine. */
function isPublic(base: string): boolean {
  try {
    const url = new URL(base);
    return url.protocol === "https:" && !isLoopback(url);
  } catch {
    return false;
  }
}

/** Answers a page's request with a fetch made from this process. */
async function fetchHere(route: Route): Promise<void> {
  try {
    const response = await route.fetch();
    await route.fulfill({
      response,
      // A font from another origin needs CORS, which a dev server rarely
      // sends with its static files. Designs run no scripts, so nothing on
      // the page can read what this lets through.
      headers: { ...response.headers(), "access-control-allow-origin": "*" },
    });
  } catch {
    await route.abort().catch(() => {});
  }
}

/** A capture straight through the DevTools protocol, which doesn't wait for fonts the way page.screenshot does. */
async function captureNow(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  scale: number,
  format: "png" | "jpeg",
): Promise<Buffer> {
  const cdp = await page.context().newCDPSession(page);
  try {
    // A capture past the viewport from a new session resets the viewport to the
    // window's own size, changing 100vh after lint measured; pinned, it holds.
    const v = page.viewportSize();
    if (v)
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        ...v,
        deviceScaleFactor: 0,
        mobile: false,
      });
    if (format === "png")
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    const shot = await cdp.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 85 } : {}),
      clip: { ...box, scale },
      captureBeyondViewport: true,
    });
    return Buffer.from(shot.data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Navigates to the HTML rather than using setContent. Under Bun, an evaluate
 * right after setContent sometimes never returned once a test suite had
 * spawned child processes; a real navigation hasn't hung. Returns once the
 * DOM is ready: fonts and images get their own time limit after this.
 */
async function show(page: Page, html: string): Promise<void> {
  const url = `${RENDER_ORIGIN}/`;
  await page.unroute(url).catch(() => {});
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: STAGE_BUDGET_MS.load });
  } catch (err) {
    if ((err as Error | null)?.name === "TimeoutError")
      throw new RenderError(stalled("load"), "timeout", "load");
    throw err;
  }
}

/** Every image decoded and painted, so a capture doesn't catch tiles mid-raster. */
const SHOWN = `Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`;

function selectorFor(nodeId?: string): string {
  return nodeId ? `[data-id="${nodeId.replace(/["\\]/g, "\\$&")}"]` : "[data-artboard]";
}

export function findChromium(): string | null {
  const env = process.env.PONZU_CHROMIUM;
  if (env && existsSync(env)) return env;
  const home = homedir();
  const candidates: string[] = [];
  if (platform() === "darwin") {
    for (const app of [
      "Google Chrome",
      "Chromium",
      "Google Chrome Canary",
      "Microsoft Edge",
      "Brave Browser",
      "Arc",
    ]) {
      for (const root of ["/Applications", join(home, "Applications")]) {
        const bin = app === "Arc" ? "Arc" : app;
        candidates.push(join(root, `${app}.app`, "Contents", "MacOS", bin));
      }
    }
  } else if (platform() === "win32") {
    const pf = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];
    for (const root of pf) {
      candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(join(root, "Chromium", "Application", "chrome.exe"));
    }
  } else {
    for (const bin of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "brave-browser",
    ]) {
      for (const dir of ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome"])
        candidates.push(join(dir, bin));
    }
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
