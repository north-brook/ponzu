import type { Browser, BrowserContext, Page } from "playwright-core";
import { RenderError, STAGE_BUDGET_MS, stalled, within } from "./stages.ts";

/** How long a page or a browser gets to close before it is given up on. */
const CLOSE_MS = 5_000;

/** A page opened for one job. */
export interface Lease {
  page: Page;
  /** `err`, or what really happened when the job failed because its page or browser died under it. */
  explain(err: unknown): unknown;
  /** Closes the page, and its context when it has one of its own. */
  close(): Promise<void>;
}

/** A launched browser, and a promise that settles when it is gone, however it goes. */
interface Running {
  browser: Browser;
  gone: Promise<void>;
}

/**
 * One Chrome process and the pages jobs open in it. It starts when a page is
 * first asked for, is replaced once it dies (a crash, the kernel's
 * out-of-memory killer) and closes after sitting unused, so a machine with
 * nothing to draw isn't holding a browser's memory.
 */
export class BrowserProcess {
  private running: Promise<Running> | null = null;
  private shared: { browser: Browser; context: Promise<BrowserContext> } | null = null;
  private leases = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  /**
   * `launch` starts a browser. One that fails to start is tried once more,
   * unless it fails with a RenderError: that is `launch` saying why it never
   * will.
   */
  constructor(
    private launch: () => Promise<Browser>,
    private idleMs: number,
  ) {}

  /**
   * A page for one job: in the shared context, or at another device scale in
   * a context of its own (deviceScaleFactor is per-context, and
   * devicePixelRatio reports it, so srcset and image-set() pick to suit).
   */
  async open(scale: number): Promise<Lease> {
    this.leases++;
    clearTimeout(this.idle);
    try {
      return await this.lease(scale, true);
    } catch (err) {
      this.rest();
      throw err;
    }
  }

  private async lease(scale: number, again: boolean): Promise<Lease> {
    const starting = this.start();
    const running = await starting.catch((err) => {
      if (err instanceof RenderError || !again) throw err;
      return null;
    });
    // It died as it started, or between jobs with nothing to notice: once more, in a new one.
    const retry = () => {
      this.forget(starting);
      if (!again) throw died();
      return this.lease(scale, false);
    };
    if (!running) return retry();
    const { browser, gone } = running;
    const opened = this.page(browser, scale);
    // Playwright never settles a page that was opening when Chrome died, so
    // the browser going is watched for beside it.
    if (!(await within(Promise.race([opened, gone]), STAGE_BUDGET_MS.load))) {
      // A browser that can't open a page is no use to the next job either.
      await this.stop(starting);
      throw new RenderError(stalled("load"), "timeout", "load");
    }
    if (!browser.isConnected()) {
      opened.catch(() => {});
      return retry();
    }
    const { page, own } = await opened;
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });
    return {
      page,
      explain: (err) => (crashed || !browser.isConnected() ? died() : err),
      close: async () => {
        // A page that won't close (its renderer stuck in a layout) goes
        // down with its browser: nothing a job opened outlives the job.
        if (!(await within((own ?? page).close(), CLOSE_MS))) await this.stop(starting);
        this.rest();
      },
    };
  }

  /** Closes the browser, if one is running. The next page asked for starts another. */
  async close(): Promise<void> {
    clearTimeout(this.idle);
    if (this.running) await this.stop(this.running);
  }

  private start(): Promise<Running> {
    if (this.running) return this.running;
    const starting = this.launch().then((browser) => ({
      browser,
      gone: new Promise<void>((resolve) => {
        browser.on("disconnected", () => resolve());
        if (!browser.isConnected()) resolve();
      }),
    }));
    this.running = starting;
    // It failed to launch, or died later: the next job starts another.
    const forget = () => this.forget(starting);
    starting.then(({ gone }) => gone.then(forget), forget);
    return starting;
  }

  private forget(starting: Promise<Running>): void {
    if (this.running !== starting) return;
    this.running = null;
    this.shared = null;
  }

  private async page(
    browser: Browser,
    scale: number,
  ): Promise<{ page: Page; own: BrowserContext | null }> {
    const own = scale === 1 ? null : await browser.newContext({ deviceScaleFactor: scale });
    try {
      return { page: await (own ?? (await this.context(browser))).newPage(), own };
    } catch (err) {
      await own?.close().catch(() => {});
      throw err;
    }
  }

  private context(browser: Browser): Promise<BrowserContext> {
    if (this.shared?.browser !== browser) {
      const context = browser.newContext({ deviceScaleFactor: 1 });
      const shared = { browser, context };
      this.shared = shared;
      context.catch(() => {
        if (this.shared === shared) this.shared = null;
      });
    }
    return this.shared.context;
  }

  private async stop(starting: Promise<Running>): Promise<void> {
    this.forget(starting);
    const running = await starting.catch(() => null);
    // Playwright kills the process tree itself when Chrome doesn't answer.
    if (running) await within(running.browser.close(), 2 * CLOSE_MS);
  }

  /** One job fewer. With none left, the browser closes after `idleMs` unless another comes. */
  private rest(): void {
    this.leases--;
    if (this.leases > 0 || !this.running || !Number.isFinite(this.idleMs)) return;
    this.idle = setTimeout(() => void this.close(), this.idleMs);
    // Waiting to close an idle browser is no reason to keep the process alive.
    this.idle.unref?.();
  }
}

function died(): RenderError {
  return new RenderError(
    "The browser drawing this stopped partway: it crashed, or the machine ran out of memory. The next render starts a new one.",
    "render_error",
  );
}
