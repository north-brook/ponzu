/*
 * Headless Chromium for tests and scripts: launched as Playwright launches it, and closed without
 * waiting on Chrome to quit.
 *
 * Playwright's browser.close() asks Chrome to quit and then waits up to 30 s for it before it
 * kills it. Chrome's own teardown can hang: on a Mac it often does (its teardown watchdog fires at
 * 10 s and writes a crash dump, and the process is still there at 30 s). Thirty seconds is also
 * what the browser tests give a hook, so a hung quit failed the file's afterAll however its tests
 * went. Nothing in a test's browser needs a graceful quit: its pages are done with, and its
 * profile is a temporary folder Playwright removes once the process is gone. So close() kills the
 * browser's process group and waits only for Playwright to see the process go.
 *
 * Every page still comes in a context of its own, as Playwright's Browser.newPage makes it.
 */
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

export type { Browser, Page };

export interface TestChromium {
  /** The browser process's id, which leads its process group; null when Chrome didn't say. */
  readonly pid: number | null;
  /** A page in a fresh context of its own: no cookies, storage or permissions from another. */
  newPage(options?: BrowserContextOptions): Promise<Page>;
  /** Kills the browser and resolves once its process is gone (reaped). Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Headless Chromium at `executablePath`, or the one findChromium finds, started with `args` as
 * well as Playwright's own. Throws when there is none.
 */
export async function launchChromium(
  executablePath = findChromium(),
  args: string[] = [],
): Promise<TestChromium> {
  if (!executablePath) throw new Error("No Chrome or Chromium found (set PONZU_CHROMIUM).");
  const browser = await chromium.launch({ executablePath, headless: true, args });
  const pid = await browserPid(browser).catch(async (err) => {
    await browser.close();
    throw err;
  });
  let closing: Promise<void> | undefined;
  return {
    pid,
    newPage: (options) => browser.newPage(options),
    close: () => {
      closing ??= end(browser, pid);
      return closing;
    },
  };
}

/**
 * A Chromium that is already running with a debugging port open (the desktop app's test or
 * checkout build), attached over CDP at `endpoint`. Its close() only lets go of it: the browser,
 * and every page in it, stay as they were.
 */
export function attachChromium(endpoint: string): Promise<Browser> {
  return chromium.connectOverCDP(endpoint);
}

/** The browser process's id, as Chrome tells it over CDP (Playwright doesn't say). */
async function browserPid(browser: Browser): Promise<number | null> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((info) => info.type === "browser")?.id;
    if (pid) return pid;
    console.warn("Chrome named no browser process; it will be closed the slow way.");
    return null;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Ends the browser at once. Playwright starts Chrome as the leader of a process group of its own
 * (detached), so one signal to the group takes Chrome and every helper it started. Playwright
 * notices the process exit, disconnects, and removes the profile; the close() after that only
 * waits for that cleanup to finish. Without a pid, or on Windows, where there are no process
 * groups, it is Playwright's own close.
 */
async function end(browser: Browser, pid: number | null): Promise<void> {
  if (pid !== null && process.platform !== "win32" && browser.isConnected()) {
    const gone = new Promise<void>((resolve) => {
      browser.once("disconnected", () => resolve());
      if (!browser.isConnected()) resolve();
    });
    let killed = true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      killed = false;
      // ESRCH: it went by itself, and Playwright sees that as it would the kill.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.warn(
          `Couldn't kill Chrome's process group ${pid}, so it closes the slow way: ${err}`,
        );
      }
    }
    if (killed) {
      await gone;
      await browser.close();
      await reaped(pid);
      return;
    }
  }
  await browser.close();
}

/**
 * Until the killed Chrome has been reaped. Playwright disconnects when Chrome's pipe closes,
 * which the kernel does the moment the process dies, but the process stays a zombie (and still
 * answers `kill(pid, 0)`) until the runtime's child handler collects its exit status, a moment
 * later and later still on a busy machine. close() promises Chrome is gone, so it waits for that.
 * The bound only keeps a runtime that never reaps from hanging the caller; it is not expected.
 */
async function reaped(pid: number, within = 10_000): Promise<void> {
  const until = Date.now() + within;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    if (Date.now() >= until) {
      console.warn(`Chrome ${pid} was killed but not reaped within ${within} ms.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
