import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Doc, emptyDoc, parseArtboardFile } from "@ponzu/core";
import { type Browser, type Page, webkit } from "playwright-core";
import { buildPage } from "./build.ts";
import { ASSETS_PLACEHOLDER, type PictureAnswer, type ToCanvas } from "./protocol.ts";

/*
 * The canvas page in WebKit (Playwright's, the engine WKWebView uses), headless, loaded as the
 * app loads it (components/canvas-view.tsx): the built page, its policy's asset origin filled
 * in, served from that origin, here a local server standing in for R2. The app's side is played
 * by an init script (as react-native-webview's own is a user script, which a page's policy does
 * not govern) and by calling the page's bridge, as `injectJavaScript` does.
 *
 * It needs Playwright's WebKit (`bunx playwright-core install webkit`); without it, it skips.
 */

const haveWebKit = (() => {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
})();

/** A 2×2 PNG, yuzu. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4f0Lu/wk5BggFADieB5Wwx1j/AAAAAElFTkSuQmCC",
  ),
  (c) => c.charCodeAt(0),
);

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
const requests: string[] = [];

beforeAll(async () => {
  if (!haveWebKit) return;
  const built = await buildPage();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(pathname);
      if (pathname === "/cnv_page/") {
        return new Response(built.replaceAll(ASSETS_PLACEHOLDER, origin), {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/cnv_page/assets/dot.png") {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      if (pathname === "/evil.js") {
        return new Response("window.__pwned = 'external'", {
          headers: { "content-type": "text/javascript" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await webkit.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const board = (id: string, x: number, inner: string) => {
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="${id}" data-name="${id}" style="width:390px;height:600px;background:#fff">${inner}</section>`,
    { id, name: id },
  );
  return { ...artboard, x };
};

function fixture(): Doc {
  const home = board(
    "ab_home",
    0,
    `<h1 data-id="n_title">Hello from the replica</h1><img data-id="n_dot" src="assets/dot.png" style="width:40px;height:40px">`,
  );
  return { ...emptyDoc("Kettle"), pages: [{ id: "pg_home", name: "Home", artboards: [home] }] };
}

/** The page open as the app opens it, with what it posts back collected in `__sent`. */
async function open(): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sent: unknown[];
      __violations: string[];
      ReactNativeWebView: { postMessage(d: string): void };
    };
    w.__sent = [];
    w.__violations = [];
    w.ReactNativeWebView = { postMessage: (d: string) => w.__sent.push(JSON.parse(d)) };
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
  });
  await page.goto(`${origin}/cnv_page/`);
  await waitForSent(page, "ready");
  return page;
}

const post = (page: Page, msg: ToCanvas) =>
  page.evaluate((m) => {
    (window as unknown as { __ponzuCanvas: { receive(m: unknown): void } }).__ponzuCanvas.receive(
      m,
    );
  }, msg);

const waitForSent = (page: Page, t: string) =>
  page.waitForFunction(
    (kind) => (window as unknown as { __sent: { t: string }[] }).__sent.some((m) => m.t === kind),
    t,
    { timeout: 15_000 },
  );

/** Text inside a board's shadow root. */
const boardText = (page: Page, id: string) =>
  page.evaluate((boardId) => {
    const host = document.querySelector(`[data-artboard-host="${boardId}"]`);
    return host?.shadowRoot?.textContent ?? null;
  }, id);

