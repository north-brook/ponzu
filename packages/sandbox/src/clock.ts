import { SandboxError } from "./errors.ts";

/** Time, passed in so that waiting can be tested without waiting. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A signal that aborts once `ms` have passed: what cuts off a request nobody answers. */
  timeout(ms: number): AbortSignal;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeout: (ms) => AbortSignal.timeout(ms),
};

/** A warm start takes about 2 s and a cold one about 5 s, so look often for that long, then ease off. */
const EAGER_FOR_MS = 5_000;
const EAGER_EVERY_MS = 250;
const PATIENT_EVERY_MS = 1_000;

/**
 * Calls `check` until it returns something, sleeping between calls, and gives up with
 * `unavailable` when `timeoutMs` has passed. `waitingFor` finishes the sentence "gave up
 * waiting for …".
 *
 * The time is a deadline, not a number of tries: `check` is told how long is left and must not
 * take longer, and a `check` that fails as `unavailable` once the time is up counts as giving up.
 */
export async function poll<T>(
  clock: Clock,
  timeoutMs: number,
  waitingFor: string,
  check: (leftMs: () => number) => Promise<T | undefined>,
): Promise<T> {
  const started = clock.now();
  const left = () => started + timeoutMs - clock.now();
  const gaveUp = (cause?: unknown) =>
    new SandboxError(
      "unavailable",
      `gave up waiting for ${waitingFor} after ${Math.round((clock.now() - started) / 1000)} s`,
      { cause },
    );
  while (left() > 0) {
    let found: T | undefined;
    try {
      found = await check(left);
    } catch (error) {
      if (left() <= 0 && error instanceof SandboxError && error.code === "unavailable") {
        throw gaveUp(error);
      }
      throw error;
    }
    if (found !== undefined) return found;
    const every = clock.now() - started < EAGER_FOR_MS ? EAGER_EVERY_MS : PATIENT_EVERY_MS;
    await clock.sleep(Math.max(0, Math.min(every, left())));
  }
  throw gaveUp();
}
