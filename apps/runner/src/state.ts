import { type RunnerApi, retryable } from "./api/api.ts";
import type { StateRequest } from "./api/protocol.ts";
import { Pacer } from "./pacer.ts";

/**
 * Reports what the agent is doing as it changes, at most a couple of times a second, and again
 * every heartbeat whether it changed or not: the heartbeat is how the API keeps a working
 * sandbox awake and notices a runner that died. Each answer carries the design's head.
 */
export class StateReporter {
  private state: StateRequest = {
    state: "idle",
    status: null,
    artboards: [],
    claudeSessionId: null,
  };
  private sent = "";
  private readonly pacer: Pacer;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: RunnerApi,
    private readonly opts: {
      gapMs: number;
      heartbeatMs: number;
      /** The design's head, from each answer. */
      onSeq(seq: number): void;
      /**
       * The stop the API is putting the sandbox through, from each answer: null when it is
       * awake. Not called by an API that does not say.
       */
      onSleep?(sleep: string | null): void;
      onError?(err: unknown): void;
      backoff?: (failures: number) => number;
    },
  ) {
    this.pacer = new Pacer(() => this.send(), opts.gapMs, opts.onError, opts.backoff);
  }

  get current(): StateRequest {
    return this.state;
  }

  set(change: Partial<StateRequest>): void {
    const next = { ...this.state, ...change };
    this.state = next;
    if (JSON.stringify(next) !== this.sent) this.pacer.kick();
  }

  start(): void {
    this.pacer.kick();
    this.heartbeat = setInterval(() => this.pacer.kick(), this.opts.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** Report now, changed or not: the answer is what says whether the sandbox is going to sleep. */
  now(): void {
    // Only once reporting has started: before that the runner has no lease to report under.
    if (this.heartbeat) this.pacer.kick();
  }

  /** Send the state as it is now and stop the heartbeat. */
  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.pacer.kick();
    await this.pacer.flush();
    this.pacer.close();
  }

  private async send(): Promise<void> {
    const body = this.state;
    try {
      const { seq, sleep } = await this.api.putState(body);
      this.opts.onSeq(seq);
      if (sleep !== undefined) this.opts.onSleep?.(sleep);
    } catch (err) {
      if (retryable(err)) throw err;
      // Refused outright: the next change or heartbeat says it again.
      this.opts.onError?.(err);
    }
    this.sent = JSON.stringify(body);
  }
}
