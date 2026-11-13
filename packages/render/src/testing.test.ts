import { describe, expect, test } from "bun:test";
import { findChromium } from "./chromium.ts";
import { launchChromium } from "./testing.ts";

const chromium = findChromium();

/** Whether a process (or, with a negative id, any process in a group) is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Until every process in the group is gone. Its helpers were killed with Chrome, but once their
 * parent is gone the system reaps them, and that can come a moment after close() resolves.
 */
async function groupGone(pid: number): Promise<void> {
  while (alive(-pid)) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe.skipIf(!chromium || process.platform === "win32")("the tests' Chromium", () => {
  test("its pages each have a context of their own", async () => {
    const browser = await launchChromium(chromium);
    try {
      const a = await browser.newPage();
      const b = await browser.newPage();
      expect(a.context()).not.toBe(b.context());
      await a.setContent("<p>a</p>");
      expect(await a.textContent("p")).toBe("a");
    } finally {
      await browser.close();
    }
  });

  test("closing takes Chrome and every process it started", async () => {
    const browser = await launchChromium(chromium);
    const pid = browser.pid;
    expect(pid).toBeGreaterThan(0);
    await (await browser.newPage()).setContent("<p>hi</p>");
    expect(alive(-pid!)).toBe(true);
    await browser.close();
    // Chrome itself is gone when close() resolves; what it started goes with it.
    expect(alive(pid!)).toBe(false);
    await groupGone(pid!);
    // A second close is the same close, and an afterAll may call it after a test did.
    await browser.close();
  });

  // Chrome stopped dead stands in for one whose teardown hangs, as it does on a busy Mac:
  // Playwright's own close would wait 30 s on it before killing it, past any test's timeout.
  test("a Chrome that won't answer still closes, without waiting on it", async () => {
    const browser = await launchChromium(chromium);
    const pid = browser.pid!;
    process.kill(pid, "SIGSTOP");
    await browser.close();
    expect(alive(pid)).toBe(false);
    await groupGone(pid);
  });
});
