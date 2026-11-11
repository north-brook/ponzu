import type { Clock } from "../clock.ts";

/** A clock that moves only when told, for tests. Timers run in order as it passes them. */
export class FakeClock implements Clock {
  private time: number;
  private timers: { at: number; order: number; run: () => void }[] = [];
  private order = 0;

  constructor(start = Date.UTC(2026, 10, 10, 12)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  schedule(run: () => void, ms: number): () => void {
    const timer = { at: this.time + Math.max(0, ms), order: this.order++, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Move on by `ms`, running each timer that comes due, and letting promises settle between. */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      await settle();
      const next = this.timers
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.time = next.at;
      next.run();
    }
    this.time = until;
    await settle();
  }

  /** Timers waiting to run. */
  get pending(): number {
    return this.timers.length;
  }
}

/** Let every promise that can settle now do so: a few turns of the microtask queue and one macrotask. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
