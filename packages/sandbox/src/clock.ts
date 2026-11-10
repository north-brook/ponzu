import { SandboxError } from "./errors.ts";

/** Time, passed in so that waiting can be tested without waiting. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A warm start takes about 2 s and a cold one about 5 s, so look often for that long, then ease off. */
const EAGER_FOR_MS = 5_000;
const EAGER_EVERY_MS = 250;
const PATIENT_EVERY_MS = 1_000;

/**
 * Calls `check` until it returns something, sleeping between calls, and gives up with
 * `unavailable` once `timeoutMs` has passed. `waitingFor` finishes the sentence "gave up
 * waiting for …".
 */
export async function poll<T>(
  clock: Clock,
  timeoutMs: number,
  waitingFor: string,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const started = clock.now();
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    const waited = clock.now() - started;
    if (waited >= timeoutMs) {
      throw new SandboxError(
        "unavailable",
        `gave up waiting for ${waitingFor} after ${Math.round(waited / 1000)} s`,
      );
    }
    await clock.sleep(waited < EAGER_FOR_MS ? EAGER_EVERY_MS : PATIENT_EVERY_MS);
  }
}
