/*
 * The thread rail and needs you in a real Chromium: following the foot, the composer's button,
 * sending from the keyboard, and answering a question with the keyboard alone. Skips where there
 * is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  launch,
  type Page,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

describe.skipIf(!chromiumPath)("the thread rail", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    built?.dispose();
  });

  const open = async (board: string) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  const log = '[role="log"]';
  /** How far the thread is from its foot, in pixels. */
  const fromFoot = () =>
    page.$eval(log, (el) => {
      const s = el.parentElement!;
      return s.scrollHeight - s.clientHeight - s.scrollTop;
    });
  const scrollBy = (dy: number) =>
    page.$eval(log, (el, dy) => el.parentElement!.scrollBy(0, dy), dy);

  test("a thousand lines: only the newest are drawn, and it opens at the foot", async () => {
    await open("long-thread");
    expect(await fromFoot()).toBeLessThan(2);
    const drawn = await page.$$eval(`${log} > *`, (els) => els.length);
    expect(drawn).toBeLessThan(120);
  });

  test("scrolling up stops following; what arrives is counted; the pill goes back", async () => {
    await open("long-thread");
    await scrollBy(-600);
    // The rail has heard the scroll once it fades its foot.
    await page.waitForFunction(
      (sel) =>
        (document.querySelector(sel)!.parentElement as HTMLElement).style.maskImage.endsWith(
          "transparent)",
        ),
      log,
    );
    const away = await fromFoot();
    expect(away).toBeGreaterThan(500);
    // The run is stopped (a line from someone else, as far as following goes).
    await page.click('button[aria-label="Stop"]');
    await page.waitForSelector('button:has-text("1 new")');
    // The view stayed where the person was reading.
    expect(Math.abs((await fromFoot()) - away)).toBeLessThan(80);
    await page.click('button:has-text("1 new")');
    await page.waitForFunction((sel) => {
      const s = document.querySelector(sel)!.parentElement!;
      return s.scrollHeight - s.clientHeight - s.scrollTop < 2;
    }, log);
    expect(await page.$('button:has-text("new")')).toBeNull();
  });

  test("reading up reveals older lines without moving what is on screen", async () => {
    await open("long-thread");
    const first = () => page.$eval(`${log} > *`, (el) => el.textContent);
    const before = await first();
    await page.$eval(log, (el) => {
      el.parentElement!.scrollTop = 0;
    });
    await page.waitForFunction(
      ([sel, was]) => document.querySelector(`${sel} > *`)?.textContent !== was,
      [log, before] as const,
    );
    // The line that was at the top is still on screen, below what was revealed.
    const top = await page.$eval(log, (el) => el.parentElement!.scrollTop);
    expect(top).toBeGreaterThan(200);
    // Reading on to the top of what is loaded asks for older items.
    for (let i = 0; i < 12; i++) {
      await page.$eval(log, (el) => {
        el.parentElement!.scrollTop = 0;
      });
      await page.waitForTimeout(80);
    }
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} > *`).length > 200, log);
  });

  test("Stop while working with nothing typed; Send once there are words", async () => {
    await open("thread-in-the-right-rail");
    expect(await page.$('button[aria-label="Stop"]')).not.toBeNull();
    await page.fill('textarea[aria-label="Message"]', "Keep the green");
    expect(await page.$('button[aria-label="Stop"]')).toBeNull();
    const send = () =>
      page.$eval('button[aria-label="Send"]', (b) => b.getAttribute("aria-disabled"));
    expect(await send()).toBeNull();
    await page.fill('textarea[aria-label="Message"]', "   ");
    expect(await page.$('button[aria-label="Stop"]')).not.toBeNull();
  });

  test("Return sends, Shift-Return breaks the line, and the draft clears", async () => {
    await open("thread-in-the-right-rail");
    await page.click('textarea[aria-label="Message"]');
    await page.keyboard.type("Calmer");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("and keep the green");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${log} p:has-text("and keep the green")`);
    const text = await page.$eval(`${log} p:has-text("and keep the green")`, (p) =>
      p.textContent?.replace(/^You said: /, ""),
    );
    expect(text).toBe("Calmer\nand keep the green");
    expect(await page.inputValue('textarea[aria-label="Message"]')).toBe("");
    expect(await fromFoot()).toBeLessThan(2);
  });

  test("a question answers from the keyboard: arrows, Space, a digit, then Return", async () => {
    await open("needs-you-a-question");
    const send = () =>
      page.$eval('section button[aria-label="Send"]', (b) => b.getAttribute("aria-disabled"));
    expect(await send()).toBe("true");
    await page.focus('[role="radio"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    const checked = () =>
      page.$$eval('[role="radio"][aria-checked="true"]', (els) => els.map((e) => e.textContent));
    expect((await checked())[0]).toContain("Smaller type on phones");
    expect(await send()).toBeNull();
    // A digit chooses outright, and one choice replaces another.
    await page.keyboard.press("1");
    expect(await checked()).toHaveLength(1);
    expect((await checked())[0]).toContain("Shorten it");
    // On to the note field, and Return answers this page and moves to the next.
    await page.keyboard.press("Tab");
    await page.keyboard.type("keep the comma");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="group"] [role="checkbox"]');
    expect(await page.textContent("section h2")).toBe("Photo");
    // Several choices on a multi-select question.
    await page.focus('[role="checkbox"]');
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    expect(await page.$$eval('[role="checkbox"][aria-checked="true"]', (e) => e.length)).toBe(2);
  });
});
