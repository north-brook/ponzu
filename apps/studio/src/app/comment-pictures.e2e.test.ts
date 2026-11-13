/*
 * A comment's picture, in the studio as it ships, in a real Chromium, on Ponzu Cloud in memory
 * (fake-host.ts): a comment on a board's headline, one on the ground between two boards,
 * and a reply each show in the thread with a picture of where they were left the moment they
 * appear there, and keep it with the comment; a teammate's comes from the canvas's files; one
 * with no picture says where it was left; and the picture goes to the comment, resolved or
 * deleted since. All of it twice: drawn in the window, as in a browser, and drawn in the
 * desktop's picture window (another page here), which leaves nothing of it in the window and
 * draws the same pictures. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves the window, the rail and every picture drawn
 * there, in light and in dark. With PONZU_FIXTURES set as well, the first picture becomes the
 * gallery's (gallery/previews/comment-hero-*.webp).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artboard, PElement } from "@ponzu/core";
import { type Browser, chromiumPath, launch, type Page, STUDIO } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(120_000);

const SHOTS = process.env.PONZU_SHOTS;
const FIXTURES = process.env.PONZU_FIXTURES;

let ids = 0;
const el = (tag: string, style: Record<string, string>, children: PElement["children"] = []) =>
  ({
    kind: "el",
    id: `n_e2e${++ids}`,
    tag,
    attrs: {},
    style,
    children,
  }) as PElement;
const text = (value: string) => ({ kind: "text" as const, value });
const sans = "Inter, system-ui, sans-serif";

/** A shop's hero, as an agent would draw one: the gallery's "Hero" at full size. */
function hero(x: number): Artboard {
  const root = el(
    "section",
    {
      width: "1200px",
      height: "720px",
      background: "light-dark(#f3efe6, #1c211b)",
      color: "light-dark(#1f2a1d, #eef0e6)",
      display: "flex",
      "flex-direction": "column",
      gap: "48px",
      padding: "56px 64px",
      "box-sizing": "border-box",
    },
    [
      el(
        "nav",
        {
          display: "flex",
          "justify-content": "space-between",
          font: `500 18px/1 ${sans}`,
          "letter-spacing": "0.08em",
          color: "light-dark(#4b5a46, #a9b8a1)",
        },
        [el("span", {}, [text("FERNWOOD")]), el("span", {}, [text("Shop · Care · Journal")])],
      ),
      el("div", { display: "grid", "grid-template-columns": "1.1fr 1fr", gap: "48px", flex: "1" }, [
        el("div", { display: "flex", "flex-direction": "column", gap: "28px" }, [
          el("h1", { margin: "0", font: "400 84px/1 Georgia, serif" }, [
            text("Plants that outlive your lease"),
          ]),
          el(
            "p",
            {
              margin: "0",
              "max-width": "460px",
              font: `400 22px/1.5 ${sans}`,
              color: "light-dark(#4b5a46, #a9b8a1)",
            },
            [
              text(
                "Hardy, slow-growing greens, potted to travel and chosen to forgive a missed watering.",
              ),
            ],
          ),
          el(
            "a",
            {
              "align-self": "flex-start",
              background: "light-dark(#1f2a1d, #d9e4cf)",
              color: "light-dark(#f3efe6, #1c211b)",
              font: `600 18px/1 ${sans}`,
              padding: "18px 28px",
              "border-radius": "999px",
            },
            [text("Shop the collection")],
          ),
        ]),
        el("div", {
          "border-radius": "16px",
          background: "radial-gradient(circle at 40% 35%, #9bb48a, #4f6b45 60%, #2f4429)",
        }),
      ]),
    ],
  );
  return { id: root.id, name: "Hero", x, y: 0, root };
}

