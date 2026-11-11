/*
 * The studio as it ships, built and in a real Chromium, on Ponzu Cloud in memory
 * (fake-host.ts): the sign-in gate, the sidebar on live data, making a design, the canvas
 * drawing what its agent commits, and a comment there and back. Skips where there is no Chrome
 * or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page, STUDIO } from "../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

/** Builds the app as the desktop package does, into a fresh directory. */
async function buildApp(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-studio-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--outDir", dir], {
    cwd: STUDIO,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`The studio didn't build:\n${await new Response(build.stderr).text()}`);
  }
  return dir;
}

/** Serves the built app with its routes falling back to index.html, as the desktop's scheme does. */
function serve(dir: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = Bun.file(join(dir, path));
      return path !== "/" && (await file.exists())
        ? new Response(file)
        : new Response(Bun.file(join(dir, "index.html")));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

const PROMPT = "A pricing page with three plans";

describe.skipIf(!chromiumPath)("the studio, built, on Ponzu Cloud in memory", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await buildApp();
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(server.url);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The design the test made, as the in-memory API holds it. */
  const made = () =>
    page.evaluate((prompt) => {
      const designs = [...window.ponzuFake!.backend.designs.values()];
      const design = designs.find((d) => d.sequencer.doc.name === prompt)!;
      return {
        id: design.id,
        said: design.thread.map(({ item }) => (item.kind === "message" ? item.payload.text : "")),
        threads: design.sequencer.doc.threads.map((t) => ({
          id: t.id,
          texts: t.messages.map((m) => m.text),
        })),
      };
    }, PROMPT);

  test("signed out, it asks to sign in, and shows nothing else", async () => {
    await page.waitForSelector('[data-screen="sign-in"]');
    expect(await page.textContent("h1")).toBe("Sign in to Ponzu");
    expect(await page.locator("#sidebar").count()).toBe(0);
  });

  test("signed in, the sidebar lists the workspace's designs", async () => {
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("button", { name: /Onboarding flow/ }).waitFor();
    expect(await page.locator("#sidebar").textContent()).toContain("Northbrook");
    // The create page fills the canvas pane until a design is opened.
    await page.getByText("What do you want to design?").waitFor();
  });

  test("a design made on the create page opens, and the canvas draws what its agent commits", async () => {
    await page.getByPlaceholder(/Describe a screen/).fill(PROMPT);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: new RegExp(PROMPT) }).waitFor();
    const design = await made();
    // The first message went to the agent.
    expect(design.said).toEqual([PROMPT]);

    await page.evaluate((id) => window.ponzuFake!.drawBoard(id, "Three plans"), design.id);
    await page.locator('[data-board-name][title="Three plans"]').waitFor();
    expect(await page.locator("[data-artboard-host]").count()).toBe(1);
  });

  test("a comment left on the canvas reaches the design, and a teammate's reply comes back", async () => {
    await page.keyboard.press("c");
    // Into the board, below its title.
    const title = (await page.locator('[data-board-name][title="Three plans"]').boundingBox())!;
    await page.mouse.click(title.x + 120, title.y + 120);
    await page.getByPlaceholder("Leave a comment…").fill("Make the middle plan stand out");
    await page.keyboard.press("Enter");

    await waitUntil(async () => (await made()).threads.length === 1);
    const [thread] = (await made()).threads;
    expect(thread!.texts).toEqual(["Make the middle plan stand out"]);

    const { id } = await made();
    await page.evaluate(
      ([designId, threadId]) => window.ponzuFake!.reply(designId!, threadId!, "On it"),
      [id, thread!.id],
    );
    await page.locator('button[title="Drag to move"]', { hasText: "2" }).waitFor();
  });

  test("a design deleted while it's open says so calmly, and leads back", async () => {
    const { id } = await made();
    await page.evaluate(async (designId) => {
      const world = window.ponzuFake!;
      await world.backend.connect(world.me).api.designs.delete(designId);
    }, id);
    await page.getByText("This design isn't here any more").waitFor();
    await page.getByRole("button", { name: "Back to designs" }).click();
    await page.getByText("What do you want to design?").waitFor();
    expect(await page.getByRole("button", { name: new RegExp(PROMPT) }).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

async function waitUntil(done: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Gave up waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
