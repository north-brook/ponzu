/*
 * What one thing landing in an open canvas draws, in the studio as it ships (fake-host.ts, a real
 * Chromium): a comment, a reply, a resolve and an agent's commit to one board each draw the lines
 * of the thread and the boards that changed, and leave the rest of the thread, the other boards,
 * the sidebar's shell and the canvas's chrome alone. Counted with React's own commit hook, so the
 * counts are of renders, never of milliseconds: a slow machine doesn't change them. The pieces
 * are found by their props, since a production build renames components. Skips where there is no
 * Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Artboard, PElement } from "@ponzu/core";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(180_000);

/** Comments in the thread before anything is done: lines each action must not draw again. */
const SEEDED_THREADS = 12;
const SEEDED_LINES = 4;

/**
 * Installed before the app: React's commit hook, counting the renders (not the first mounts) of
 * the pieces this test is about, found by their props. Renders are counted only while `on`.
 */
const COUNTER = `(() => {
  const counts = { on: false, commits: 0, line: 0, board: 0, boards: [], sidebar: 0, chrome: 0 };
  window.__renders = counts;
  const has = (props, keys) => props && typeof props === "object" && keys.every((k) => k in props);
  const walk = (fiber) => {
    while (fiber) {
      const old = fiber.alternate;
      // A render, not a mount: a fiber that had one before and did work this time.
      if (old && fiber.flags & 1) {
        const p = fiber.memoizedProps;
        const memo = fiber.tag === 14 || fiber.tag === 15;
        if (memo && has(p, ["item", "handlers", "meId"])) counts.line++;
        if (memo && has(p, ["artboard", "rankOf", "arrivals"])) {
          counts.board++;
          if (!counts.boards.includes(p.artboard.id)) counts.boards.push(p.artboard.id);
        }
        if (has(p, ["onOpenResult", "searchMaxLength", "canvases"])) counts.sidebar++;
        if (has(p, ["activePageId", "onSelectPage", "actionExpected"])) counts.chrome++;
      }
      if (fiber.child && (!old || fiber.child !== old.child)) walk(fiber.child);
      fiber = fiber.sibling;
    }
  };
  let ids = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { const id = ++ids; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id, root) {
      counts.commits++;
      if (counts.on) walk(root.current.child);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
})();`;

interface Counts {
  commits: number;
  line: number;
  board: number;
  boards: string[];
  sidebar: number;
  chrome: number;
}

let ids = 0;
const el = (tag: string, style: Record<string, string>, children: PElement["children"] = []) =>
  ({ kind: "el", id: `n_wr${++ids}`, tag, attrs: {}, style, children }) as PElement;

function board(name: string, x: number): Artboard {
  const root = el(
    "section",
    { width: "800px", height: "600px", background: "#f3efe6", padding: "48px" },
    Array.from({ length: 6 }, (_, i) =>
      el("p", { margin: "0 0 12px", font: "400 18px/1.4 system-ui" }, [
        { kind: "text", value: `${name}, line ${i + 1}` },
      ]),
    ),
  );
  return { id: root.id, name, x, y: 0, root };
}

