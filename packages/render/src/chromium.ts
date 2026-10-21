import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { captureScale, clampScale, IMAGES_READY_SCRIPT } from "./capture.ts";
import { artboardPage } from "./document.ts";
import {
  type FrameDriver,
  FULL_LINT_SCRIPT,
  type MotionInfo,
  prepareScript,
  recordFrames,
} from "./motion.ts";
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

export interface ChromiumOptions {
  /** Path to a Chrome or Chromium binary. Found automatically when omitted. */
  executablePath?: string;
  /** Base URL for relative asset paths, usually the server's /assets route. */
  assetBase?: string;
  /** Runs on each new page before the artboard loads, e.g. to route its requests in tests. */
  preparePage?: (page: Page) => Promise<void>;
  /** How long fonts and images may take, so tests of one that never arrives needn't wait the full budget. */
  assetsMs?: number;
}

/**
 * Renders with a headless Chromium the user already has: Chrome, Edge,
 * Brave, Chromium, or a Playwright download. Nothing is downloaded.
 */
export class ChromiumRenderer implements Renderer {
  private browser: Promise<Browser> | null = null;
  private context: Promise<BrowserContext> | null = null;

  constructor(private opts: ChromiumOptions = {}) {}

  private async ctx(): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = this.opts.executablePath ?? findChromium();
      if (!executablePath) {
        throw new Error(
          "No Chrome or Chromium found for screenshots. Install Google Chrome, or set PONZU_CHROMIUM to a Chromium binary.",
        );
      }
      const { chromium } = await import("playwright-core");
      this.browser = chromium.launch({
        executablePath,
        headless: true,
        args: ["--hide-scrollbars", "--font-render-hinting=none"],
      });
      this.browser.catch(() => {
        this.browser = null;
      });
    }
    if (!this.context)
      this.context = this.browser.then((b) => b.newContext({ deviceScaleFactor: 1 }));
    return this.context;
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const out = await this.renderAt(req, clampScale(req.scale));
    // Too big for the GPU to draw at that scale: again, at the largest it can.
    return "retry" in out ? ((await this.renderAt(req, out.retry)) as RenderResult) : out;
  }

  /**
   * Renders at `scale` device pixels per CSS pixel, or says which smaller
   * scale to try when an image that big can't be drawn.
   */
  private async renderAt(
    req: RenderRequest,
    scale: number,
  ): Promise<RenderResult | { retry: number }> {
    const context = await this.ctx();
    const browser = await this.browser!;
    // deviceScaleFactor is per-context, so non-default scales get their own.
    // devicePixelRatio reports it, so srcset and image-set() pick to suit.
    const own = scale !== 1 ? await browser.newContext({ deviceScaleFactor: scale }) : null;
    const page = await (own ?? context).newPage();
    try {
      const loaded = await this.load(page, req);
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
        const fits = captureScale(box.width, box.height, scale);
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
    } finally {
      await page.close().catch(() => {});
      if (own) await own.close().catch(() => {});
    }
  }

  async record(req: RecordRequest): Promise<RecordResult> {
    const page = await (await this.ctx()).newPage();
    try {
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
        async capture(box, scale) {
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { ...box, scale: captureScale(box.width, box.height, scale) },
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
    } finally {
      await page.close().catch(() => {});
    }
  }

  async measure(req: MeasureRequest): Promise<MeasureResult> {
    const page = await (await this.ctx()).newPage();
    try {
      await this.load(page, req);
      // At rest, like a screenshot: every finite animation finished.
      const motion = await page.evaluate<MotionInfo | { error: string }>(prepareScript({}));
      if ("error" in motion) throw new Error(motion.error);
      const out = await page.evaluate<MeasureResult | null>(measureScript(req.ids));
      if (!out) throw new Error("The artboard didn't render.");
      return out;
    } finally {
      await page.close().catch(() => {});
    }
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
  ): Promise<boolean> {
    const width = cssPx(req.artboard.root.style.width) ?? 1440;
    const height = cssPx(req.artboard.root.style.height) ?? 900;
    await page.setViewportSize({
      width: Math.max(1, Math.ceil(width)),
      height: Math.max(1, Math.ceil(height)),
    });
    if (req.colorScheme) await page.emulateMedia({ colorScheme: req.colorScheme });
    await this.opts.preparePage?.(page);
    const assetBase = req.assetBase ?? this.opts.assetBase;
    // Chrome won't let the page reach a server on 127.0.0.1 (local network
    // access), so its asset requests are fetched from here instead.
    if (assetBase && /^https?:/.test(assetBase)) {
      const prefix = `${assetBase.replace(/\/$/, "")}/`;
      await page.route(
        (url) => url.href.startsWith(prefix),
        async (route) => {
          try {
            await route.fulfill({ response: await route.fetch() });
          } catch {
            await route.abort().catch(() => {});
          }
        },
      );
    }
    const html = artboardPage(req.artboard, {
      tokens: req.tokens,
      assetBase,
      colorScheme: req.colorScheme,
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
    const b = this.browser;
    this.browser = null;
    this.context = null;
    if (b) await (await b).close().catch(() => {});
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

function cssPx(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Navigates to the HTML rather than using setContent. Under Bun, an evaluate
 * right after setContent sometimes never returned once a test suite had
 * spawned child processes; a real navigation hasn't hung. Returns once the
 * DOM is ready: fonts and images get their own time limit after this.
 */
async function show(page: Page, html: string): Promise<void> {
  const url = "http://ponzu.render/";
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
