import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import { launchChromium, type TestChromium } from "@ponzu/render/testing";
import { bundle, canvasCss } from "./dom-lib.ts";
import { THAW_BUDGET } from "./snapshot.tsx";

/*
 * A cold open without pictures (Ponzu Cloud), in a real browser. A page's boards don't all build
 * in its first frame: each on-screen board goes live through the thaw queue, nearest the middle
 * first, at most a frame's budget of elements a frame (or one board bigger than that), and a
 * board far off screen isn't built at all until the camera comes near it. Every check is a count
 * (boards built, elements built in a frame, DOM nodes), never a time.
 */

type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
const chromium = findChromium();
setDefaultTimeout(60_000);

/** Elements each board has: 1 section, 150 rows of a div and 3 spans. */
const PER_BOARD = 1 + 150 * 4;
const BOARDS = 40;

const ENTRY = `
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { emptyDoc, parseArtboardFile } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { boardCost } from "./coldopen.ts";
import { thawsQueued, watchThaws } from "./snapshot.tsx";
import { MemorySource } from "./connection.ts";

/*
 * What each frame's thaw took, as the queue took it (rank and cost): a frame's boards show in the
 * page only once React commits them, which under load may be together with the next frame's.
 */
window.pzTicks = [];
watchThaws((taken) => window.pzTicks.push(taken));
/*
 * Before each run of the thaw queue, the boards built since the last run. Only the first group is
 * read: what the page built as it mounted.
 */
const raf = window.requestAnimationFrame.bind(window);
window.pzGroups = [];
const builtNow = () =>
  [...document.querySelectorAll("[data-artboard-host]")]
    .filter((h) => h.shadowRoot?.querySelector("[data-artboard]"))
    .map((h) => h.getAttribute("data-artboard-host"));
let seen = new Set();
const group = () => {
  const now = builtNow();
  const fresh = now.filter((id) => !seen.has(id));
  seen = new Set(now);
  window.pzGroups.push(fresh);
};
window.requestAnimationFrame = (cb) =>
  raf((t) => {
    if (cb.name === "thawTick") group();
    cb(t);
  });
window.pzGroup = group;
window.pzQueued = thawsQueued;

const rows = Array.from({ length: 150 }, (_, i) =>
  i === 75
    ? '<div data-id="n_target" style="position:absolute;left:300px;top:200px;width:100px;height:50px"><span>a</span><span>b</span><span>c</span></div>'
    : '<div style="height:6px"><span>a</span><span>b</span><span>c</span></div>',
).join("");

window.pzMount = (opts) => {
  const doc = emptyDoc("Forty");
  const artboards = Array.from({ length: ${BOARDS} }, (_, i) => {
    const id = "ab_" + i;
    const { artboard } = parseArtboardFile(
      '<section data-artboard data-id="' + id + '" data-name="Board ' + i + '" style="position:relative;width:1440px;height:1000px;background:#f4f1ea">' + rows + "</section>",
      { id, name: "Board " + i },
    );
    return { ...artboard, x: (i % 8) * 1640, y: Math.floor(i / 8) * 1200 };
  });
  doc.pages.push({ id: "pg_a", name: "Page 1", artboards });
  // A comment on a node of the far board, saved with a spot that isn't the node's: its pin goes
  // where the node is once the board is built.
  doc.threads.push({
    id: "th_far",
    artboardId: "ab_39",
    nodeId: "n_target",
    offset: { x: 5, y: 5 },
    x: 10,
    y: 10,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "m_1", author: { kind: "user", name: "Sam" }, text: "Here", createdAt: 1 }],
  });
  window.pzCosts = Object.fromEntries(artboards.map((a) => [a.id, boardCost(a).elements]));
  const source = new MemorySource(doc);
  const root = createRoot(document.getElementById("host"));
  window.pzShow = (link) => root.render(createElement(Canvas, { source, link }));
  // Mounted in this task, so the first group is what the mount itself built.
  flushSync(() => window.pzShow(opts?.link));
  group();
};
`;

/** Waits until nothing is queued to go live and the built boards are the same three frames running. */
const settled = (page: Page) =>
  page.waitForFunction(
    () => {
      const w = window as any;
      const now = [...document.querySelectorAll("[data-artboard-host]")]
        .filter((h) => h.shadowRoot?.querySelector("[data-artboard]"))
        .map((h) => h.getAttribute("data-artboard-host"))
        .join(",");
      const tiers = [...document.querySelectorAll("[data-pz-tier]")]
        .map((e) => e.getAttribute("data-pz-tier"))
        .join(",");
      const key = `${now}|${tiers}|${w.pzQueued()}`;
      if (w.pzQueued() === 0 && key === w.pzRest?.key) w.pzRest.same++;
      else w.pzRest = { key, same: 0 };
      return w.pzRest.same >= 3;
    },
    undefined,
    { polling: "raf" },
  );

const built = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-artboard-host]")]
      .filter((h) => h.shadowRoot?.querySelector("[data-artboard]"))
      .map((h) => h.getAttribute("data-artboard-host")!),
  );

