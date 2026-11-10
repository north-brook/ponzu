import { withBudget } from "./stages.ts";

/**
 * A few jobs at a time, the rest in line in the order they came. Every job is
 * a page in Chrome, so this is what keeps a burst of screenshots from each
 * taking their own slice of memory at once. A job that waits past `waitMs`
 * for its turn fails as busy instead of queuing behind a backlog for ever.
 */
export class JobQueue {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private limit: number,
    private waitMs: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++;
    else await this.turn();
    try {
      return await work();
    } finally {
      this.next();
    }
  }

  private async turn(): Promise<void> {
    let ready!: () => void;
    const mine = new Promise<void>((resolve) => {
      ready = resolve;
    });
    this.waiting.push(ready);
    try {
      await withBudget("queue", mine, this.waitMs);
    } catch (err) {
      // Gave up waiting: step out of line. If the turn came just as time ran
      // out, the slot is already ours, so pass it on.
      const i = this.waiting.indexOf(ready);
      if (i >= 0) this.waiting.splice(i, 1);
      else this.next();
      throw err;
    }
  }

  /** Hands a finished job's slot to the next in line. */
  private next(): void {
    const go = this.waiting.shift();
    if (go) go();
    else this.running--;
  }
}
