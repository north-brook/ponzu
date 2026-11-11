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

/**
 * Builds the app as the desktop package does, into a fresh directory. `e2e` keeps Ponzu Cloud in
 * memory in, which a production build leaves out.
 */
async function buildApp(mode: "e2e" | "production"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-studio-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--mode", mode, "--outDir", dir], {
    cwd: STUDIO,
    // bun test sets NODE_ENV=test, which a packaging build never has.
    env: { ...process.env, NODE_ENV: undefined },
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
    dir = await buildApp("e2e");
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
    // The comment and the reply reached the thread too, each with its board above it.
    const frames = rail().getByRole("button", { name: "Open the comment on Three plans" });
    await waitUntil(async () => (await frames.count()) === 2);
  });

  /** The thread rail. */
  const rail = () => page.locator("#thread");

  test("a message, a reply that streams while the agent draws, a question, and a merge", async () => {
    const { id } = await made();
    await page.keyboard.press("Escape");
    const field = rail().getByPlaceholder("Steer, or ask more");
    await field.fill("Add a yearly toggle");
    await field.press("Enter");
    // The bubble is there at once, and the message reached the design's feed.
    await rail().getByText("Add a yearly toggle").waitFor();
    await waitUntil(async () => (await made()).said.includes("Add a yearly toggle"));

    // The agent works: the working line, then its reply streaming in, and a board drawn.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.work([], "Drawing Yearly toggle");
      agent.tool("Drawing Yearly toggle", { id: "ti_work0000000001" });
    }, id);
    await rail().getByRole("status").getByText("Drawing Yearly toggle").waitFor();
    await rail().getByRole("button", { name: "Stop" }).waitFor();
    await page.evaluate((designId) => {
      const world = window.ponzuFake!;
      const agent = world.backend.agent(designId);
      agent.tool("Drew Yearly toggle", { id: "ti_work0000000001", streaming: false, steps: 3 });
      agent.say("Adding a toggle", { id: "ti_reply000000001", streaming: true });
      world.drawBoard(designId, "Yearly toggle", "#e8efe4");
    }, id);
    await rail().getByText("Adding a toggle").waitFor();
    await page.locator('[data-board-name][title="Yearly toggle"]').waitFor();
    await page.evaluate((designId) => {
      window
        .ponzuFake!.backend.agent(designId)
        .say("Adding a toggle above the plans. Yearly saves 20%.", {
          id: "ti_reply000000001",
          streaming: false,
        });
    }, id);
    await rail().getByText("Yearly saves 20%").waitFor();
    await rail().getByText("Drew Yearly toggle").waitFor();

    // It asks; the question takes the composer's place, and the answer goes to the API.
    const question = await page.evaluate(
      (designId) =>
        window.ponzuFake!.backend.agent(designId).ask(
          {
            kind: "question",
            payload: {
              questions: [
                {
                  header: "Default",
                  question: "Which should the toggle show first?",
                  options: [
                    { label: "Monthly", description: "As the page does today." },
                    { label: "Yearly", description: "Leads with the saving." },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          "Default",
        ),
      id,
    );
    const asked = page.getByRole("region", { name: "Ponzu needs you: Default" });
    await asked.getByText("Which should the toggle show first?").waitFor();
    expect(await rail().getByPlaceholder("Steer, or ask more").count()).toBe(0);
    // Waiting in the composer's place, it isn't also a line in the thread.
    expect(await rail().getByText("Asked:").count()).toBe(0);
    await asked.getByRole("radio", { name: /Yearly/ }).click();
    await asked.getByRole("button", { name: "Send" }).click();
    await waitUntil(() =>
      page.evaluate(
        ([designId, q]) =>
          window.ponzuFake!.backend.design(designId!).questions.find((x) => x.id === q)?.status ===
          "answered",
        [id, question],
      ),
    );
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    // Answered, it is part of what happened.
    await rail().getByText("Asked:").waitFor();

    // It pushes and its turn ends: Create PR, then Ready, then Merge.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.push([{ path: "src/pricing.tsx", additions: 42, deletions: 3 }]);
      agent.idle();
    }, id);
    const action = (name: string) => page.locator("header").getByRole("button", { name });
    await action("Create PR").click();
    await action("Ready").click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+opened as a draft/)
      .waitFor();

    // The pull request tab takes the canvas's pane, with the file's diff on demand.
    await page.locator("header").getByRole("button", { name: /#\d+/ }).click();
    await page.getByRole("heading", { name: PROMPT }).waitFor();
    expect(await page.locator("#thread").count()).toBe(0);
    await page.getByRole("button", { name: /src\/pricing\.tsx/ }).click();
    await page.getByText("src/pricing.tsx", { exact: false }).first().waitFor();
    // The agent pushes again while the file is open: the diff shown is the new head's.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.push([
        { path: "src/pricing.tsx", patch: "@@ -1 +1,2 @@\n context\n+const yearly = true;" },
      ]);
      agent.tool("Pushed the toggle", { streaming: false });
    }, id);
    await page.getByText("const yearly = true;").waitFor();

    await action("Merge").click();
    await page
      .getByText(/Merged/)
      .first()
      .waitFor();
    await waitUntil(() =>
      page.evaluate(
        (designId) => window.ponzuFake!.backend.design(designId).settledAt !== null,
        id,
      ),
    );
    // Merged: no button, and the design settled on its own.
    expect(await action("Merge").count()).toBe(0);
    await page.getByRole("tab", { name: "Page 1" }).click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+merged/)
      .waitFor();
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

describe.skipIf(!chromiumPath)("the studio as it ships, without the desktop's bridge", () => {
  test("carries no in-memory Ponzu Cloud, and says it couldn't start", async () => {
    const dir = await buildApp("production");
    const server = serve(dir);
    const browser = await launch();
    try {
      const shipped = await Array.fromAsync(new Bun.Glob("**/*.js").scan(dir));
      for (const file of shipped) {
        expect(await Bun.file(join(dir, file)).text()).not.toContain("ponzuFake");
      }
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.waitForSelector('[data-screen="cant-start"]');
      expect(await page.textContent("h1")).toBe("Ponzu couldn't start");
      expect(await page.locator('[data-screen="sign-in"]').count()).toBe(0);
    } finally {
      await browser.close();
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitUntil(done: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Gave up waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
