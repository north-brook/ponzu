/*
 * The studio as the harness drives it: a build served as the desktop serves it, in headless
 * Chromium, on Ponzu Cloud in memory (fake-host.ts), signed in as someone returning. A canvas is
 * seeded through `window.ponzuFake`, as the agent would draw it, and opened by a link.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Artboard } from "@ponzu/core";
import {
  attachChromium,
  type Browser,
  launchChromium,
  type Page,
  type TestChromium,
} from "@ponzu/render/testing";
import { serve } from "../src/app/e2e-lib.ts";
import { PROBE } from "./probe.ts";
import type { CDPSession } from "./trace.ts";

/** The window the harness measures: a laptop's, at a retina screen's density. */
export const VIEWPORT = { width: 1512, height: 945 };
export const SCALE = 2;

export interface Studio {
  page: Page;
  cdp: CDPSession;
  close(): Promise<void>;
}

/** Opens the build in `dir` in a fresh browser, signed in, with the probe in place. */
export async function openStudio(dir: string, chromium?: string): Promise<Studio> {
  const server = serve(dir);
  let browser: TestChromium | undefined;
  try {
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(PROBE);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${server.url}?as=returning`);
    await page.locator("[data-canvas-row]").first().waitFor({ timeout: 60_000 });
    const cdp = await page.context().newCDPSession(page);
    const b = browser;
    return {
      page,
      cdp,
      close: async () => {
        await b.close();
        server.stop();
        if (errors.length) console.warn(`The page threw:\n${errors.slice(0, 5).join("\n")}`);
      },
    };
  } catch (error) {
    await browser?.close();
    server.stop();
    throw error;
  }
}

/*
 * The desktop app, on a Mac's own GPU and display, instead of headless Chrome (README.md,
 * "Profiling"). Only a window on Ponzu Cloud in memory is ever measured: a test build or a run
 * from a checkout, launched with PONZU_FAKE_BACKEND=1 and a debugging port, whose studio was
 * built with the fake in it. A release opens no debugging port and its studio has no fake, so
 * it can't be attached to; anything else that answers is refused before the harness touches it.
 */

/**
 * Which desktop app: one started for each suite from a checkout's launcher
 * (`apps/desktop/run-dev.sh`), showing the build in `dir` from the harness's own server
 * (PONZU_STUDIO_URL); or one already running with a debugging port at `cdp`, showing its own.
 */
export type Desktop = { electron: string; dir: string } | { cdp: string };

/** Opens the studio in the desktop app, signed in, with the probe in place; as `openStudio`. */
export async function openDesktop(desktop: Desktop): Promise<Studio> {
  const server = "dir" in desktop ? serve(desktop.dir) : null;
  let app: ChildProcess | null = null;
  let browser: Browser | undefined;
  const log: string[] = [];
  try {
    let endpoint: string;
    if ("electron" in desktop) {
      app = spawn(desktop.electron, ["--remote-debugging-port=0"], {
        env: { ...process.env, PONZU_FAKE_BACKEND: "1", PONZU_STUDIO_URL: server!.url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      endpoint = await listening(app, log);
    } else {
      endpoint = desktop.cdp;
    }
    browser = await attachChromium(onThisComputer(endpoint));
    const page = await fakeWindow(browser, server?.url ?? null);
    // Each suite starts as a fresh launch would: the fake's world lives in the page, and the
    // throwaway profile's storage is cleared, so no canvas a suite left is opened again.
    await page.evaluate(() => localStorage.clear());
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(PROBE);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(new URL("/?as=returning", page.url()).href);
    await page.locator("[data-canvas-row]").first().waitFor({ timeout: 60_000 });
    if (!(await page.evaluate(() => "ponzuFake" in window))) {
      throw new Error("The studio isn't on its fake backend: build it with --mode e2e.");
    }
    const cdp = await page.context().newCDPSession(page);
    const b = browser;
    const a = app;
    return {
      page,
      cdp,
      close: async () => {
        await cdp.detach().catch(() => {});
        // Attached over CDP, close() lets go; the app quits only if the harness started it.
        await b.close();
        if (a) await quit(a);
        server?.stop();
        if (errors.length) console.warn(`The page threw:\n${errors.slice(0, 5).join("\n")}`);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    if (app) await quit(app);
    server?.stop();
    if (log.length) console.error(`The app said:\n${log.join("").slice(-2000)}`);
    throw error;
  }
}

/** The endpoint Electron prints once its debugging port is open (`--remote-debugging-port=0`). */
function listening(app: ChildProcess, log: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The app opened no debugging port.")), 60_000);
    const hear = (chunk: Buffer) => {
      const text = chunk.toString();
      log.push(text);
      const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    // Read for as long as it runs: a pipe left full would stall the app.
    app.stdout!.on("data", hear);
    app.stderr!.on("data", hear);
    app.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The app exited (${code}) before it opened a debugging port.`));
    });
  });
}

/** Only a debugging port on this computer: one elsewhere is nothing the harness should drive. */
function onThisComputer(endpoint: string): string {
  const url = URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`--cdp takes a debugging port on this computer, not ${endpoint}.`);
  }
  return endpoint;
}

/**
 * The app's main window, once it has one, and only if it runs on the fake backend (the shell
 * says so, `config.fake`, only when launched with PONZU_FAKE_BACKEND=1, which a release
 * ignores). With `origin`, it must also be showing the harness's build.
 */