/** Three plans side by side. */
function plans(x: number): Artboard {
  const card = (name: string, price: string, lead = false) =>
    el(
      "div",
      {
        display: "flex",
        "flex-direction": "column",
        gap: "16px",
        padding: "32px",
        "border-radius": "16px",
        background: lead ? "#1f2a1d" : "light-dark(#ffffff, #262b25)",
        color: lead ? "#f3efe6" : "inherit",
      },
      [
        el("span", { font: `600 20px/1 ${sans}` }, [text(name)]),
        el("span", { font: "400 56px/1 Georgia, serif" }, [text(price)]),
      ],
    );
  const root = el(
    "section",
    {
      width: "1200px",
      height: "720px",
      background: "light-dark(#f3efe6, #1c211b)",
      color: "light-dark(#1f2a1d, #eef0e6)",
      display: "grid",
      "grid-template-columns": "1fr 1fr 1fr",
      "align-items": "center",
      gap: "24px",
      padding: "64px",
      "box-sizing": "border-box",
    },
    [card("Seedling", "$9"), card("Grower", "$19", true), card("Greenhouse", "$39")],
  );
  return { id: root.id, name: "Plans", x, y: 0, root };
}

/**
 * A long landing page, a hundred and twenty rows of cards with shadows and gradients: far more
 * board than a picture's area round a pin. With how many elements it has.
 */
function longPage(x: number): { board: Artboard; elements: number } {
  const sections = Array.from({ length: 120 }, (_, i) =>
    el(
      "section",
      {
        display: "grid",
        "grid-template-columns": "repeat(4, 1fr)",
        gap: "16px",
        padding: "24px 64px",
        background: i % 2 ? "linear-gradient(180deg, #f3efe6, #e8e2d4)" : "#ffffff",
      },
      Array.from({ length: 8 }, (_, k) =>
        el(
          "div",
          {
            padding: "16px",
            "border-radius": "12px",
            background: "#ffffff",
            "box-shadow": "0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08)",
          },
          [
            el("span", { font: `600 16px/1.2 ${sans}` }, [text(`Section ${i + 1}, card ${k + 1}`)]),
            el("p", { margin: "8px 0 0", font: `400 14px/1.5 ${sans}`, color: "#4b5a46" }, [
              text("Hardy, slow-growing greens, potted to travel."),
            ]),
          ],
        ),
      ),
    ),
  );
  const root = el(
    "main",
    { width: "1200px", background: "#f3efe6", display: "flex", "flex-direction": "column" },
    sections,
  );
  const count = (node: PElement): number =>
    1 + node.children.reduce((n, c) => n + (c.kind === "el" ? count(c) : 0), 0);
  return { board: { id: root.id, name: "Long page", x, y: 0, root }, elements: count(root) };
}

/** The most characters one picture's SVG may come to (see the long board's test). */
const CHARS_BUDGET = 1_500_000;

/**
 * Counts what drawing pictures does in a page: each SVG serialised (its elements and
 * characters), the most boards the rail held at once, and the off-screen picture hosts mounted.
 */
const countPictureWork = () => {
  const seen = {
    svgs: [] as { elements: number; chars: number }[],
    railBoards: 0,
    pictureHosts: 0,
  };
  (window as unknown as { budget: typeof seen }).budget = seen;
  const serialize = XMLSerializer.prototype.serializeToString;
  XMLSerializer.prototype.serializeToString = function (node: Node) {
    const out = serialize.call(this, node);
    if (node.nodeName === "svg") {
      const elements = (node as Element).getElementsByTagName("*").length;
      seen.svgs.push({ elements, chars: out.length });
    }
    return out;
  };
  const look = (records: MutationRecord[]) => {
    const n = document.querySelectorAll("#thread [data-artboard-host]").length;
    seen.railBoards = Math.max(seen.railBoards, n);
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.commentPicture !== undefined) {
          seen.pictureHosts++;
        }
      }
    }
  };
  const watch = () =>
    new MutationObserver(look).observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
  if (document.documentElement) watch();
  else document.addEventListener("DOMContentLoaded", watch);
};
type Budget = {
  svgs: { elements: number; chars: number }[];
  railBoards: number;
  pictureHosts: number;
};

/**
 * The desktop's picture window, as the shell is to the studio there (picture-preload.ts): the
 * test hands it each picture to draw and takes its answer. Bytes go as plain arrays, which the
 * test's own glue turns back into bytes.
 */
