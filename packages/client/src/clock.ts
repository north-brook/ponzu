/**
 * The package's only view of time: what it is now, and a way to run something later. Tests
 * pass a fake one (`@ponzu/client/testing`) and move it by hand.
 */
export interface Clock {
  /** Milliseconds since 1970. */
  now(): number;
  /** Run `run` once, `ms` from now. Returns a way to call it off. Core's `Scheduler`. */
  schedule(run: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** A promise that resolves after `ms` on `clock`. */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.schedule(resolve, ms));
}