describe.skipIf(!chromiumPath)("what one change in a canvas draws", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  let canvasId = "";
  const boards = [board("Home", 0), board("Plans", 900), board("Checkout", 1800)];
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(COUNTER);
    await page.goto(`${server.url}?as=returning`);
    await page.locator("[data-canvas-row]").first().waitFor({ timeout: 30_000 });
    canvasId = await page.evaluate(
      async ({ boards, threads, lines }) => {
        const w = window.ponzuFake!;
        const mine = w.backend.connect(w.me).api;
        const sam = w.backend.connect(w.teammate).api;
        const first = [...w.backend.canvases.values()][0]!;
        const { id } = await mine.canvases.create({
          workspaceId: w.workspaceId,
          repoId: first.repoId!,
          name: "Counted",
        });
        const page = w.backend.canvas(id).sequencer.doc.pages[0]!.id;
        w.backend
          .agent(id)
          .commit(
            boards.map((artboard, index) => ({ op: "artboard.create", page, index, artboard })),
          );
        const old = Date.now() - 3_600_000;
        // Both of them have spoken already: a thread that becomes a team's draws every bubble
        // again with its sender's avatar, rightly, and that is not what is counted here.
        for (let i = 0; i < threads; i++) {
          const who = i % 2 ? w.me : w.teammate;
          const author = { kind: "user" as const, id: who.id, name: who.name ?? "Someone" };
          await (i % 2 ? mine : sam).canvases.commit(id, [
            {
              id: `op_wr${i}`,
              op: {
                op: "thread.create",
                thread: {
                  id: `th_wr${i}`,
                  artboardId: boards[i % boards.length]!.id,
                  x: 40 + i * 30,
                  y: 40 + i * 20,
                  status: "open",
                  createdAt: old,
                  updatedAt: old,
                  messages: [
                    { id: `m_wr${i}`, author, text: `Seeded comment ${i + 1}`, createdAt: old },
                  ],
                },
              },
            },
          ]);
        }
        for (let i = 0; i < lines; i++)
          w.backend.agent(id).say(`Seeded line ${i + 1} from Claude.`);
        return id;
      },
      { boards, threads: SEEDED_THREADS, lines: SEEDED_LINES },
    );
    await page.evaluate((id) => window.ponzuFake!.link({ kind: "canvas", canvasId: id }), canvasId);
    await page.locator(`[data-pz-board="${boards[0]!.id}"]`).waitFor({ timeout: 60_000 });
    await page.locator("#thread").getByText(`Seeded line ${SEEDED_LINES} from Claude.`).waitFor();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Until React has committed nothing for a while: what an action set going is over. */
  const settled = async () => {
    let last = -1;
    let quiet = 0;
    await waitUntil(async () => {
      const commits = await page.evaluate(() => (window as any).__renders.commits as number);
      quiet = commits === last ? quiet + 1 : 0;
      last = commits;
      return quiet >= 10;
    }, 60_000);
  };
  /** What `act` and everything it set going drew, from a settled window. */
  const counted = async (act: () => Promise<void>): Promise<Counts> => {
    await settled();
    await page.evaluate(() => {
      const r = (window as any).__renders;
      Object.assign(r, { on: true, line: 0, board: 0, boards: [], sidebar: 0, chrome: 0 });
    });
    await act();
    await settled();
    return page.evaluate(() => {
      const r = (window as any).__renders;
      r.on = false;
      return JSON.parse(JSON.stringify(r)) as Counts;
    });
  };
  const thread = () => page.locator("#thread");
  const lastThread = () =>
    page.evaluate(
      (id) => window.ponzuFake!.backend.canvas(id).sequencer.doc.threads.at(-1)!,
      canvasId,
    );

  test("the thread holds every seeded line", async () => {
    // Without them there is nothing to leave alone, and the counts below prove nothing.
    expect(
      await thread()
        .locator("p", { hasText: /Seeded comment \d+$/ })
        .count(),
    ).toBe(SEEDED_THREADS);
    // Claude's lines in a row are one turn, of which its last stays.
    expect(await thread().locator("[data-item]").count()).toBeGreaterThan(SEEDED_THREADS);
  });

  test("a comment draws its own line, and no board, other line, sidebar or chrome", async () => {
    await page.keyboard.press("c");
    const box = (await page.locator(`[data-pz-board="${boards[1]!.id}"]`).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
    await page.getByPlaceholder("Leave a comment…").fill("Counted comment");
    const counts = await counted(async () => {
      await page.keyboard.press("Enter");
      await thread().getByText("Counted comment").waitFor();
      // Its picture drawn and kept with it: the line changes as it does.
      await waitUntil(async () =>
        page.evaluate(
          (id) =>
            window
              .ponzuFake!.backend.canvas(id)
              .thread.some(
                ({ item }) =>
                  item.kind === "comment" &&
                  item.payload.text === "Counted comment" &&
                  item.payload.picture,
              ),
          canvasId,
        ),
      );
    });
    // Its own line, as its picture is drawn and then shown; every other line stays. On main
    // before this change, every line drawn was drawn again several times (30 and more here).
    expect(counts.line).toBeLessThanOrEqual(3);
    expect(counts.board).toBe(0);
    expect(counts.chrome).toBe(0);
    // The canvas's row moves in the sidebar's list: its shell draws once for that.
    expect(counts.sidebar).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
  });

  test("a reply draws its own line and nothing else of the thread", async () => {
    const t = await lastThread();
    await page.evaluate(
      ({ canvasId, t }) =>
        window.ponzuFake!.link({
          kind: "canvas",
          canvasId,
          open: "comment",
          commentThreadId: t.id,
          ...(t.artboardId ? { artboardId: t.artboardId } : {}),
        }),
      { canvasId, t },
    );
    const reply = page.getByPlaceholder("Reply…");
    await reply.fill("Counted reply");
    const counts = await counted(async () => {
      await page.keyboard.press("Enter");
      await thread().getByText("Counted reply").waitFor();
    });
    expect(counts.line).toBeLessThanOrEqual(3);
    expect(counts.board).toBe(0);
    expect(counts.chrome).toBe(0);
  });

  test("a resolve draws no line of the thread and no board", async () => {
    const counts = await counted(async () => {
      await page.locator('button[title="Resolve"]').first().click();
      await waitUntil(async () => (await lastThread()).status === "resolved");
    });
    expect(counts.line).toBe(0);
    expect(counts.board).toBe(0);
    expect(counts.chrome).toBe(0);
    await page.keyboard.press("Escape");
  });

  test("an agent's commit to one board draws that board and no line of the thread", async () => {
    const changed = boards[2]!;
    const counts = await counted(async () => {
      await page.evaluate(
        ({ canvasId, node }) =>
          window
            .ponzuFake!.backend.agent(canvasId)
            .commit([{ op: "style", id: node, style: { opacity: "0.9" } }]),
        { canvasId, node: changed.root.id },
      );
      // The board has taken it.
      await waitUntil(async () => page.evaluate(() => (window as any).__renders.boards.length > 0));
    });
    expect(counts.boards).toEqual([changed.id]);
    expect(counts.line).toBe(0);
    expect(counts.chrome).toBe(0);
  });

  test("the thread's pictures move to the new address when the file links are reset", async () => {
    // The rail no longer draws again for every op, so it must still hear the source's new file
    // address, which comes with no change to the document at all.
    const pictures = () =>
      thread()
        .locator("img[src^='https://assets.test/']")
        .evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src));
    // A teammate's seeded comment gets a picture, which the rail shows from the canvas's files.
    await page.evaluate(async (id) => {
      const w = window.ponzuFake!;
      const sam = w.backend.connect(w.teammate).api;
      const [drawn] = [...w.backend.canvas(id).pictures.values()];
      const uploads = await sam.canvases.uploadCommentPicture(id, "m_wr0", {
        light: drawn!.bytes,
        dark: drawn!.bytes,
      });
      await sam.canvases.attachCommentPicture(id, "m_wr0", uploads);
    }, canvasId);
    await waitUntil(async () => (await pictures()).length > 0);
    const before = await pictures();
    expect(before.every((src) => src.includes(`/${canvasId}/`))).toBe(true);
    await page.evaluate(async (id) => {
      const w = window.ponzuFake!;
      await w.backend.connect(w.me).api.canvases.rotateAssetKey(id);
    }, canvasId);
    await waitUntil(async () => {
      const now = await pictures();
      return now.length === before.length && now.every((src) => src.includes(`/${canvasId}-1/`));
    }, 15_000);
  });

  test("nothing went wrong in the page", () => {
    expect(errors).toEqual([]);
  });
});