const pictureHostGlue = () => {
  const waiting = new Map<number, (answer: unknown) => void>();
  let listener: ((id: number, request: unknown) => void) | null = null;
  const w = window as unknown as Record<string, unknown>;
  w.ponzuPictureHost = {
    onRequest: (heard: typeof listener) => {
      listener = heard;
    },
    answer: (id: number, answer: { ok: boolean; light?: Uint8Array; dark?: Uint8Array }) => {
      const resolve = waiting.get(id);
      waiting.delete(id);
      resolve?.(
        answer.ok ? { ok: true, light: [...answer.light!], dark: [...answer.dark!] } : answer,
      );
    },
  };
  w.testDraw = (id: number, request: unknown) =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
      listener!(id, request);
    });
};

/** The studio's window, with the shell's picture window to draw in (`ponzuFakePictures`). */
const pictureWindowGlue = () => {
  const w = window as unknown as Record<string, unknown>;
  const elsewhere = w.testDrawElsewhere as (request: unknown) => Promise<{
    ok: boolean;
    light?: number[];
    dark?: number[];
  }>;
  w.ponzuFakePictures = {
    draw: async (request: unknown) => {
      const answer = await elsewhere(request);
      return answer.ok
        ? { ok: true, light: new Uint8Array(answer.light!), dark: new Uint8Array(answer.dark!) }
        : answer;
    },
  };
};

/** Every picture the first run (drawn in the window) kept, by its comment's words and theme. */
const drawnInTheWindow = new Map<string, number[]>();

/*
 * Twice: as in a browser, where the window draws its comments' pictures itself, and as in the
 * desktop app, where the shell's hidden picture window draws them, here another page in picture
 * mode. The pictures must be the same, pixel for pixel.
 */
