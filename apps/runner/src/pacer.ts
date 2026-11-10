/** How long to wait after a failed send before the next: doubling from the first to the last. */
const BACKOFF_MS = { first: 1_000, last: 15_000 };

/**
 * Runs `send` for whatever has piled up since the last time: never two at once, and never
 * sooner than `gapMs` after the last one started, so a burst of changes is one request. A
 * failed send is tried again after a wait that grows. `send` takes what is pending itself and
 * puts back what it could not deliver.
 */
export class Pacer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private last = 0;
  private failures = 0;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly send: () => Promise<void>,
    private readonly gapMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Something is pending: send it once the gap allows. */
  kick(): void {
    this.dirty = true;
    this.schedule();
  }

  /** Send what is pending now, ignoring the gap, and resolve once that send is over. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.dirty) {
      this.clearTimer();
      await this.fire();
    }
  }

  /** Stop sending. What is pending stays where `send` keeps it. */
  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private schedule(): void {
    if (this.timer || this.inFlight || this.closed || !this.dirty) return;
    const gap = this.failures
      ? Math.min(BACKOFF_MS.first * 2 ** (this.failures - 1), BACKOFF_MS.last)
      : this.gapMs;
    const wait = Math.max(0, this.last + gap - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, wait);
    this.timer.unref?.();
  }

  private fire(): Promise<void> {
    this.dirty = false;
    this.last = Date.now();
    const sent = this.send().then(
      () => {
        this.failures = 0;
      },
      (err) => {
        this.failures++;
        this.dirty = true;
        this.onError(err);
      },
    );
    this.inFlight = sent.finally(() => {
      this.inFlight = null;
      this.schedule();
    });
    return this.inFlight;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
