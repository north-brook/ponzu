/*
 * Switching between canvases, in the studio as it ships (fake-host.ts, a real Chromium): a canvas
 * the window has left holds no memory once another is open. Every opening makes a few copies of
 * a canvas's document (the replica's confirmed and shown documents, the boards on screen); this
 * counts, in V8's heap after a full collection, how many objects are one board's root element,
 * after the first opening and again after going away and back several times. The count is of
 * objects, not bytes or milliseconds, so a slow machine doesn't change it. Skips where there is
 * no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve } from "./e2e-lib.ts";

setDefaultTimeout(180_000);

/** The board whose copies are counted: its root's id is found nowhere else. */
const BOARD = "ab_kept_count";
const ROUNDS = 4;

interface Cdp {
  send(method: string, params?: object): Promise<any>;
  detach(): Promise<void>;
}

/** How many objects in the page's heap, after a full collection, are the board's root element. */
async function copies(cdp: Cdp): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const proto = await cdp.send("Runtime.evaluate", { expression: "Object.prototype" });
  const found = await cdp.send("Runtime.queryObjects", {
    prototypeObjectId: proto.result.objectId,
    objectGroup: "count",
  });
  const counted = await cdp.send("Runtime.callFunctionOn", {
    objectId: found.objects.objectId,
    functionDeclaration: `function (id) {
      let n = 0;
      for (const o of this) if (o && o.kind === "el" && o.id === id) n++;
      return n;
    }`,
    arguments: [{ value: BOARD }],
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "count" });
  await cdp.send("Runtime.releaseObject", { objectId: proto.result.objectId });
  return counted.result.value as number;
}

describe.skipIf(!chromiumPath)("switching between canvases", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  let cdp: Cdp;
  let ids: { kept: string; other: string };

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.url}?as=returning`);
    await page.locator("[data-canvas-row]").first().waitFor({ timeout: 30_000 });
    ids = await page.evaluate(async (board) => {
      const w = window.ponzuFake!;
      const me = w.backend.connect(w.me).api;
      const first = [...w.backend.canvases.values()][0]!;
      const make = (name: string) =>
        me.canvases.create({ workspaceId: w.workspaceId, repoId: first.repoId!, name });
      const kept = await make("Kept");
      const other = await make("Other");
      const doc = w.backend.canvas(kept.id).sequencer.doc;
      // A board with something in it, as a canvas has.
      const children = Array.from({ length: 200 }, (_, i) => ({
        kind: "el" as const,
        id: `el_kept_${i}`,
        tag: "p",
        attrs: {},
        style: { padding: "8px", "box-shadow": "0 1px 2px rgb(0 0 0 / 0.2)" },
        children: [{ kind: "text" as const, value: `Line ${i} of the kept board` }],
      }));
      w.backend.agent(kept.id).commit([
        {
          op: "artboard.create",
          page: doc.pages[0]!.id,
          index: 0,
          artboard: {
            id: board,
            name: "Kept board",
            x: 0,
            y: 0,
            root: {
              kind: "el",
              id: board,
              tag: "section",
              attrs: {},
              style: { width: "800px", display: "flex", "flex-direction": "column" },
              children,
            },
          },
        },
      ]);
      w.drawBoard(other.id, "Elsewhere");
      return { kept: kept.id, other: other.id };
    }, BOARD);
    cdp = (await page.context().newCDPSession(page)) as unknown as Cdp;
    await cdp.send("HeapProfiler.enable");
  });
  afterAll(async () => {
    await cdp?.detach().catch(() => {});
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const open = async (id: string, board: string) => {
    await page.locator(`[data-canvas-row="${id}"]`).click();
    await page.locator(`[data-board-name][title="${board}"]`).waitFor({ timeout: 30_000 });
    // Its first reads answered and its boards drawn.
    await page.waitForTimeout(1_000);
  };

  test("a canvas left for another is let go: going back and forth keeps no more copies", async () => {
    await open(ids.kept, "Kept board");
    const once = await copies(cdp);
    // The fake backend's own copies and the open canvas's.
    expect(once).toBeGreaterThan(0);
    for (let round = 0; round < ROUNDS; round++) {
      await open(ids.other, "Elsewhere");
      await open(ids.kept, "Kept board");
    }
    const after = await copies(cdp);
    // Each opening that stays reachable adds the copies one opening makes (three when this was
    // written, so twelve over four rounds when every opening was kept). A canvas closed a moment
    // ago may still be on its way out; one opening's worth is allowed for it, no more.
    expect(after).toBeLessThanOrEqual(once + 3);
  });
});
