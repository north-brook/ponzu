import { expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { BrowserProcess } from "./browser.ts";
import { RenderError } from "./stages.ts";

/**
 * A browser as BrowserProcess sees one, that dies when told to. A page that
 * was opening when it died never arrives and never fails, which is what
 * Playwright does when Chrome is killed between making a page and showing it.
 * The real thing is killed mid-render in chromium.test.ts; the moment a page
 * is opening is too short to hit there on purpose.
 */
function fakeBrowser(opts: { opens: boolean }) {
  let connected = true;
  const gone: (() => void)[] = [];
  const page = { on() {}, close: async () => {} };
  const context = {
    newPage: () => (opts.opens ? Promise.resolve(page) : new Promise<never>(() => {})),
    close: async () => {},
  };
  const browser = {
    isConnected: () => connected,
    on: (_event: "disconnected", listener: () => void) => gone.push(listener),
    newContext: async () => context,
    close: async () => {},
  };
  return {
    browser: browser as unknown as Browser,
    page,
    die() {
      connected = false;
      for (const listener of gone) listener();
    },
  };
}

const soon = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a browser that dies while a page is opening is replaced at once, and the job goes on", async () => {
  const first = fakeBrowser({ opens: false });
  const second = fakeBrowser({ opens: true });
  const launched = [first, second];
  let launches = 0;
  const process = new BrowserProcess(async () => launched[launches++]!.browser, 60_000);
  const started = Date.now();
  const opening = process.open(1);
  await soon();
  first.die();
  const lease = await opening;
  // Not the 15 seconds a page gets to open.
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(lease.page).toBe(second.page as never);
  expect(launches).toBe(2);
  await lease.close();
  await process.close();
});

test("when the replacement dies the same way, the job fails saying the browser stopped", async () => {
  const browsers = [fakeBrowser({ opens: false }), fakeBrowser({ opens: false })];
  let launches = 0;
  const process = new BrowserProcess(async () => browsers[launches++]!.browser, 60_000);
  const opening = process.open(2).catch((err) => err);
  await soon();
  browsers[0]!.die();
  await soon();
  browsers[1]!.die();
  const err = await opening;
  expect(err).toBeInstanceOf(RenderError);
  expect(err.message).toContain("The browser drawing this stopped partway");
  expect(launches).toBe(2);
  await process.close();
});

test("a browser killed as it starts is started once more", async () => {
  const good = fakeBrowser({ opens: true });
  let launches = 0;
  const process = new BrowserProcess(async () => {
    if (launches++ === 0)
      throw new Error("launch: Target page, context or browser has been closed");
    return good.browser;
  }, 60_000);
  const lease = await process.open(1);
  expect(lease.page).toBe(good.page as never);
  expect(launches).toBe(2);
  await lease.close();
  await process.close();
});

test("a launch that says why it can't work isn't tried again", async () => {
  let launches = 0;
  const why = new RenderError("Chrome can't sandbox its pages on this machine.", "render_error");
  const process = new BrowserProcess(async () => {
    launches++;
    throw why;
  }, 60_000);
  expect(await process.open(1).catch((err) => err)).toBe(why);
  expect(launches).toBe(1);
  // And a browser that fails twice says what the second failure was.
  const twice = new BrowserProcess(async () => {
    throw new Error("launch: error while loading shared libraries");
  }, 60_000);
  expect((await twice.open(1).catch((err) => err)).message).toContain("shared libraries");
});
