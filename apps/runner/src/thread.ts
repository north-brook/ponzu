import { type RunnerApi, retryable } from "./api/api.ts";
import { MAX_TEXT, MAX_THREAD_WRITE, type ThreadWrite } from "./api/protocol.ts";
import { Pacer } from "./pacer.ts";

/**
 * Writes the thread for the API, coalesced. Each item is written by id and only its latest
 * payload is sent, so text streaming at fifty tokens a second is a few writes a second, all
 * the items that changed together in one request, and nothing at all while nothing changes.
 */
export class ThreadWriter {
  /** The latest of each item not yet sent, in the order the items first appeared. */
  private pending = new Map<string, ThreadWrite>();
  /** Items the API has as finished: nothing more is sent for them. */
  private finished = new Set<string>();
  private readonly pacer: Pacer;

  constructor(
    private readonly api: RunnerApi,
    private readonly opts: { gapMs: number; onError?: (err: unknown) => void },
  ) {
    this.pacer = new Pacer(() => this.send(), opts.gapMs, opts.onError);
  }

  write(item: ThreadWrite): void {
    if (this.finished.has(item.id)) return;
    this.pending.set(item.id, item.kind === "assistant" ? clipped(item) : item);
    this.pacer.kick();
  }

  /** Send everything written so far. */
  flush(): Promise<void> {
    return this.pacer.flush();
  }

  close(): void {
    this.pacer.close();
  }

  private async send(): Promise<void> {
    const batch = [...this.pending.values()].slice(0, MAX_THREAD_WRITE);
    for (const item of batch) this.pending.delete(item.id);
    if (!batch.length) return;
    try {
      const { items } = await this.api.writeThread(batch);
      for (const item of items) if (!item.streaming) this.finished.add(item.id);
    } catch (err) {
      // Refused outright: sending the same again cannot help, so it is dropped.
      if (!retryable(err)) {
        this.opts.onError?.(err);
        return;
      }
      // Back in front, unless a newer payload for the same item came in meanwhile.
      const newer = this.pending;
      this.pending = new Map(batch.filter((i) => !newer.has(i.id)).map((i) => [i.id, i]));
      for (const [id, item] of newer) this.pending.set(id, item);
      throw err;
    } finally {
      if (this.pending.size) this.pacer.kick();
    }
  }
}

function clipped(item: Extract<ThreadWrite, { kind: "assistant" }>): ThreadWrite {
  const { text } = item.payload;
  if (text.length <= MAX_TEXT) return item;
  return { ...item, payload: { text: `${text.slice(0, MAX_TEXT - 1)}…` } };
}
