/*
 * The Mac's notifications, in the studio as it ships, in a real Chromium, on Ponzu Cloud in
 * memory (fake-host.ts) with the shell's notifications played (`?mac=1`): this Mac registered,
 * a question on a canvas not on screen shown once, the dock's number, a click opening the
 * canvas's thread on the question and reading it, the banner taken away as the question closes,
 * a ping about the canvas in front of the person read rather than shown, a billing ping opening
 * Plan and usage, and Settings listing This Mac first. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(60_000);

/** With PONZU_SHOTS set to a folder, Settings › Notifications is pictured there. */
const SHOTS = process.env.PONZU_SHOTS;

describe.skipIf(!chromiumPath)("the Mac's notifications", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  /** The team's canvases: the one open, and one with a question. */
  let canvases: { open: string; other: string };

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${server.url}?as=returning&mac=1`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const mac = () =>
    page.evaluate(() => {
      const { shown, removed, badge } = window.ponzuFake!.mac!;
      return { shown: [...shown], removed: [...removed], badge };
    });
  const inbox = () =>
    page.evaluate(() => {
      const { backend, me } = window.ponzuFake!;
      return [...(backend.settings.inbox.get(me.id) ?? [])];
    });

  test("this Mac is registered as the person's, and the dock reads none", async () => {
    await page.locator("#sidebar").waitFor();
    await waitUntil(() =>
      page.evaluate(() => {
        const { backend, me } = window.ponzuFake!;
        return (backend.settings.devices.get(me.id) ?? []).some((d) => d.platform === "macos");
      }),
    );
    const devices = await page.evaluate(() => {
      const { backend, me } = window.ponzuFake!;
      return backend.settings.devices.get(me.id)!.map((d) => [d.platform, d.name, d.appVersion]);
    });
    expect(devices).toEqual([["macos", "Maya's MacBook Pro", "2.0.0"]]);
    await waitUntil(async () => (await mac()).badge === 0);
  });

  test("a question on a canvas not on screen shows once, and counts on the dock", async () => {
    canvases = await page.evaluate(async () => {
      const fake = window.ponzuFake!;
      const { backend } = fake;
      const onboarding = [...backend.canvases.values()].find(
        (d) => d.sequencer.doc.name === "Onboarding flow",
      )!;
      const other = await backend.connect(fake.me).api.canvases.create({
        workspaceId: fake.workspaceId,
        repoId: onboarding.repoId!,
        name: "Checkout",
      });
      return { open: onboarding.id, other: other.id };
    });
    // The window shows the onboarding canvas; the question is on Checkout.
    await page.evaluate(
      (id) => window.ponzuFake!.link({ kind: "canvas", canvasId: id }),
      canvases.open,
    );
    await page.locator('[data-board-name][title="Welcome"]').waitFor();
    await page.evaluate((canvasId) => {
      const { backend, me, workspaceId } = window.ponzuFake!;
      const questionId = backend.agent(canvasId).ask(
        {
          kind: "question",
          payload: {
            questions: [
              {
                header: "Layout",
                question: "One page or steps?",
                options: [
                  { label: "One page", description: "Everything at once." },
                  { label: "Steps", description: "A little at a time." },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        "Layout",
      );
      // As the API's pipeline does for the canvas's owner: Ponzu's words, never the question's.
      backend.notify(me.id, {
        kind: "needs_you",
        workspaceId,
        canvasId,
        title: "Checkout",
        body: "Ponzu has a question for you.",
        link: { open: "thread", questionId },
      });
    }, canvases.other);
    await waitUntil(async () => (await mac()).shown.length > 0);
    const { shown, badge } = await mac();
    const [row] = await inbox();
    expect(shown).toEqual([
      {
        id: row!.id,
        groupId: canvases.other,
        title: "Checkout",
        body: "Ponzu has a question for you.",
        link: {
          kind: "canvas",
          canvasId: canvases.other,
          open: "thread",
          questionId: row!.link.questionId!,
          notificationId: row!.id,
        },
      },
    ]);
    expect(badge).toBe(1);

    // The inbox changes again (a muted reply arrives): the banner isn't shown again, nor the reply.
    await page.evaluate(() =>
      window.ponzuFake!.backend.notify(window.ponzuFake!.me.id, {
        kind: "reply",
        title: "Onboarding flow",
        body: "Ponzu replied to your comment.",
        link: { open: "thread" },
        muted: true,
      }),
    );
    await waitUntil(async () => (await inbox()).length === 2);
    expect((await mac()).shown.length).toBe(1);
  });

  test("a click opens the canvas's thread on the question, and reads it", async () => {
    const [row] = await inbox();
    // The thread closed beforehand, so it is the click that opens it.
    const railOpen = page.locator("#thread:not([inert])");
    if (await railOpen.count()) {
      await page.getByRole("button", { name: /thread/i }).click();
      await waitUntil(async () => (await railOpen.count()) === 0);
    }
    await page.evaluate((id) => window.ponzuFake!.mac!.click(id), row!.id);
    const ask = page.getByRole("region", { name: "Ponzu needs you: Layout" });
    await ask.waitFor();
    await railOpen.waitFor();
    expect(await ask.getByRole("radio", { name: /One page/ }).count()).toBe(1);
    await waitUntil(async () => (await inbox()).find((r) => r.id === row!.id)!.readAt !== null);
    // Read, its banner goes; the question still waits, so the dock still counts it.
    await waitUntil(async () => (await mac()).removed.includes(row!.id));
    expect((await mac()).badge).toBe(1);

    // The question closes (the agent moved on): the dock reads none.
    await page.evaluate(
      ([canvasId, questionId]) => window.ponzuFake!.backend.agent(canvasId!).withdraw(questionId!),
      [canvases.other, row!.link.questionId!] as const,
    );
    await waitUntil(async () => (await mac()).badge === 0);
  });

  test("a ping about the canvas in front of the person is read, not shown", async () => {
    // The test's only page is in front, as a window the person is using is.
    expect(
      await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()),
    ).toBe(true);
    const before = (await mac()).shown.length;
    const id = await page.evaluate((canvasId) => {
      const { backend, me, workspaceId } = window.ponzuFake!;
      return backend.notify(me.id, {
        kind: "finished",
        workspaceId,
        canvasId,
        title: "Checkout",
        body: "Ponzu finished what you asked.",
        link: { open: "thread" },
      }).id;
    }, canvases.other);
    await waitUntil(async () => (await inbox()).find((r) => r.id === id)!.readAt !== null);
    expect((await mac()).shown.length).toBe(before);
  });

  test("a billing ping opens Plan and usage, and Settings lists This Mac first", async () => {
    const id = await page.evaluate(() => {
      const { backend, me, workspaceId } = window.ponzuFake!;
      return backend.notify(me.id, {
        kind: "billing_cap_warning",
        workspaceId,
        title: "Northbrook",
        body: "Northbrook has used $80 of its $100 cap this month.",
        link: { open: "usage" },
      }).id;
    });
    await waitUntil(async () => (await mac()).shown.some((n) => n.id === id));
    const notice = (await mac()).shown.find((n) => n.id === id)!;
    expect([notice.groupId, notice.link]).toEqual([
      await page.evaluate(() => window.ponzuFake!.workspaceId),
      { kind: "settings", section: "usage", notificationId: id },
    ]);
    await page.evaluate((n) => window.ponzuFake!.mac!.click(n), id);
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.getByRole("button", { name: "Plan and usage" }).waitFor();
    expect(
      await nav.getByRole("button", { name: "Plan and usage" }).getAttribute("aria-current"),
    ).toBe("page");
    await waitUntil(async () => (await inbox()).find((r) => r.id === id)!.readAt !== null);

    await nav.getByRole("button", { name: "Notifications" }).click();
    await page.getByText("This Mac").waitFor();
    expect(
      await nav.getByRole("button", { name: "Notifications" }).getAttribute("aria-current"),
    ).toBe("page");
    // No iPhone yet: the way to get one; and no email row, since this Ponzu can't send one.
    expect(await page.getByText("Get Ponzu on your iPhone").count()).toBeGreaterThan(0);
    expect(await page.getByText("a daily digest only").count()).toBe(0);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, "settings-notifications-this-mac.png") });
    }
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});
