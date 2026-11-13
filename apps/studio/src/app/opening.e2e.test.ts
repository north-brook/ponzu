/*
 * Opening a canvas with every answer slowed, in the studio as it ships (fake-host.ts, a real
 * Chromium): what its chrome shows at the first paint. The pull request's mark comes from the
 * sidebar's row at once, with the room for its action held; a canvas opened again shows its mark
 * and its action from its last answer, kept in the query cache; and the read on opening confirms
 * them without a change. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(120_000);

/** How long every answer takes, the live queries' included. */
const LATENCY = 400;

/** What the chrome shows, measured in the frame a click on `selector` paints first. */
interface Painted {
  mark: { x: number; label: string } | null;
  action: { x: number; label: string } | null;
  /** The room held for the action, unseen, or the action's own. */
  room: number;
}

/**
 * Clicks `selector` in the page and measures the frame it paints first. The measuring is started
 * in the page and its answer left on the window, which the test then reads: no evaluate waits on
 * a promise in the page for longer than it takes to run.
 */
async function firstPaint(page: Page, selector: string): Promise<Painted> {
  await page.evaluate((selector) => {
    const w = window as { painted?: Painted | null };
    w.painted = null;
    void new Promise<Painted>((resolve) => {
      const look = (): Painted => {
        const header = document.querySelector("header")!;
        const mark = header.querySelector<HTMLElement>('button[aria-label^="Pull request #"]');
        const action = header.querySelector<HTMLElement>(
          '[data-arrival="action"] > :not([aria-hidden]) button',
        );
        const room = header.querySelector('[data-arrival="action"]');
        return {
          mark: mark && {
            x: mark.getBoundingClientRect().x,
            label: mark.getAttribute("aria-label")!,
          },
          action: action && {
            x: action.getBoundingClientRect().x,
            label: action.textContent!.trim(),
          },
          room: room?.getBoundingClientRect().width ?? 0,
        };
      };
      document.querySelector<HTMLElement>(selector)!.click();
      // The click's render and the canvas's opening land before the next frame is painted.
      requestAnimationFrame(() => resolve(look()));
    }).then((painted) => {
      w.painted = painted;
    });
  }, selector);
  await waitUntil(() => page.evaluate(() => !!(window as { painted?: Painted | null }).painted));
  return page.evaluate(() => (window as { painted?: Painted | null }).painted!);
}

describe.skipIf(!chromiumPath)("opening a canvas, its answers slow", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  let ids: { first: string; second: string };

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.url}?as=returning&latency=${LATENCY}`);
    await page.locator("[data-canvas-row]").first().waitFor({ timeout: 30_000 });
    // Two canvases on the team's repo, each with a draft pull request. Made in the page, the
    // answer (LATENCY on) left on the window and read from there: no evaluate waits on a
    // promise in the page for longer than it takes to run.
    type Made = { ids?: typeof ids; failed?: string };
    await page.evaluate(() => {
      const made: Made = {};
      (window as { made?: Made }).made = made;
      const w = window.ponzuFake!;
      const api = w.backend.connect(w.me).api;
      const first = [...w.backend.canvases.values()][0]!;
      api.canvases
        .create({ workspaceId: w.workspaceId, repoId: first.repoId!, name: "Pricing page" })
        .then((second) => {
          for (const id of [first.id, second.id]) {
            const github = w.backend.canvas(id).github!;
            github.push([{ path: "src/hero.tsx", additions: 12 }]);
            github.open("maya", "Calmer hero");
          }
          made.ids = { first: first.id, second: second.id };
        })
        .catch((error: unknown) => {
          made.failed = String(error);
        });
    });
    const made = () => page.evaluate(() => (window as { made?: Made }).made!);
    await waitUntil(async () => {
      const now = await made();
      return !!(now.ids || now.failed);
    });
    const { ids: both, failed } = await made();
    if (!both) throw new Error(`The second canvas wasn't made: ${failed}`);
    ids = both;
    // The create page, with both rows saying their pull requests.
    await page.getByRole("button", { name: "New canvas" }).click();
    await waitUntil(() =>
      page.evaluate(
        () => document.querySelectorAll('[data-canvas-row] [class*="ml-auto"]').length >= 2,
      ),
    );
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const row = (id: string) => `[data-canvas-row="${id}"]`;
  /** The action, once its answer is in. */
  const actionIn = () =>
    waitUntil(
      () =>
        page.evaluate(
          () =>
            !!document.querySelector('header [data-arrival="action"] > :not([aria-hidden]) button'),
        ),
      20_000,
    );

  test("the first time: the mark from the row at once, the action's room held, and the action lands in it", async () => {
    const painted = await firstPaint(page, row(ids.first));
    expect(painted.mark?.label).toMatch(/^Pull request #\d+$/);
    expect(painted.action).toBeNull();
    // Ready's room, unseen: the mark already stands where it will.
    expect(painted.room).toBeGreaterThan(50);
    await actionIn();
    const now = await page.evaluate(() => {
      const mark = document.querySelector('header button[aria-label^="Pull request #"]')!;
      return mark.getBoundingClientRect().x;
    });
    expect(Math.abs(now - painted.mark!.x)).toBeLessThanOrEqual(1);
  });

  test("opened again, its mark and action are there at the first paint, and stay put", async () => {
    await firstPaint(page, row(ids.second));
    await actionIn();
    const painted = await firstPaint(page, row(ids.first));
    expect(painted.mark?.label).toMatch(/^Pull request #\d+$/);
    expect(painted.action?.label).toBe("Ready");
    // The read on opening, and the head, confirm them: nothing changes once they are in.
    await waitUntil(() => page.evaluate(() => window.ponzuFake!.answers.waiting === 0), 20_000);
    const later = await page.evaluate(() => {
      const header = document.querySelector("header")!;
      const mark = header.querySelector('button[aria-label^="Pull request #"]')!;
      const action = header.querySelector('[data-arrival="action"] button')!;
      return { mark: mark.getBoundingClientRect().x, action: action.getBoundingClientRect().x };
    });
    expect(Math.abs(later.mark - painted.mark!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(later.action - painted.action!.x)).toBeLessThanOrEqual(1);
  });
});
