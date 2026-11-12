/*
 * A comment's picture, in the studio as it ships, in a real Chromium, on Ponzu Cloud in memory
 * (fake-host.ts): a comment on a board's headline, one on the ground between two boards,
 * and a reply each show in the thread with a picture of where they were left the moment they
 * appear there, and keep it with the comment; a teammate's comes from the design's files; one
 * with no picture says where it was left; and the picture goes to the comment, resolved or
 * deleted since. Skips where there is no Chrome or Chromium.
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

describe.skipIf(!chromiumPath)("a comment's picture, in the thread", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(String(error)));
    // The design's files, served from what the in-memory API holds.
    await page.route("https://assets.test/**", async (route) => {
      const url = route.request().url();
      const bytes = await page.evaluate((asked) => {
        for (const design of window.ponzuFake!.backend.designs.values()) {
          for (const { ref, bytes } of design.pictures.values()) {
            if (asked.endsWith(`/${design.id}/${ref}`)) return [...bytes];
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
    if (SHOTS && page) await page.screenshot({ path: join(SHOTS, "last.png") }).catch(() => {});
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fake = <T>(run: (arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(run as (arg: unknown) => T, arg);
  const rail = () => page.locator("#thread");
  /** The window, the rail, in light and dark. */
  const shoot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
      await rail().screenshot({ path: join(SHOTS, `${name}-rail-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  };
  let designId = "";

  /** The comments' pictures as the in-memory API keeps them, by message. */
  const kept = () =>
    fake(
      (id: string) =>
        window.ponzuFake!.backend.design(id).thread.flatMap(({ item }) =>
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
      designId,
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

  test("into the team's design, with two boards drawn", async () => {
    await page.locator("#sidebar").waitFor();
    const find = () =>
      fake(
        () =>
          [...window.ponzuFake!.backend.designs.values()].find(
            (d) => d.sequencer.doc.name === "Onboarding flow",
          )?.id ?? "",
      );
    await waitUntil(async () => (await find()) !== "");
    designId = await find();
    // Opened as its link opens it.
    await fake((id: string) => window.ponzuFake!.link({ kind: "design", designId: id }), designId);
    // Its boards, as the agent draws them: a hero and the plans beside it, a gap between.
    await fake(
      ({ id, boards }: { id: string; boards: Artboard[] }) => {
        const backend = window.ponzuFake!.backend;
        const doc = backend.design(id).sequencer.doc;
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
      { id: designId, boards: [hero(0), plans(1440)] },
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

    if (SHOTS || FIXTURES) {
      for (const [index, comment] of (await kept()).entries()) {
        for (const theme of ["light", "dark"] as const) {
          const ref = comment.picture![theme];
          const bytes = await fake(
            ({ id, ref }: { id: string; ref: string }) => [
              ...[...window.ponzuFake!.backend.design(id).pictures.values()].find(
                (p) => p.ref === ref,
              )!.bytes,
            ],
            { id: designId, ref },
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

  test("a teammate's comes from the design's files; one with none says where it was", async () => {
    // Sam leaves one, and his app attaches a picture; and one from before there were pictures.
    await fake(async (id: string) => {
      const world = window.ponzuFake!;
      const sam = world.backend.connect(world.teammate).api;
      const doc = world.backend.design(id).sequencer.doc;
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
      await sam.designs.commit(id, [
        { id: "op_sam1", op: thread("th_sam1", heroBoard!.id, "m_sam1", "The photo should lead") },
        { id: "op_sam2", op: thread("th_sam2", plansBoard!.id, "m_sam2", "Make Grower stand out") },
      ]);
      // His picture is a copy of the first one drawn here: what matters is where it comes from.
      const [mine] = [...world.backend.design(id).pictures.values()];
      const uploads = await sam.designs.uploadCommentPicture(id, "m_sam1", {
        light: mine!.bytes,
        dark: mine!.bytes,
      });
      await sam.designs.attachCommentPicture(id, "m_sam1", uploads);
    }, designId);
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
      const threads = world.backend.design(id).sequencer.doc.threads;
      const [hero, open] = threads;
      await sam.designs.commit(id, [
        {
          id: "op_res",
          op: { op: "thread.update", id: hero!.id, status: "resolved", updatedAt: Date.now() },
        },
        { id: "op_del", op: { op: "thread.delete", id: open!.id } },
      ]);
    }, designId);
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
});
