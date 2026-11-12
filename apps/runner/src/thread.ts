import { type RunnerApi, retryable } from "./api/api.ts";
import { MAX_TEXT, MAX_THREAD_WRITE, type ThreadWrite } from "./api/protocol.ts";
import { Outbox } from "./pacer.ts";

/**
 * Writes the thread for the API, coalesced. Each item is written by id and only its latest
 * payload is sent, so text streaming at fifty tokens a second is a few writes a second, all
 * the items that changed together in one request, and nothing at all while nothing changes.
 */
export class ThreadWriter {
  /** Items the API has as finished: nothing more is sent for them. */
  private finished = new Set<string>();
  private readonly outbox: Outbox<ThreadWrite>;

  constructor(
    private readonly api: RunnerApi,
    private readonly opts: {
      gapMs: number;
      onError?: (err: unknown) => void;
      backoff?: (failures: number) => number;
    },
  ) {
    this.outbox = new Outbox((items) => this.send(items), {
      gapMs: opts.gapMs,
      max: MAX_THREAD_WRITE,
      onError: opts.onError,
      backoff: opts.backoff,
    });
  }

  write(item: ThreadWrite): void {
    if (this.finished.has(item.id)) return;
    this.outbox.put(item.id, item.kind === "assistant" ? clipped(item) : item);
  }

  /** Send everything written so far. */
  flush(): Promise<void> {
    return this.outbox.flush();
  }

  close(): void {
    this.outbox.close();
  }

  private async send(batch: ThreadWrite[]): Promise<void> {
    try {
      const { items } = await this.api.writeThread(batch);
      for (const item of items) if (!item.streaming) this.finished.add(item.id);
    } catch (err) {
      if (retryable(err)) throw err;
      if (batch.length === 1) {
        // Refused outright: sending the same again cannot help, so it is dropped.
        this.opts.onError?.(err);
        return;
      }
      // One item the API won't take mustn't take the rest down with it (the agent's text,
      // written with its turn): each goes again on its own, and only the refused one is lost.
      for (const item of batch) await this.send([item]);
    }
  }
}

function clipped(item: Extract<ThreadWrite, { kind: "assistant" }>): ThreadWrite {
  const { text } = item.payload;
  if (text.length <= MAX_TEXT) return item;
  return { ...item, payload: { text: `${text.slice(0, MAX_TEXT - 1)}…` } };
}
