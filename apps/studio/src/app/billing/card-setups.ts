import { type Api, ApiError } from "@ponzu/client";
import type { DeepLink } from "@ponzu/desktop/bridge";

/*
 * Adding a card (docs/cloud.md, "Billing", "Cards"). The app opens Stripe's Checkout page in the
 * browser, then asks the API how the setup stands every two seconds until it has an outcome
 * (`GET /v1/billing/card-setups/:id`), as installs.ts does for GitHub's install page. The return
 * page opens `ponzu://billing/card?setup=<id>&result=…`, which only means "ask now": the API's
 * answer is the outcome, never the link's word, so a link anyone could open settles nothing.
 * Either way the outcome is heard once.
 */

/** How often a setup waiting on Stripe is asked about. */
export const CARD_POLL_MS = 2_000;
/**
 * How long the app keeps asking: Checkout's page lives 31 minutes and the setup 35, so past
 * this the setup has expired whatever happens.
 */
export const CARD_SETUP_WATCH_MS = 32 * 60_000;

export type CardOutcome = "added" | "cancelled" | "expired" | "failed";

/** The clock and timers the watcher runs on: real ones, or a test's. */
export interface Scheduler {
  now(): number;
  /** Runs `run` after `ms`; returns what cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface CardSetupWatch {
  /** Stop asking; no outcome is heard after this. */
  stop(): void;
}

export function watchCardSetup(opts: {
  api: Pick<Api, "billing">;
  setupId: string;
  /** The app's links: this setup's `card_setup` link asks at once. */
  onLink: (listener: (link: DeepLink) => void) => () => void;
  /** Bring the app in front of the browser once the card is added or the page was left. */
  comeForward?: () => void;
  onOutcome: (outcome: CardOutcome) => void;
  scheduler?: Scheduler;
  pollMs?: number;
  watchMs?: number;
}): CardSetupWatch {
  const clock = opts.scheduler ?? realScheduler;
  const pollMs = opts.pollMs ?? CARD_POLL_MS;
  const until = clock.now() + (opts.watchMs ?? CARD_SETUP_WATCH_MS);
  let done = false;
  let asking = false;
  /** A link came while an answer was on its way: ask once more after it. */
  let again = false;
  let cancelNext: (() => void) | null = null;

  const finish = (outcome: CardOutcome) => {
    if (done) return;
    stop();
    if (outcome === "added" || outcome === "cancelled") opts.comeForward?.();
    opts.onOutcome(outcome);
  };

  const next = () => {
    if (done) return;
    if (clock.now() >= until) {
      finish("expired");
      return;
    }
    cancelNext = clock.after(pollMs, ask);
  };

  const ask = async () => {
    if (done) return;
    cancelNext?.();
    cancelNext = null;
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    let status: Awaited<ReturnType<Api["billing"]["cardSetup"]>>["status"] | null = null;
    try {
      status = (await opts.api.billing.cardSetup(opts.setupId)).status;
    } catch (error) {
      // Not theirs, or gone: it can't come to anything now. Billing turned off meanwhile (409
      // `billing_not_set_up`) or no longer allowed (403): it won't either, so stop asking rather
      // than ask every two seconds for half an hour. Anything else is asked again.
      if (error instanceof ApiError && error.status === 404) status = "expired";
      else if (error instanceof ApiError && (error.status === 403 || error.status === 409)) {
        status = "failed";
      }
    }
    asking = false;
    if (done) return;
    if (status !== null && status !== "waiting") {
      finish(status);
      return;
    }
    if (again) {
      again = false;
      void ask();
      return;
    }
    next();
  };

  const offLink = opts.onLink((link) => {
    if (link.kind === "card_setup" && link.setupId === opts.setupId) void ask();
  });

  function stop() {
    done = true;
    cancelNext?.();
    cancelNext = null;
    offLink();
  }

  next();
  return { stop };
}
