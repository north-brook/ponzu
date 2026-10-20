import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { artboardPage } from "./document.ts";
import {
  type FrameDriver,
  FULL_LINT_SCRIPT,
  type MotionInfo,
  prepareScript,
  recordFrames,
} from "./motion.ts";
import type {
  LintIssue,
  RecordRequest,
  RecordResult,
  Renderer,
  RenderRequest,
  RenderResult,
} from "./renderer.ts";

export interface ChromiumOptions {
  /** Path to a Chrome or Chromium binary. Found automatically when omitted. */
  executablePath?: string;
  /** Base URL for relative asset paths, usually the server's /assets route. */
  assetBase?: string;
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
    const scale = Math.min(Math.max(req.scale ?? 1, 0.25), 3);
    const context = await this.ctx();
    const browser = await this.browser!;
    // deviceScaleFactor is per-context, so non-default scales get their own.
    const own = scale !== 1 ? await browser.newContext({ deviceScaleFactor: scale }) : null;
    const page = await (own ?? context).newPage();
    try {
      const { width, height } = await this.load(page, req);
      const motion = await page.evaluate<MotionInfo | { error: string }>(
        prepareScript({ interact: req.interact, at: req.at }),
      );
      if ("error" in motion) throw new Error(motion.error);

      const el = await page.$(selectorFor(req.nodeId));
      if (!el) throw new Error(`Node ${req.nodeId} is not in this artboard.`);
      const box = (await el.boundingBox()) ?? { width, height, x: 0, y: 0 };
      const contentHeight = await page.evaluate(
        () => document.querySelector("[data-artboard]")?.scrollHeight ?? 0,
      );
      if (!req.nodeId && box.height > height)
        await page.setViewportSize({
          width: Math.ceil(width),
          height: Math.min(Math.ceil(box.height), 16000),
        });

      const issues: LintIssue[] = req.lint
        ? ((await page.evaluate(FULL_LINT_SCRIPT)) as LintIssue[])
        : [];
      if (req.format === "pdf") {
        const bytes = await page.pdf({
          width: `${Math.ceil(box.width)}px`,
          height: `${Math.ceil(box.height)}px`,
          printBackground: true,
          pageRanges: "1",
        });
        return {
          bytes: new Uint8Array(bytes),
          mime: "application/pdf",
          width: box.width,
          height: box.height,
          contentHeight,
          issues,
          motion,
        };
      }
      const type = req.format === "jpeg" ? "jpeg" : "png";
      const bytes = await el.screenshot({
        type,
        omitBackground: type === "png",
        ...(type === "jpeg" ? { quality: 85 } : {}),
      });
      return {
        bytes: new Uint8Array(bytes),
        mime: `image/${type}`,
        width: box.width,
        height: box.height,
        contentHeight,
        issues,
        motion,
      };
    } finally {
      await page.close().catch(() => {});
      if (own) await own.close().catch(() => {});
    }
  }

  async record(req: RecordRequest): Promise<RecordResult> {
    const page = await (await this.ctx()).newPage();
    try {
      const { width, height } = await this.load(page, req);
      // Tall artboards (height: fit-content) need the whole of themselves in the viewport.
      const bottom = await page.evaluate(
        () => document.querySelector("[data-artboard]")?.getBoundingClientRect().bottom ?? 0,
      );
      if (bottom > height)
        await page.setViewportSize({
          width: Math.ceil(width),
          height: Math.min(Math.ceil(bottom), 16000),
        });
      const cdp = await page.context().newCDPSession(page);
      // Transparent where the design is, like screenshots.
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
      const driver: FrameDriver = {
        evaluate: (expression) => page.evaluate(expression),
        async capture(box, scale) {
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { ...box, scale },
            // Without it, wide captures repeat a tile at the bottom edge.
            captureBeyondViewport: true,
          });
          return new Uint8Array(Buffer.from(shot.data, "base64"));
        },
        async show(html, width, height) {
          await page.setViewportSize({ width: Math.ceil(width), height: Math.ceil(height) });
          await show(page, html);
          await page.evaluate(SHOWN);
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
      return { ...out, mime: "image/png" };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Puts the artboard on the page, sized to it, with fonts loaded. */
  private async load(
    page: Page,
    req: {
      artboard: RenderRequest["artboard"];
      tokens: string;
      colorScheme?: "light" | "dark";
      assetBase?: string;
    },
  ): Promise<{ width: number; height: number }> {
    const width = cssPx(req.artboard.root.style.width) ?? 1440;
    const height = cssPx(req.artboard.root.style.height) ?? 900;
    await page.setViewportSize({
      width: Math.ceil(width),
      height: Math.min(Math.ceil(height), 16000),
    });
    if (req.colorScheme) await page.emulateMedia({ colorScheme: req.colorScheme });
    const html = artboardPage(req.artboard, {
      tokens: req.tokens,
      assetBase: req.assetBase ?? this.opts.assetBase,
      colorScheme: req.colorScheme,
    });
    await show(page, html);
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    return { width, height };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    if (b) await (await b).close().catch(() => {});
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
 * spawned child processes; a real navigation hasn't hung.
 */
async function show(page: Page, html: string): Promise<void> {
  const url = "http://ponzu.render/";
  await page.unroute(url).catch(() => {});
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(url, { waitUntil: "load", timeout: 15000 });
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
