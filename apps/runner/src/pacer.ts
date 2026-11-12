/**
 * The wait before try `n + 1` of a call that failed `n` times in a row: from half a second,
 * doubling, to half a minute (docs/cloud.md, "Rules for every call").
 */
export function backoff(failures: number): number {
  return Math.min(500 * 2 ** (failures - 1), 30_000);
}

/**
 * Runs `send` for whatever has piled up since the last time: never two at once, and never
 * sooner than `gapMs` after the last one started, so a burst of changes is one request. A
 * failed send is tried again after `backoff`, for as long as the pacer is open. `send` takes
 * what is pending itself and puts back what it could not deliver.
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
    private readonly retryIn: (failures: number) => number = backoff,
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
    const gap = this.failures ? this.retryIn(this.failures) : this.gapMs;
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

/**
 * Things to send, by key, through a `Pacer`: putting a key again replaces what was pending for
 * it, and a batch that fails goes back in front of anything put meanwhile, unless a newer
 * value for the same key came in. `send` delivers a batch or throws to have it tried again; it
 * handles a refusal itself.
 */
export class Outbox<T> {
  private pending = new Map<string, T>();
  private readonly pacer: Pacer;

  constructor(
    send: (items: T[]) => Promise<void>,
    opts: {
      gapMs: number;
      /** The most one batch carries. */
      max?: number;
      /** What may go now; the rest waits for the next `kick`. */
      ready?: (item: T) => boolean;
      onError?: (err: unknown) => void;
      backoff?: (failures: number) => number;
    },
  ) {
    this.pacer = new Pacer(
      async () => {
        const ready = [...this.pending].filter(([, item]) => opts.ready?.(item) ?? true);
        const batch = ready.slice(0, opts.max ?? Number.POSITIVE_INFINITY);
        for (const [key] of batch) this.pending.delete(key);
        if (!batch.length) return;
        try {
          await send(batch.map(([, item]) => item));
        } catch (err) {
          const newer = this.pending;
          this.pending = new Map(batch.filter(([key]) => !newer.has(key)));
          for (const [key, item] of newer) this.pending.set(key, item);
          throw err;
        }
        if (batch.length < ready.length) this.pacer.kick();
      },
      opts.gapMs,
      opts.onError,
      opts.backoff,
    );
  }

  put(key: string, item: T): void {
    this.pending.set(key, item);
    this.pacer.kick();
  }

  /** Take back what has not been sent yet. False when there was nothing pending for `key`. */
  take(key: string): boolean {
    return this.pending.delete(key);
  }

  /** Something `ready` refused before may go now. */
  kick(): void {
    if (this.pending.size) this.pacer.kick();
  }

  flush(): Promise<void> {
    return this.pacer.flush();
  }

  close(): void {
    this.pacer.close();
  }
}