async function fakeWindow(browser: Browser, origin: string | null): Promise<Page> {
  const end = Date.now() + 60_000;
  let seen = "";
  while (Date.now() < end) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      const shell = await page
        .evaluate(() => {
          const d = (window as { ponzuDesktop?: { config: { fake?: boolean } } }).ponzuDesktop;
          return d ? { fake: d.config.fake === true } : null;
        })
        .catch(() => null);
      if (!shell) continue;
      seen = page.url();
      if (!shell.fake) {
        throw new Error(
          `${seen} is a Ponzu window on the real service, not Ponzu Cloud in memory: launch it with PONZU_FAKE_BACKEND=1.`,
        );
      }
      if (origin && new URL(page.url()).origin !== new URL(origin).origin) {
        throw new Error(
          `The app shows ${seen}, not the harness's build at ${origin}: a packaged app shows its own studio (use --cdp).`,
        );
      }
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No Ponzu window came up${seen ? ` (last seen: ${seen})` : ""}.`);
}

/** Quits an app the harness started, and waits until it's gone. */
async function quit(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app.kill("SIGTERM");
  const timer = setTimeout(() => app.kill("SIGKILL"), 10_000);
  await gone;
  clearTimeout(timer);
}

/** The window as measured: its size and density, which a Mac's display decides. */
export async function windowSize(page: Page): Promise<string> {
  return page.evaluate(
    () => `${window.innerWidth}×${window.innerHeight} at ${window.devicePixelRatio}×`,
  );
}

export interface Seed {
  name: string;
  tokens?: string;
  boards: Artboard[];
  /** Thread lines to give it before it opens. */
  thread?: (agent: SeedAgent) => void;
}

/** What a seed's thread can say, as `backend.agent(id)` (packages/client/src/testing/backend.ts). */
export type SeedAgent = {
  say(text: string, opts?: { id?: string; streaming?: boolean }): string;
  tool(label: string, opts?: { steps?: number; streaming?: boolean }): string;
};

/** Makes a canvas holding `seed`, in the team's first repo; returns its id. Not opened. */
export async function seedCanvas(page: Page, seed: Seed): Promise<string> {
  const id = await page.evaluate(
    async ({ name, tokens, json }) => {
      const boards = JSON.parse(json) as Artboard[];
      const w = window.ponzuFake!;
      const api = w.backend.connect(w.me).api;
      const first = [...w.backend.canvases.values()][0]!;
      const { id } = await api.canvases.create({
        workspaceId: w.workspaceId,
        repoId: first.repoId!,
        name,
      });
      const agent = w.backend.agent(id);
      const page = w.backend.canvas(id).sequencer.doc.pages[0]!.id;
      if (tokens) agent.commit([{ op: "tokens", css: tokens }]);
      // One op each: an op holds at most 10,000 nodes.
      boards.forEach((artboard, index) =>
        agent.commit([{ op: "artboard.create", page, index, artboard }]),
      );
      return id;
    },
    // As JSON text: Playwright's own serializer hangs on an argument nested about 60 deep, and a
    // board's tree is twice as deep as its DOM (each element, then its children's array).
    { name: seed.name, tokens: seed.tokens, json: JSON.stringify(seed.boards) },
  );
  if (seed.thread) {
    // Functions don't cross into the page, so the thread is played here, a call at a time.
    const calls: [string, unknown[]][] = [];
    seed.thread({
      say: (...args) => {
        calls.push(["say", args]);
        return "";
      },
      tool: (...args) => {
        calls.push(["tool", args]);
        return "";
      },
    });
    await page.evaluate(
      ({ id, calls }) => {
        const agent = window.ponzuFake!.backend.agent(id) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        for (const [fn, args] of calls) agent[fn]!(...args);
      },
      { id, calls },
    );
  }
  return id;
}

/** Shows a canvas, as a link would. */
export async function linkTo(page: Page, canvasId: string): Promise<void> {
  await page.evaluate((id) => window.ponzuFake!.link({ kind: "canvas", canvasId: id }), canvasId);
}

/**
 * In the page: whether every board in the open canvas is drawn as it will be at rest (live, or
 * away off screen), and none is still waiting for its turn.
 */
export const BOARDS_READY = `(() => {
  const tiers = [...document.querySelectorAll("[data-pz-board] [data-pz-tier]")];
  return tiers.length > 0 && tiers.every((t) => { const v = t.getAttribute("data-pz-tier"); return v === "live" || v === "away"; });
})()`;

/** Waits until the open canvas's boards are drawn and nothing has changed for a few frames. */
export async function boardsReady(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(BOARDS_READY, undefined, { timeout, polling: "raf" });
  await settled(page);
}

/** Waits until React has committed nothing and the DOM's size held for ten frames. */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.__pz.settle(() => [window.__pz.commits, document.getElementsByTagName("*").length]),
  );
}

/** Elements in the page, every shadow root included. */
export async function domNodes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const count = (root: ParentNode): number => {
      let n = 0;
      for (const el of root.querySelectorAll("*")) {
        n++;
        if (el.shadowRoot) n += count(el.shadowRoot);
      }
      return n;
    };
    return count(document);
  });
}

/** The canvas's zoom, as its label shows it, in percent. */
export async function zoomPercent(page: Page): Promise<number> {
  const text = await page.locator("text=/^\\d+%$/").first().textContent({ timeout: 10_000 });
  return Number(text?.replace("%", ""));
}
