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

/**
 * A clock for tests. Sleeping moves it forward at once, so code that waits finishes immediately
 * and the test decides how long things took.
 */
export class FakeClock implements Clock {
  #ms: number;
  #timeouts: Array<{ at: number; controller: AbortController }> = [];

  constructor(startAt = Date.UTC(2026, 0, 1)) {
    this.#ms = startAt;
  }

  now(): number {
    return this.#ms;
  }

  /** Moves time forward, aborting every `timeout` signal that comes due. */
  advance(ms: number): void {
    this.#ms += ms;
    const due = this.#timeouts.filter((timeout) => timeout.at <= this.#ms);
    this.#timeouts = this.#timeouts.filter((timeout) => timeout.at > this.#ms);
    for (const { controller } of due) {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  timeout(ms: number): AbortSignal {
    const controller = new AbortController();
    this.#timeouts.push({ at: this.#ms + ms, controller });
    return controller.signal;
  }
}
