/*
 * What the window shows between the guided steps, frame by frame, with every answer from Ponzu
 * Cloud slowed as a real network is: the studio built as it ships, in a real Chromium, on the
 * API in memory (fake-host.ts). Between two steps the person sees the step they were on (its
 * action pending, perhaps) and then the next one: never an earlier step, the sign-in screen, an
 * empty window or a wait; the title and the line under it never move, nor does a step's action
 * while it waits; and Fresh start's composer stands still while the repo's ideas come in under
 * it. The walk runs with every answer equally slow, with each answer its own delay, and with
 * `me` far behind the rest. A relaunch at any stage goes straight to where the person belongs,
 * holding a quiet empty window until it knows. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "../e2e-lib.ts";

setDefaultTimeout(180_000);

/** Every answer takes this long: slow enough that any wait in between would be drawn. */
const LATENCY = 400;

type Screen = "blank" | "sign-in" | "where" | "claude" | "iphone" | "create" | string;

interface Frame {
  screen: string;
  /** Where the step's last visible button is, as "left/top". */
  action: string;
}

/**
 * Records, from the page's first frame, which screen every animation frame shows, keeping each
 * change once; where a step's title and body sit; and where its last button is.
 */
function record() {
  const w = window as unknown as {
    screens: string[];
    places: Set<string>;
    frames: { screen: string; action: string }[];
  };
  w.screens = [];
  w.places = new Set();
  w.frames = [];
  const STEPS: Record<string, string> = {
    "Where do you design?": "where",
    "Connect Claude": "claude",
    "Get Ponzu on your iPhone": "iphone",
  };
  const look = () => {
    let screen = "blank";
    const h1 = document.querySelector("h1");
    const title = h1?.textContent?.trim() ?? "";
    if (document.querySelector('[data-screen="sign-in"]')) screen = "sign-in";
    else if (STEPS[title]) screen = STEPS[title]!;
    else if (document.body?.textContent?.includes("What do you want to design?")) screen = "create";
    else if (document.querySelector("#sidebar")) screen = "app";
    else if (title) screen = `other: ${title}`;
    if (w.screens.at(-1) !== screen) w.screens.push(screen);
    if (h1 && STEPS[title]) {
      const body = h1.nextElementSibling;
      w.places.add(
        `${h1.getBoundingClientRect().top}/${body ? body.getBoundingClientRect().top : -1}`,
      );
      const buttons = [...(h1.parentElement?.querySelectorAll("button") ?? [])]
        .map((button) => button.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0);
      const last = buttons.at(-1);
      w.frames.push({ screen, action: last ? `${last.left}/${last.top}` : "none" });
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

const screens = (page: Page) =>
  page.evaluate(() => (window as unknown as { screens: Screen[] }).screens.slice());

/** Clears what was seen so far, keeping the screen on now as the first. */
const mark = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { screens: string[]; frames: unknown[] };
    w.screens = w.screens.slice(-1);
    w.frames = [];
  });

/** The title's and body's places on every step frame seen, once each. */
const places = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { places: Set<string> }).places]);

/** Where each step's last button stood on the frames since `mark`, once each, by step. */
const actions = (page: Page) =>
  page.evaluate(() => {
    const frames = (window as unknown as { frames: Frame[] }).frames;
    const by: Record<string, string[]> = {};
    for (const { screen, action } of frames) {
      by[screen] ??= [];
      if (!by[screen].includes(action)) by[screen].push(action);
    }
    return by;
  });

/**
 * Waits, frame by frame, until the app has had no answer outstanding and asked nothing new for
 * LATENCY: every answer of the moment in, and drawn (fake-host.ts counts them).
 */
const quiet = (page: Page) =>
  page.evaluate(async (latency) => {
    const answers = window.ponzuFake!.answers;
    const started = performance.now();
    let asked = answers.asked;
    let since = performance.now();
    for (;;) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      if (answers.waiting > 0 || answers.asked !== asked) {
        asked = answers.asked;
        since = now;
      } else if (now - since >= latency) {
        return;
      }
      if (now - started > 30_000) throw new Error("The window never stopped asking.");
    }
  }, LATENCY);

/** Each step's action stayed in one place across the transition just recorded. */
async function actionsHeld(page: Page) {
  for (const [screen, seen] of Object.entries(await actions(page))) {
    expect({ screen, seen: seen.length }).toEqual({ screen, seen: 1 });
  }
}