for (const mode of ["window", "picture window"] as const) {
  describe.skipIf(!chromiumPath)(`a comment's picture, drawn in the ${mode}`, () => {
    let dir: string;
    let server: ReturnType<typeof serve>;
    let browser: Browser;
    let page: Page;
    /** The picture window's page, in that run. */
    let host: Page | null = null;
    const errors: string[] = [];
    const shooting = mode === "window";

    beforeAll(async () => {
      dir = await buildApp("e2e");
      server = serve(dir);
      browser = await launch();
      page = await browser.newPage({ deviceScaleFactor: 2 });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.addInitScript(countPictureWork);
      if (mode === "picture window") {
        const drawer = await browser.newPage({ deviceScaleFactor: 2 });
        host = drawer;
        await drawer.setViewportSize({ width: 480, height: 320 });
        await drawer.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
        drawer.on("pageerror", (error) => errors.push(`picture window: ${error}`));
        await drawer.addInitScript(countPictureWork);
        await drawer.addInitScript(pictureHostGlue);
        await drawer.goto(server.url);
        let ids = 0;
        await page.exposeFunction("testDrawElsewhere", (request: unknown) =>
          drawer.evaluate(
            ([id, asked]) =>
              (
                window as unknown as { testDraw: (id: unknown, r: unknown) => Promise<unknown> }
              ).testDraw(id, asked),
            [++ids, request] as const,
          ),
        );
        await page.addInitScript(pictureWindowGlue);
      }
      // The canvas's files, served from what the in-memory API holds.
      await page.route("https://assets.test/**", async (route) => {
        const url = route.request().url();
        const bytes = await page.evaluate((asked) => {
          for (const canvas of window.ponzuFake!.backend.canvases.values()) {
            for (const { ref, bytes } of canvas.pictures.values()) {
              if (asked.endsWith(`/${canvas.id}/${ref}`)) return [...bytes];
            }
          }
          return null;
        }, url);
        if (!bytes) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from(bytes) });
      });
      // Signed in past setup: the first run is app.e2e's and the slow-answer walks'.
      await page.goto(`${server.url}?as=returning`);
    });
    afterAll(async () => {
      if (SHOTS && shooting && page) {
        await page.screenshot({ path: join(SHOTS, "last.png") }).catch(() => {});
      }
      await browser?.close();
      server?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const fake = <T>(run: (arg: any) => T, arg?: unknown): Promise<T> =>
      page.evaluate(run as (arg: unknown) => T, arg);
    const rail = () => page.locator("#thread");
    /** The window, the rail, in light and dark. */
    const shoot = async (name: string) => {
      if (!SHOTS || !shooting) return;
      mkdirSync(SHOTS, { recursive: true });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
        await rail().screenshot({ path: join(SHOTS, `${name}-rail-${scheme}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    };
    let canvasId = "";

    /** The comments' pictures as the in-memory API keeps them, by message. */
    const kept = () =>
      fake(
        (id: string) =>
          window.ponzuFake!.backend.canvas(id).thread.flatMap(({ item }) =>
            item.kind === "comment"
              ? [
                  {
                    messageId: item.payload.messageId,
                    text: item.payload.text,
                    picture: item.payload.picture ?? null,
                  },
                ]
              : [],
          ),
        canvasId,
      );

    /**
     * Watches the rail for a comment's words appearing without a picture beside them: the
     * picture must be there the moment the comment is.
     */
    const watchForBareComments = () =>
      fake(() => {
        const seen: string[] = [];
        (window as unknown as { bare: string[] }).bare = seen;
        const check = () => {
          for (const p of document.querySelectorAll("#thread p")) {
            const said = p.textContent ?? "";
            if (!said.includes("commented:")) continue;
            const line = p.parentElement?.parentElement;
            const picture = line?.querySelector('button[aria-label^="Open the comment"]');
            if (!picture && !seen.includes(said)) seen.push(said);
          }
        };
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true });
      });
    const bare = () => fake(() => (window as unknown as { bare: string[] }).bare);

    test("into the team's canvas, with two boards drawn", async () => {
      await page.locator("#sidebar").waitFor();
      const find = () =>
        fake(
          () =>
            [...window.ponzuFake!.backend.canvases.values()].find(
              (d) => d.sequencer.doc.name === "Onboarding flow",
            )?.id ?? "",
        );
      await waitUntil(async () => (await find()) !== "");
      canvasId = await find();
      // Opened as its link opens it.
      await fake(
        (id: string) => window.ponzuFake!.link({ kind: "canvas", canvasId: id }),
        canvasId,
      );
      // Its boards, as the agent draws them: a hero and the plans beside it, a gap between.
      await fake(
        ({ id, boards }: { id: string; boards: Artboard[] }) => {
          const backend = window.ponzuFake!.backend;
          const doc = backend.canvas(id).sequencer.doc;
          const page = doc.pages[0]!;
          backend.agent(id).commit([
            ...page.artboards.map((ab) => ({ op: "artboard.delete" as const, id: ab.id })),
            ...boards.map((artboard, index) => ({
              op: "artboard.create" as const,
              page: page.id,
              index,
              artboard,
            })),
          ]);
        },
        { id: canvasId, boards: [hero(0), plans(1440)] },
      );
      await page.locator('[data-board-name][title="Plans"]').waitFor();
      await rail().waitFor();
      await watchForBareComments();
    });

    test("a comment on a board's headline shows with a picture of the headline, at once", async () => {
      await page.keyboard.press("c");
      const headline = (await page.locator("[data-artboard-host] h1").first().boundingBox())!;
      await page.mouse.click(headline.x + headline.width * 0.3, headline.y + headline.height * 0.4);
      await page.getByPlaceholder("Leave a comment…").fill("Too many words here. Calmer?");
      await page.keyboard.press("Enter");

      const picture = rail().getByRole("button", { name: "Open the comment on Hero" });
      await picture.waitFor();
      await rail().getByText("Too many words here. Calmer?").waitFor();
      // Crisp on a retina screen: twice its size as shown.
      await waitUntil(async () =>
        Boolean(
          await picture
            .locator("img")
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        ),
      );
      expect(
        await picture
          .locator("img")
          .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
      ).toEqual([480, 320]);
      // Drawn at 240 by 160, shown as a glance at three fifths of that (lines.tsx).
      expect(await picture.boundingBox()).toMatchObject({ width: 144, height: 96 });
      // And it is kept with the comment, for everyone.
      await waitUntil(async () => (await kept()).some((c) => c.picture !== null));
      const [first] = await kept();
      expect(first!.picture).toMatchObject({
        light: expect.stringMatching(/^comments\/m_\w+-light-\w+\.webp$/),
        dark: expect.stringMatching(/^comments\/m_\w+-dark-\w+\.webp$/),
      });
      await page.keyboard.press("Escape");
      await shoot("1-comment-on-a-board");
    });

    test("one on the ground between the boards shows both, and a reply shows too", async () => {
      // Both boards in view.
      await page.keyboard.press("Shift+1");
      await page.waitForTimeout(300);
      await page.keyboard.press("c");
      const left = (await page.locator("[data-pz-board]").nth(0).boundingBox())!;
      const right = (await page.locator("[data-pz-board]").nth(1).boundingBox())!;
      await page.mouse.click((left.x + left.width + right.x) / 2, left.y + left.height * 0.45);
      await page.getByPlaceholder("Leave a comment…").fill("Something to go between these two");
      await page.keyboard.press("Enter");
      await rail().getByRole("button", { name: "Open the comment on the canvas" }).waitFor();
      await page.keyboard.press("Escape");

      // A reply in the first thread, from its card on the canvas.
      await page.keyboard.press("v");
      await page.locator('button[title="Drag to move"]', { hasText: "1" }).first().click();
      await page.getByPlaceholder("Reply…").fill("Or cut the second line");
      await page.keyboard.press("Enter");
      await rail().getByText("Or cut the second line").waitFor();
      await waitUntil(async () => (await kept()).filter((c) => c.picture).length === 3);
      await page.keyboard.press("Escape");
      expect(await bare()).toEqual([]);
      await shoot("2-on-the-canvas-and-a-reply");

      if (shooting && (SHOTS || FIXTURES)) {
        for (const [index, comment] of (await kept()).entries()) {
          for (const theme of ["light", "dark"] as const) {
            const ref = comment.picture![theme];
            const bytes = await fake(
              ({ id, ref }: { id: string; ref: string }) => [
                ...[...window.ponzuFake!.backend.canvas(id).pictures.values()].find(
                  (p) => p.ref === ref,
                )!.bytes,
              ],
              { id: canvasId, ref },
            );
            if (SHOTS)
              writeFileSync(join(SHOTS, `picture-${index + 1}-${theme}.webp`), Buffer.from(bytes));
            if (FIXTURES && index === 0) {
              const to = join(STUDIO, `src/cloud/gallery/previews/comment-hero-${theme}.webp`);
              writeFileSync(to, Buffer.from(bytes));
            }
          }
        }
      }
    });

    test("a teammate's comes from the canvas's files; one with none says where it was", async () => {
      // Sam leaves one, and his app attaches a picture; and one from before there were pictures.
      await fake(async (id: string) => {
        const world = window.ponzuFake!;
        const sam = world.backend.connect(world.teammate).api;
        const doc = world.backend.canvas(id).sequencer.doc;
        const [heroBoard, plansBoard] = doc.pages[0]!.artboards;
        const author = { kind: "user" as const, id: world.teammate.id, name: "Sam Lee" };
        const thread = (tid: string, artboardId: string, mid: string, words: string) => ({
          op: "thread.create" as const,
          thread: {
            id: tid,
            artboardId,
            x: 300,
            y: 360,
            status: "open" as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [{ id: mid, author, text: words, createdAt: Date.now() }],
          },
        });
        await sam.canvases.commit(id, [
          {
            id: "op_sam1",
            op: thread("th_sam1", heroBoard!.id, "m_sam1", "The photo should lead"),
          },
          {
            id: "op_sam2",
            op: thread("th_sam2", plansBoard!.id, "m_sam2", "Make Grower stand out"),
          },
        ]);
        // His picture is a copy of the first one drawn here: what matters is where it comes from.
        const [mine] = [...world.backend.canvas(id).pictures.values()];
        const uploads = await sam.canvases.uploadCommentPicture(id, "m_sam1", {
          light: mine!.bytes,
          dark: mine!.bytes,
        });
        await sam.canvases.attachCommentPicture(id, "m_sam1", uploads);
      }, canvasId);
      const his = rail().getByRole("button", { name: "Open the comment on Hero" }).nth(2);
      await waitUntil(async () =>
        Boolean(
          await his
            .locator("img")
            .evaluate(
              (img: HTMLImageElement) =>
                img.complete &&
                img.naturalWidth === 480 &&
                img.src.startsWith("https://assets.test/"),
            ),
        ),
      );
      // The one with no picture: a quiet line naming its board, which still goes there.
      const line = rail().getByRole("button", { name: "Open the comment on Plans" });
      await line.waitFor();
      expect(await line.textContent()).toBe("On Plans");
      expect(await line.locator("img").count()).toBe(0);
      await rail().getByText("Make Grower stand out").scrollIntoViewIfNeeded();
      await shoot("3-a-teammate-and-no-picture");
    });

    test("the picture goes to the comment: open, resolved since, or deleted", async () => {
      // Resolved: its thread opens on the canvas, to be reopened.
      const [first, between] = (await kept()).map((c) => c.messageId);
      await fake(async (id: string) => {
        const world = window.ponzuFake!;
        const sam = world.backend.connect(world.teammate).api;
        const threads = world.backend.canvas(id).sequencer.doc.threads;
        const [hero, open] = threads;
        await sam.canvases.commit(id, [
          {
            id: "op_res",
            op: { op: "thread.update", id: hero!.id, status: "resolved", updatedAt: Date.now() },
          },
          { id: "op_del", op: { op: "thread.delete", id: open!.id } },
        ]);
      }, canvasId);
      expect(first && between).toBeTruthy();
      await rail().getByRole("button", { name: "Open the comment on Hero" }).first().click();
      await page.getByPlaceholder("Reply to reopen…").waitFor();
      // The pin is in the middle of the main pane.
      const pane = (await page.locator(".pz-root").first().boundingBox())!;
      const pin = (await page.locator("[data-comment-open] button").first().boundingBox())!;
      expect(Math.abs(pin.x + pin.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(40);
      await shoot("4-resolved-opens");
      await page.keyboard.press("Escape");

      // Deleted: the canvas goes to where it was, and says so.
      await rail().getByRole("button", { name: "Open the comment on the canvas" }).click();
      await page.getByText("That comment was deleted.").waitFor();
      await shoot("5-deleted-goes-where-it-was");
      expect(errors).toEqual([]);
    });

    /*
     * What one comment's picture may cost the window, counted rather than timed. Its picture copies
     * only what can show in it, not the whole board it is on, and only the fonts its characters
     * need; the rail never draws a second live copy of the boards meanwhile; and no
     * long-animation-frame entry, which Chromium keeps for the life of the window, names the
     * picture's SVG (an image's load handler running long once kept every picture's data: URL,
     * tens of megabytes each, that way). Chromium keeps each image's data: URL besides, so the
     * SVG's own size is held to a budget too.
     */
    test("a comment on a long board copies only what its picture shows, and keeps none of it", async () => {
      await page.keyboard.press("Escape");
      const { board, elements } = longPage(3000);
      await fake(
        ({ id, board }: { id: string; board: Artboard }) => {
          const backend = window.ponzuFake!.backend;
          const page = backend.canvas(id).sequencer.doc.pages[0]!;
          backend
            .agent(id)
            .commit([{ op: "artboard.create" as const, page: page.id, index: 2, artboard: board }]);
        },
        { id: canvasId, board },
      );
      const sheet = page.locator(`[data-pz-board="${board.id}"]`);
      await sheet.waitFor();
      const budgetOf = (on: Page) =>
        on.evaluate(() => (window as unknown as { budget: Budget }).budget);
      const fresh = (on: Page) =>
        on.evaluate(() => {
          const seen = (window as unknown as { budget: Budget }).budget;
          seen.svgs.length = 0;
          seen.railBoards = 0;
          seen.pictureHosts = 0;
        });
      // The comments so far: in the desktop app's way, the window drew nothing of any picture.
      const sofar = await budgetOf(page);
      if (host) {
        expect(sofar.svgs).toEqual([]);
        expect(sofar.pictureHosts).toBe(0);
        expect((await budgetOf(host)).svgs.length).toBe(6);
      } else {
        expect(sofar.svgs.length).toBe(6);
      }
      await fresh(page);
      if (host) await fresh(host);
      await fake(
        ({ id, artboardId }: { id: string; artboardId: string }) =>
          window.ponzuFake!.link({ kind: "canvas", canvasId: id, artboardId }),
        { id: canvasId, artboardId: board.id },
      );
      await page.waitForTimeout(400);
      await page.keyboard.press("c");
      // Halfway down the part of the board in view.
      const box = (await sheet.boundingBox())!;
      const pane = (await page.locator(".pz-root").first().boundingBox())!;
      const top = Math.max(box.y, pane.y);
      const bottom = Math.min(box.y + box.height, pane.y + pane.height);
      await page.mouse.click(box.x + box.width * 0.3, (top + bottom) / 2);
      await page.getByPlaceholder("Leave a comment…").fill("Halfway down, the cards blur together");
      await page.keyboard.press("Enter");
      await rail().getByRole("button", { name: "Open the comment on Long page" }).waitFor();
      await waitUntil(async () =>
        (await kept()).some((c) => c.text.startsWith("Halfway down") && c.picture !== null),
      );
      await page.keyboard.press("Escape");

      const inWindow = await budgetOf(page);
      // Light and dark, each a fraction of the board: the area round the pin, and empty boxes in
      // place of the rest, and the SVG within its budget; drawn by the picture window where there
      // is one, and then nothing of it in the person's window.
      const { svgs } = host ? await budgetOf(host) : inWindow;
      expect(svgs).toHaveLength(2);
      for (const { elements: copied, chars } of svgs) {
        expect(copied).toBeLessThan(elements / 4);
        expect(chars).toBeLessThan(CHARS_BUDGET);
      }
      if (host) {
        expect(inWindow.svgs).toEqual([]);
        expect(inWindow.pictureHosts).toBe(0);
      } else {
        expect(inWindow.pictureHosts).toBe(1);
      }
      expect(inWindow.railBoards).toBe(0);
      // No long-animation-frame entry Chromium holds names anything the size of a picture.
      const longest = await fake(
        () =>
          new Promise<number>((resolve) => {
            const observer = new PerformanceObserver((list) => {
              observer.disconnect();
              const scripts = list
                .getEntries()
                .flatMap((e) => (e as unknown as { scripts: { invoker: string }[] }).scripts);
              resolve(Math.max(0, ...scripts.map((s) => s.invoker.length)));
            });
            observer.observe({ type: "long-animation-frame", buffered: true });
            setTimeout(() => resolve(0), 2_000);
          }),
      );
      expect(longest).toBeLessThan(10_000);
      expect(errors).toEqual([]);
    });

    /*
     * What is copied is chosen by layout boxes, and a shadow paints past its element's box. A small
     * box at the top of a tall board, whose child's shadow spreads over the whole board, is far
     * from a pin halfway down, yet its shadow is in the picture, as on the canvas.
     */
    test("a shadow cast from far outside the picture is still in it", async () => {
      await page.keyboard.press("Escape");
      const root = el(
        "main",
        { width: "1200px", height: "3200px", background: "#ffffff", position: "relative" },
        [
          el(
            "div",
            { position: "absolute", left: "580px", top: "0", width: "40px", height: "20px" },
            [
              el("div", {
                width: "40px",
                height: "20px",
                "box-shadow": "0 0 0 2400px rgb(37, 99, 235)",
              }),
            ],
          ),
        ],
      );
      const board: Artboard = { id: root.id, name: "Far shadow", x: 4600, y: 0, root };
      await fake(
        ({ id, board }: { id: string; board: Artboard }) => {
          const backend = window.ponzuFake!.backend;
          const page = backend.canvas(id).sequencer.doc.pages[0]!;
          backend
            .agent(id)
            .commit([{ op: "artboard.create" as const, page: page.id, index: 3, artboard: board }]);
        },
        { id: canvasId, board },
      );
      const sheet = page.locator(`[data-pz-board="${board.id}"]`);
      await sheet.waitFor();
      await fake(
        ({ id, artboardId }: { id: string; artboardId: string }) =>
          window.ponzuFake!.link({ kind: "canvas", canvasId: id, artboardId }),
        { id: canvasId, artboardId: board.id },
      );
      await page.waitForTimeout(400);
      await page.keyboard.press("c");
      const box = (await sheet.boundingBox())!;
      const pane = (await page.locator(".pz-root").first().boundingBox())!;
      const top = Math.max(box.y, pane.y);
      const bottom = Math.min(box.y + box.height, pane.y + pane.height);
      await page.mouse.click(box.x + box.width * 0.3, (top + bottom) / 2);
      await page.getByPlaceholder("Leave a comment…").fill("Under the far shadow");
      await page.keyboard.press("Enter");
      await waitUntil(async () =>
        (await kept()).some((c) => c.text === "Under the far shadow" && c.picture !== null),
      );
      await page.keyboard.press("Escape");
      // The light picture's corner, away from the pin: the shadow's blue, not the board's white.
      const corner = await fake(
        async ({ id, text }: { id: string; text: string }) => {
          const canvas = window.ponzuFake!.backend.canvas(id);
          const item = canvas.thread.find(
            ({ item }) => item.kind === "comment" && item.payload.text === text,
          )!.item as { payload: { picture: { light: string } } };
          const file = [...canvas.pictures.values()].find(
            (p) => p.ref === item.payload.picture.light,
          )!;
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(file.bytes)], { type: "image/webp" }),
          );
          const drawn = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          drawn.drawImage(bitmap, 0, 0);
          return [...drawn.getImageData(12, 12, 1, 1).data];
        },
        { id: canvasId, text: "Under the far shadow" },
      );
      const [r, , b] = corner as number[];
      expect(b! - r!).toBeGreaterThan(100);
      expect(errors).toEqual([]);
    });

    test("every picture is the same, pixel for pixel, wherever it was drawn", async () => {
      const mine = (await kept()).filter((c) => c.picture && !c.messageId.startsWith("m_sam"));
      expect(mine).toHaveLength(5);
      for (const comment of mine) {
        for (const theme of ["light", "dark"] as const) {
          const bytes = await fake(
            ({ id, ref }: { id: string; ref: string }) => [
              ...[...window.ponzuFake!.backend.canvas(id).pictures.values()].find(
                (p) => p.ref === ref,
              )!.bytes,
            ],
            { id: canvasId, ref: comment.picture![theme] },
          );
          const key = `${comment.text} (${theme})`;
          if (mode === "window") {
            drawnInTheWindow.set(key, bytes);
            continue;
          }
          const before = drawnInTheWindow.get(key);
          // The window's run comes first: run the file whole.
          expect(before).toBeDefined();
          // Decoded and compared pixel by pixel: how many differ at all.
          const differ = await fake(
            async ([a, b]: number[][]) => {
              const pixels = async (bytes: number[]) => {
                const bitmap = await createImageBitmap(
                  new Blob([new Uint8Array(bytes)], { type: "image/webp" }),
                );
                const drawn = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
                drawn.drawImage(bitmap, 0, 0);
                return drawn.getImageData(0, 0, bitmap.width, bitmap.height).data;
              };
              const [x, y] = [await pixels(a!), await pixels(b!)];
              if (x.length !== y.length) return -1;
              let n = 0;
              for (let i = 0; i < x.length; i += 4) {
                if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++;
              }
              return n;
            },
            [before!, bytes],
          );
          expect({ key, differ }).toEqual({ key, differ: 0 });
        }
      }
    });
  });
}
