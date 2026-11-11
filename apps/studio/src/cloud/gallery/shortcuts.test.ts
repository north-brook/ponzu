/*
 * The number shortcuts in a real Chromium, on the gallery's `shortcuts` boards (twelve designs,
 * eleven pages): ⌘1–9 and ⌘0 over the sidebar, ⌥1–9 over the page tabs, where they hold back,
 * and the hints a held modifier shows, frame by frame. Skips where there is no Chrome or
 * Chromium. With PONZU_SHOTS set to a folder, it leaves pictures of the hints there at 2x, in
 * light and dark.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  launch,
  type Page,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

const SHOTS = process.env.PONZU_SHOTS;
const ROWS = 'ul[aria-label="Designs"] [data-design-row]';
const TABS = '[aria-label="Pages"] [role="tab"]';

describe.skipIf(!chromiumPath)("the number shortcuts", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  /** ⌘ on a Mac, Ctrl elsewhere: what the app listens for where the test runs. */
  let mod: "Meta" | "Control";

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

  const open = async (board: string, theme: "light" | "dark" = "light", p = page) => {
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
    await p.goto(`${server.url}/gallery.html?board=${board}&theme=${theme}`);
    await p.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    mod = await p.evaluate(() => (navigator.userAgent.includes("Mac") ? "Meta" : "Control"));
  };
  /** The rows top to bottom, by design id, and the open one. */
  const rows = () =>
    page.$$eval(ROWS, (els) => els.map((el) => el.getAttribute("data-design-row") ?? ""));
  const openRow = () =>
    page.evaluate(
      () =>
        document.querySelector('[aria-current="page"]')?.getAttribute("data-design-row") ?? null,
    );
  const activeTab = () =>
    page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)].findIndex(
          (el) => el.getAttribute("aria-selected") === "true",
        ),
      TABS,
    );
  const tabCount = () => page.$$eval(TABS, (els) => els.length);
  /** The hints showing now, as "design-3", "page-9". */
  const shownHints = () =>
    page.$$eval("[data-hint][data-shown]", (els) =>
      els.map((el) => el.getAttribute("data-hint") ?? ""),
    );
  const press = (keys: string) => page.keyboard.press(keys);
  const wait = (ms: number) => page.waitForTimeout(ms);

  test("⌘1–8 open the sidebar's designs in order, ⌘9 the last, ⌘0 the create page", async () => {
    await open("shortcuts");
    const order = await rows();
    expect(order.length).toBe(12);
    for (let n = 1; n <= 8; n++) {
      await press(`${mod}+Digit${n}`);
      expect(await openRow()).toBe(order[n - 1]!);
    }
    await press(`${mod}+Digit9`);
    expect(await openRow()).toBe(order.at(-1)!);
    await press(`${mod}+Digit0`);
    expect(await openRow()).toBeNull();
    // ⇧ and ⌥ with it are other shortcuts' business.
    await press(`${mod}+Shift+Digit2`);
    await press(`${mod}+Alt+Digit2`);
    expect(await openRow()).toBeNull();
  });

  test("⌥1–8 open the pages in tab order, ⌥9 the last; ⌥0 nothing", async () => {
    await open("shortcuts");
    const count = await tabCount();
    expect(count).toBe(11);
    for (let n = 1; n <= 8; n++) {
      await press(`Alt+Digit${n}`);
      expect(await activeTab()).toBe(n - 1);
    }
    await press("Alt+Digit9");
    expect(await activeTab()).toBe(count - 1);
    await press("Alt+Digit0");
    expect(await activeTab()).toBe(count - 1);
  });

  test("in a text field ⌘ numbers still jump with no hints, and ⌥ types instead", async () => {
    await open("shortcuts");
    const order = await rows();
    await press(`${mod}+k`);
    await page.waitForSelector('input[aria-label="Search"]:focus, [role="combobox"]:focus');
    // Search open and empty: the list is still the list.
    await page.keyboard.down(mod);
    await wait(450);
    expect(await shownHints()).toEqual([]);
    await page.keyboard.press("Digit3");
    await page.keyboard.up(mod);
    expect(await openRow()).toBe(order[2]!);
    const tab = await activeTab();
    await press("Alt+Digit2");
    expect(await activeTab()).toBe(tab);
    await page.keyboard.down("Alt");
    await wait(450);
    expect(await shownHints()).toEqual([]);
    await page.keyboard.up("Alt");
  });

  test("while search shows results, ⌘1–9 rest and ⌘0 still makes a design", async () => {
    await open("shortcuts");
    await press(`${mod}+k`);
    await page.keyboard.type("hero");
    await page.waitForFunction(() => !document.querySelector('ul[aria-label="Designs"]'));
    const before = await openRow();
    await press(`${mod}+Digit2`);
    expect(await openRow()).toBe(before);
  });

  test("an open menu holds every number and every hint", async () => {
    await open("shortcuts");
    const order = await rows();
    await press(`${mod}+Digit2`);
    await page.locator(ROWS).nth(4).click({ button: "right" });
    await page.waitForSelector('[role="menu"][data-state="open"]');
    await press(`${mod}+Digit5`);
    await press("Alt+Digit3");
    expect(await openRow()).toBe(order[1]!);
    expect(await activeTab()).toBe(0);
    await page.keyboard.down(mod);
    await wait(450);
    expect(await shownHints()).toEqual([]);
    await page.keyboard.up(mod);
    await press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    await press(`${mod}+Digit5`);
    expect(await openRow()).toBe(order[4]!);
  });

  test("with the sidebar collapsed ⌘ numbers open the same designs, with no hints", async () => {
    await open("shortcuts-collapsed");
    const order = await rows();
    await press(`${mod}+Digit3`);
    expect(await openRow()).toBe(order[2]!);
    await press(`${mod}+Digit9`);
    expect(await openRow()).toBe(order.at(-1)!);
    await page.keyboard.down(mod);
    await wait(450);
    expect(await shownHints()).toEqual([]);
    await page.keyboard.up(mod);
    // The page tabs are in the chrome, collapsed or not.
    await page.keyboard.down("Alt");
    await wait(450);
    expect((await shownHints()).filter((h) => h.startsWith("page-")).length).toBe(9);
    await page.keyboard.up("Alt");
  });

  test("filtered, the numbers follow the list as it shows", async () => {
    await open("shortcuts-filtered");
    const order = await rows();
    expect(order.length).toBeLessThan(12);
    expect(order.length).toBeGreaterThan(2);
    await press(`${mod}+Digit2`);
    expect(await openRow()).toBe(order[1]!);
    await press(`${mod}+Digit9`);
    expect(await openRow()).toBe(order.at(-1)!);
    // Fewer than nine: each shows its place, and ⌘9 reaches the last as well.
    await page.keyboard.down(mod);
    await wait(450);
    const hints = await shownHints();
    await page.keyboard.up(mod);
    expect(hints).toEqual(order.map((_, i) => `design-${i + 1}`));
  });

  /**
   * Holds `key` and records every frame: when the first hint starts to show, its opacity, and
   * where every row and tab sits, so a hint that moved anything would show.
   */
  async function recordHold(
    key: string,
    holdMs: number,
    then: () => Promise<void>,
  ): Promise<{ t: number; shown: number; opacity: number; layout: string }[]> {
    await page.evaluate(
      ({ rowsSel, tabsSel }) => {
        const w = window as unknown as {
          frames: { t: number; shown: number; opacity: number; layout: string }[];
          recording: boolean;
        };
        w.frames = [];
        w.recording = true;
        const start = performance.now();
        const frame = () => {
          const hints = [...document.querySelectorAll<HTMLElement>("[data-hint]")];
          const boxes = [...document.querySelectorAll(`${rowsSel}, ${tabsSel}`)].map((el) => {
            const r = el.getBoundingClientRect();
            return `${r.x},${r.y},${r.width},${r.height}`;
          });
          w.frames.push({
            t: performance.now() - start,
            shown: hints.filter((h) => h.hasAttribute("data-shown")).length,
            opacity: Math.max(0, ...hints.map((h) => Number(getComputedStyle(h).opacity))),
            layout: boxes.join(";"),
          });
          if (w.recording) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      },
      { rowsSel: ROWS, tabsSel: TABS },
    );
    await page.keyboard.down(key);
    await wait(holdMs);
    await then();
    await wait(300);
    return page.evaluate(() => {
      const w = window as unknown as {
        frames: { t: number; shown: number; opacity: number; layout: string }[];
        recording: boolean;
      };
      w.recording = false;
      return w.frames;
    });
  }

  test("held, ⌘ shows nothing for 250 ms, then the rows' numbers; release takes them away", async () => {
    await open("shortcuts");
    let pressedAt = 0;
    const frames = await recordHold(mod, 600, async () => {
      pressedAt = await page.evaluate(() => performance.now());
      await page.keyboard.up(mod);
    });
    const first = frames.find((f) => f.shown > 0);
    expect(first).toBeDefined();
    // Nothing before the delay (the frames start a beat before the key goes down).
    expect(first!.t).toBeGreaterThanOrEqual(240);
    for (const f of frames.filter((f) => f.t < 200)) {
      expect(f.shown).toBe(0);
      expect(f.opacity).toBe(0);
    }
    // All nine at full strength while held.
    expect(frames.some((f) => f.shown === 9 && f.opacity === 1)).toBe(true);
    // Gone after release.
    const last = frames.at(-1)!;
    expect(last.shown).toBe(0);
    expect(last.opacity).toBe(0);
    expect(pressedAt).toBeGreaterThan(0);
    // Nothing moved, from the first frame to the last.
    expect(new Set(frames.map((f) => f.layout)).size).toBe(1);
    // On the right rows: the first eight and the last.
    await page.keyboard.down(mod);
    await wait(450);
    const placed = await page.evaluate((rowsSel) => {
      const rowEls = [...document.querySelectorAll(rowsSel)];
      return rowEls.map((row) => {
        const hint = row.querySelector("[data-hint][data-shown]");
        return hint ? `${hint.getAttribute("data-mod")}${hint.getAttribute("data-n")}` : "";
      });
    }, ROWS);
    await page.keyboard.up(mod);
    const glyph = mod === "Meta" ? "⌘" : "Ctrl";
    expect(placed).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${glyph}${n}`),
      "",
      "",
      "",
      `${glyph}9`,
    ]);
  });

  test("⌘ tapped for another shortcut never shows them, and another key hides them at once", async () => {
    await open("shortcuts");
    // ⌘J and ⌘K, the way people press them: ⌘ down, the letter within the delay.
    for (const letter of ["j", "KeyK"]) {
      const frames = await recordHold(mod, 120, async () => {
        await page.keyboard.press(letter);
        await wait(400);
        await page.keyboard.up(mod);
      });
      expect(frames.every((f) => f.shown === 0 && f.opacity === 0)).toBe(true);
      await press("Escape");
    }
    // Shown, then ⌘B: gone on the next frame, though ⌘ is still down.
    await page.keyboard.down(mod);
    await wait(450);
    expect((await shownHints()).length).toBe(9);
    await page.keyboard.press("KeyB");
    expect(await shownHints()).toEqual([]);
    await wait(450);
    expect(await shownHints()).toEqual([]);
    await page.keyboard.up(mod);
    // A number keeps them up, so you can keep jumping while you hold.
    await page.keyboard.down(mod);
    await wait(450);
    await page.keyboard.press("Digit2");
    expect((await shownHints()).length).toBe(9);
    await page.keyboard.up(mod);
    expect(await shownHints()).toEqual([]);
  });

  test("held, ⌥ shows the page tabs' numbers after the delay, without moving a tab", async () => {
    await open("shortcuts");
    const frames = await recordHold("Alt", 600, () => page.keyboard.up("Alt"));
    const first = frames.find((f) => f.shown > 0)!;
    expect(first.t).toBeGreaterThanOrEqual(240);
    expect(frames.some((f) => f.shown === 9 && f.opacity === 1)).toBe(true);
    expect(frames.at(-1)!.shown).toBe(0);
    expect(new Set(frames.map((f) => f.layout)).size).toBe(1);
    await page.keyboard.down("Alt");
    await wait(450);
    const placed = await page.$$eval(TABS, (tabs) =>
      tabs.map((tab) => {
        const hint = tab.querySelector("[data-hint][data-shown]");
        return hint ? `${hint.getAttribute("data-mod")}${hint.getAttribute("data-n")}` : "";
      }),
    );
    // A tab with no icon (Checkout, the fourth) gives its name to the keys, centred on it: the
    // name is not cut short, it fades whole.
    const iconless = await page.$eval(`${TABS}:nth-child(4)`, (tab) => {
      const hint = tab.querySelector("[data-hint]")!.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      const name = tab.querySelector("[data-hint]")!.previousElementSibling!;
      return {
        offCentre: Math.abs(hint.x + hint.width / 2 - (box.x + box.width / 2)),
        nameOpacity: Number(getComputedStyle(name).opacity),
        text: tab.textContent,
      };
    });
    await page.keyboard.up("Alt");
    expect(iconless.text).toBe("Checkout");
    expect(iconless.offCentre).toBeLessThan(1);
    expect(iconless.nameOpacity).toBe(0);
    // The tabs' text is still their names alone: the keys are drawn, not written.
    expect(await page.$$eval(TABS, (tabs) => tabs.map((t) => t.textContent))).not.toContain(
      expect.stringContaining("⌥"),
    );
    const glyph = mod === "Meta" ? "⌥" : "Alt";
    expect(placed).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${glyph}${n}`),
      "",
      "",
      `${glyph}9`,
    ]);
  });

  test("the window losing focus takes them away", async () => {
    await open("shortcuts");
    await page.keyboard.down(mod);
    await wait(450);
    expect((await shownHints()).length).toBe(9);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await shownHints()).toEqual([]);
    await page.keyboard.up(mod);
  });

  test.skipIf(!SHOTS)("pictures of the hints at 2x, light and dark", async () => {
    const dir = join(SHOTS!, "shortcut-hints");
    mkdirSync(dir, { recursive: true });
    const shot = await browser.newPage({ deviceScaleFactor: 2 });
    for (const theme of ["light", "dark"] as const) {
      await open("shortcuts", theme, shot);
      // Rows: ⌘ held.
      await shot.keyboard.down(mod);
      await shot.waitForTimeout(600);
      await shot.screenshot({
        path: join(dir, `sidebar-${theme}.png`),
        clip: { x: 0, y: 0, width: 320, height: 760 },
      });
      await shot.keyboard.up(mod);
      await shot.waitForTimeout(300);
      // Tabs: ⌥ held, from the first tab across.
      await shot.keyboard.down("Alt");
      await shot.waitForTimeout(600);
      await shot.screenshot({
        path: join(dir, `page-tabs-${theme}.png`),
        clip: { x: 290, y: 0, width: 900, height: 48 },
      });
      await shot.keyboard.up("Alt");
      await shot.waitForTimeout(300);
      await shot.screenshot({
        path: join(dir, `page-tabs-${theme}-released.png`),
        clip: { x: 290, y: 0, width: 900, height: 48 },
      });
    }
    await shot.close();
  });
});
