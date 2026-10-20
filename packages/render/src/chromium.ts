import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { artboardPage } from "./document.ts";
import {
  LINT_SCRIPT,
  type LintIssue,
  type Renderer,
  type RenderRequest,
  type RenderResult,
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
      const width = cssPx(req.artboard.root.style.width) ?? 1440;
      const height = cssPx(req.artboard.root.style.height) ?? 900;
      await page.setViewportSize({
        width: Math.ceil(width),
        height: Math.min(Math.ceil(height), 16000),
      });
      if (req.colorScheme) await page.emulateMedia({ colorScheme: req.colorScheme });
      const html = artboardPage(req.artboard, {
        tokens: req.tokens,
        assetBase: this.opts.assetBase,
        colorScheme: req.colorScheme,
      });
      await page.setContent(html, { waitUntil: "load", timeout: 15000 });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      // Let CSS animations settle on their first frame consistently.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );

      const selector = req.nodeId ? `[data-id="${cssEscape(req.nodeId)}"]` : "[data-artboard]";
      const el = await page.$(selector);
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
        ? ((await page.evaluate(LINT_SCRIPT)) as LintIssue[])
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
      };
    } finally {
      await page.close().catch(() => {});
      if (own) await own.close().catch(() => {});
    }
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

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
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