/**
 * The far board's comment pin sits on its node, at the node's corner plus the offset, not at the
 * spot saved with it: its board was built after the page mounted, and the pins were measured again.
 */
const expectPinOnNode = async (page: Page) => {
  const at = await page.evaluate(() => {
    const host = document.querySelector('[data-artboard-host="ab_39"]')!;
    const node = host.shadowRoot!.querySelector('[data-id="n_target"]')!.getBoundingClientRect();
    const pin = document.querySelector('button[title="Drag to move"]')!.parentElement!;
    const p = pin.getBoundingClientRect();
    const layer = document.querySelector("[data-pz-layer]")!;
    const zoom = new DOMMatrix(getComputedStyle(layer).transform).a;
    return { node: { x: node.left, y: node.top }, pin: { x: p.left, y: p.top }, zoom };
  });
  expect(Math.abs(at.pin.x - (at.node.x + 5 * at.zoom))).toBeLessThan(1.5);
  expect(Math.abs(at.pin.y - (at.node.y + 5 * at.zoom))).toBeLessThan(1.5);
};

describe.skipIf(!chromium)("a cold open without pictures, in Chromium", () => {
  let browser: TestChromium;
  let code: string;
  let css: string;

  beforeAll(async () => {
    [code, css] = await Promise.all([
      bundle("cold-open", ENTRY, { "process.env.NODE_ENV": '"production"' }),
      canvasCss(),
    ]);
    browser = await launchChromium(chromium!);
  });
  afterAll(() => browser?.close());

  const open = async (link?: { page: string; artboard: string }) => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate((link) => (window as any).pzMount({ link }), link);
    await settled(page);
    return page;
  };

  test("a page of forty boards builds them over frames, nearest first, a frame's budget at a time", async () => {
    const page = await open();
    const { groups, ticks, costs } = await page.evaluate(() => {
      const w = window as any;
      return {
        groups: w.pzGroups as string[][],
        ticks: w.pzTicks as { rank: number; cost: number }[][],
        costs: w.pzCosts as Record<string, number>,
      };
    });
    // The page fits all forty on screen, and every one of them ends up drawn: nothing left blank.
    expect((await built(page)).length).toBe(BOARDS);
    const tiers = await page.evaluate(() =>
      [...document.querySelectorAll("[data-pz-tier]")].map((e) => e.getAttribute("data-pz-tier")),
    );
    expect(tiers).toEqual(Array(BOARDS).fill("live"));
    expect(await page.locator("[data-pz-placeholder]").count()).toBe(0);
    // None was built as the page mounted: on main all forty were, in one frame.
    expect(groups[0]).toEqual([]);
    // Each frame brings at most the budget's worth of elements live (or one board bigger than
    // that), so the forty take several: counted as the queue took them, whenever React committed.
    const frames = ticks.filter((taken) => taken.length);
    for (const taken of frames) {
      const spent = taken.reduce((n, t) => n + t.cost, 0);
      expect(taken.length === 1 || spent <= THAW_BUDGET).toBe(true);
    }
    expect(costs.ab_0).toBe(PER_BOARD);
    expect(frames.length).toBeGreaterThanOrEqual(Math.ceil((BOARDS * PER_BOARD) / THAW_BUDGET));
    // Nearest the middle first: no board goes live in a later frame than one farther out.
    for (let k = 1; k < frames.length; k++) {
      const before = Math.max(...frames[k - 1]!.map((t) => t.rank));
      const after = Math.min(...frames[k]!.map((t) => t.rank));
      expect(after).toBeGreaterThanOrEqual(before - 0.5);
    }
    // The camera never moved, and the pin on the last board built is on its node all the same.
    await expectPinOnNode(page);
    await page.close();
  });

  test("opened on one board, the boards far off screen aren't built until the camera comes near", async () => {
    const page = await open({ page: "pg_a", artboard: "ab_19" });
    const near = await built(page);
    // The board and its neighbours within the margin, not the page's forty.
    expect(near).toContain("ab_19");
    expect(near.length).toBeLessThanOrEqual(9);
    expect(near).not.toContain("ab_39");
    const nodes = await page.evaluate(() =>
      [...document.querySelectorAll("[data-artboard-host]")].reduce(
        (n, h) => n + (h.shadowRoot?.querySelectorAll("*").length ?? 0),
        0,
      ),
    );
    expect(nodes).toBeLessThanOrEqual(9 * (PER_BOARD + 4));
    // Going there builds it and draws it, and its comment's pin goes onto its node.
    await page.evaluate(() => (window as any).pzShow({ page: "pg_a", artboard: "ab_39" }));
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-pz-board="ab_39"] [data-pz-tier]')
          ?.getAttribute("data-pz-tier") === "live",
    );
    await settled(page);
    await expectPinOnNode(page);
    // The boards it left stay built: a board that was drawn never has to be built again.
    const after = await built(page);
    for (const id of near) expect(after).toContain(id);
    await page.close();
  });
});