describe.skipIf(!haveWebKit)("the canvas page in WebKit", () => {
  test("draws a doc the app sends, and applies the ops after it", async () => {
    const page = await open();
    await post(page, {
      t: "insets",
      insets: { top: 103, right: 0, bottom: 34, left: 0 },
      radius: 55,
    });
    await post(page, {
      t: "doc",
      doc: fixture(),
      assetBase: `${origin}/cnv_page/`,
      theme: "light",
      file: "cnv_page",
    });
    await waitForSent(page, "drawn");
    expect(await boardText(page, "ab_home")).toContain("Hello from the replica");

    await post(page, {
      t: "op",
      op: {
        op: "artboard.create",
        page: fixture().pages[0]!.id,
        index: 1,
        artboard: board("ab_two", 480, "<p>Second</p>"),
      },
      origin: { kind: "agent", id: "claude", name: "Claude" },
    });
    await page.waitForFunction(() => document.querySelector('[data-artboard-host="ab_two"]'));
    expect(await boardText(page, "ab_two")).toContain("Second");

    // An op that doesn't fit the doc is dropped, not drawn half.
    await post(page, { t: "op", op: { op: "artboard.update", id: "ab_gone", x: 9 } });
    expect(await boardText(page, "ab_home")).toContain("Hello from the replica");
    await page.close();
  }, 60_000);

  test("loads the canvas's files from its own origin", async () => {
    const page = await open();
    await post(page, {
      t: "doc",
      doc: fixture(),
      assetBase: `${origin}/cnv_page/`,
      theme: "light",
      file: "cnv_page",
    });
    await waitForSent(page, "drawn");
    const loaded = await page.waitForFunction(
      () => {
        const host = document.querySelector('[data-artboard-host="ab_home"]');
        const img = host?.shadowRoot?.querySelector("img");
        return img && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
      },
      undefined,
      { timeout: 15_000 },
    );
    expect(await loaded.jsonValue()).toBe(`${origin}/cnv_page/assets/dot.png`);
    expect(requests).toContain("/cnv_page/assets/dot.png");
    expect(new URL(page.url()).origin).toBe(origin);
    await page.close();
  }, 60_000);

  test("its content security policy runs no script but its own", async () => {
    const page = await open();
    await page.evaluate((from) => {
      const inline = document.createElement("script");
      inline.textContent = "window.__pwned = 'inline'";
      document.head.append(inline);
      const external = document.createElement("script");
      external.src = `${from}/evil.js`;
      document.head.append(external);
      const handler = document.createElement("img");
      handler.setAttribute("onerror", "window.__pwned = 'handler'");
      handler.src = "data:,";
      document.body.append(handler);
    }, origin);
    await page.waitForFunction(
      () => (window as unknown as { __violations: string[] }).__violations.length >= 3,
      undefined,
      { timeout: 15_000 },
    );
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned),
    ).toBeUndefined();
    expect(requests).not.toContain("/evil.js");
    const violations = await page.evaluate(
      () => (window as unknown as { __violations: string[] }).__violations,
    );
    expect(violations.every((v) => v.startsWith("script-src"))).toBe(true);
    // The page's own script ran: it said ready, and its bridge is there.
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { __ponzuCanvas?: unknown }).__ponzuCanvas,
      ),
    ).toBe("object");
    await page.close();
  }, 60_000);

  test("after the Comment button, a tap drops a comment's pin; otherwise a tap is a tap", async () => {
    const page = await open();
    await post(page, {
      t: "doc",
      doc: fixture(),
      assetBase: `${origin}/cnv_page/`,
      theme: "light",
      file: "cnv_page",
    });
    await waitForSent(page, "drawn");
    const sentOf = (t: string) =>
      page.evaluate(
        (kind) =>
          (window as unknown as { __sent: { t: string }[] }).__sent.filter((m) => m.t === kind),
        t,
      );
    // The one board is framed in the middle of the screen.
    await page.touchscreen.tap(201, 437);
    await waitForSent(page, "tap");
    expect(await sentOf("longpress")).toEqual([]);

    await post(page, { t: "commenting", on: true });
    // Drawn with it (two frames: the store's render, then the gestures' reading of it).
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    // Well away from the first tap, so the two are never one double tap.
    await page.touchscreen.tap(150, 380);
    await waitForSent(page, "longpress");
    const [spot] = (await sentOf("longpress")) as unknown as {
      pageId: string;
      artboardId?: string;
      x: number;
      y: number;
    }[];
    expect(spot).toMatchObject({ pageId: "pg_home", artboardId: "ab_home" });
    // A Thread's place: inside the board, in its own px.
    expect(spot!.x).toBeGreaterThan(0);
    expect(spot!.x).toBeLessThan(390);
    expect(spot!.y).toBeGreaterThan(0);
    expect(spot!.y).toBeLessThan(600);
    await page.close();
  }, 60_000);

  test("draws a comment's picture as PNG, light and dark, under its own policy", async () => {
    const page = await open();
    const doc = fixture();
    const comment = (
      id: string,
      at: { artboardId?: string; pageId?: string; x: number; y: number },
    ) => ({
      id: `th_${id}`,
      ...at,
      status: "open" as const,
      createdAt: 0,
      updatedAt: 0,
      messages: [
        {
          id,
          author: { kind: "user" as const, id: "u_maya", name: "Maya" },
          text: "Bigger",
          createdAt: 0,
        },
      ],
    });
    await post(page, {
      t: "doc",
      doc,
      assetBase: `${origin}/cnv_page/`,
      theme: "light",
      file: "cnv_page",
    });
    await waitForSent(page, "drawn");
    // Asked for as the comment is made: its op follows the ask.
    await post(page, { t: "picture", id: "p1", threadId: "th_m_1", messageId: "m_1" });
    await post(page, {
      t: "op",
      op: { op: "thread.create", thread: comment("m_1", { artboardId: "ab_home", x: 120, y: 80 }) },
    });
    // One on the ground, far from every board: nothing round it to show.
    await post(page, {
      t: "op",
      op: {
        op: "thread.create",
        thread: comment("m_far", { pageId: "pg_home", x: 90_000, y: 90_000 }),
      },
    });
    await post(page, { t: "picture", id: "p2", threadId: "th_m_far", messageId: "m_far" });
    const answers = async () =>
      (await page
        .waitForFunction(
          () => {
            const sent = (window as unknown as { __sent: { t: string; id?: string }[] }).__sent;
            const pictures = sent.filter((m) => m.t === "picture");
            return pictures.length >= 2 ? pictures : null;
          },
          undefined,
          { timeout: 30_000 },
        )
        .then((h) => h.jsonValue())) as unknown as PictureAnswer[];
    const [first, second] = await answers();
    expect(first).toMatchObject({ id: "p1" });
    if (!first || !("light" in first)) throw new Error(`No picture: ${JSON.stringify(first)}`);
    for (const theme of [first.light, first.dark]) {
      const bytes = Uint8Array.from(atob(theme), (c) => c.charCodeAt(0));
      // PNG's signature, then its header's width and height: twice the size it is shown at.
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const view = new DataView(bytes.buffer);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([480, 320]);
    }
    expect(first.light).not.toBe(first.dark);
    expect(second).toEqual({ t: "picture", id: "p2", none: true });
    // The drawing broke nothing the page's policy holds to.
    expect(
      await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
    ).toEqual([]);
    await page.close();
  }, 90_000);

  test("a working board has its ring and no rain, on a pure white ground", async () => {
    const page = await open();
    await post(page, {
      t: "doc",
      doc: fixture(),
      assetBase: `${origin}/cnv_page/`,
      theme: "light",
      file: "cnv_page",
    });
    await waitForSent(page, "drawn");
    await post(page, { t: "working", artboards: ["ab_home"] });
    await page.waitForFunction(() => document.querySelector(".pz-ring"));
    expect(await page.evaluate(() => document.querySelectorAll(".pz-rain").length)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(255, 255, 255)",
    );
    await post(page, { t: "theme", theme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(0, 0, 0)",
    );
    await page.close();
  }, 60_000);
});