describe.skipIf(!chromiumPath)("between the guided steps, with slow answers", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const open = async (query: string) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.addInitScript(record);
    await page.goto(`${server.url}?latency=${LATENCY}${query}`);
    return { page, errors };
  };

  /** Sign in and go through every step to Fresh start, checking each transition. */
  const walk = async (query: string) => {
    const { page, errors } = await open(query);
    // Until the slowest answer asked for has come in, and what it set off has asked and been
    // answered too: nothing outstanding, and nothing new asked, for an answer's time.
    const settle = () => quiet(page);
    await page.waitForSelector('[data-screen="sign-in"]');
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    // Signing in: the sign-in screen waits on until the first step can show.
    await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
    expect(await screens(page)).toEqual(["blank", "sign-in", "where"]);

    // Where → Connect Claude.
    await page.getByRole("button", { name: "Set up" }).click();
    await waitUntil(() =>
      page.evaluate(() =>
        window.ponzuFake!.opened.some((url) => url.includes("installations/new")),
      ),
    );
    await page.evaluate(() =>
      window.ponzuFake!.link({
        kind: "github_setup",
        result: "installed",
        workspaceId: window.ponzuFake!.personalId,
      }),
    );
    await waitUntil(async () => (await page.getByText("Ready").count()) === 2);
    await settle();
    await mark(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
    await settle();
    expect(await screens(page)).toEqual(["where", "claude"]);
    await actionsHeld(page);

    // A code claude.ai turns down keeps the step, and a new sign-in takes the right one.
    await page.getByRole("button", { name: "Sign in" }).click();
    const code = page.getByLabel("Paste the code from claude.ai");
    await code.fill("wrong-Hq2-Rw9xT#state");
    await settle();
    await mark(page);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("That code didn't work.").waitFor();
    await settle();
    expect(await screens(page)).toEqual(["claude"]);
    await actionsHeld(page);
    await page.getByRole("button", { name: "Open sign-in again" }).click();
    await waitUntil(async () => (await code.inputValue()) === "");

    // Connect Claude → the iPhone: the founder's flash.
    await code.fill("k7Hq2-Rw9xT-pL4mZ#state");
    await settle();
    await mark(page);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("heading", { name: "Get Ponzu on your iPhone" }).waitFor();
    await settle();
    expect(await screens(page)).toEqual(["claude", "iphone"]);
    await actionsHeld(page);

    // The iPhone → Fresh start: the composer stands where it first appears while the repo's
    // ideas are made and rise in below it.
    await mark(page);
    await page.evaluate(() => {
      const w = window as unknown as { composer: number[] };
      w.composer = [];
      const look = () => {
        const box = document.querySelector("textarea")?.getBoundingClientRect();
        if (box) w.composer.push(box.top);
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await page.getByRole("button", { name: "Start designing" }).click();
    await page.getByText("What do you want to design?").waitFor();
    const idea = page.getByRole("list", { name: "Ideas" }).getByRole("button").first();
    await idea.waitFor();
    await settle();
    expect(await screens(page)).toEqual(["iphone", "create"]);
    await actionsHeld(page);
    const tops = await page.evaluate(() => [
      ...new Set((window as unknown as { composer: number[] }).composer),
    ]);
    expect(tops).toHaveLength(1);
    const picked = await idea.textContent();
    await idea.click();
    expect(await page.getByPlaceholder(/Describe a screen/).inputValue()).toBe(picked!);

    // The title and the line under it stood still on every step.
    expect(await places(page)).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
  };

  test("a new person sees each step, then the next, and nothing in between", () => walk(""));

  test("so they do when every answer takes its own time", () => walk("&jitter=7"));

  test("so they do when who they are is the slowest answer", () => walk("&meLatency=1500"));

  const relaunch = (as: string, heading: string, screen: Screen) =>
    test(`a relaunch at ${as} opens on its screen, with a quiet window until then`, async () => {
      const { page, errors } = await open(`&as=${as}`);
      if (screen === "create") await page.getByText(heading).waitFor();
      else await page.getByRole("heading", { name: heading }).waitFor();
      await page.waitForTimeout(LATENCY * 4);
      expect(await screens(page)).toEqual(["blank", screen]);
      expect(errors).toEqual([]);
      await page.close();
    });
  relaunch("where", "Where do you design?", "where");
  relaunch("claude", "Connect Claude", "claude");
  relaunch("iphone", "Get Ponzu on your iPhone", "iphone");
  relaunch("returning", "What do you want to design?", "create");
});
