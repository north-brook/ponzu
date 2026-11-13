/*
 * The studio as the harness drives it: a build served as the desktop serves it, in headless
 * Chromium, on Ponzu Cloud in memory (fake-host.ts), signed in as someone returning. A canvas is
 * seeded through `window.ponzuFake`, as the agent would draw it, and opened by a link.
 */
import type { Artboard } from "@ponzu/core";
import { launchChromium, type Page, type TestChromium } from "@ponzu/render/testing";
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
