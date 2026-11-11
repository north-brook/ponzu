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
      const { seq } = await this.api.putState(body);
      this.opts.onSeq(seq);
    } catch (err) {
      if (retryable(err)) throw err;
      // Refused outright: the next change or heartbeat says it again.
      this.opts.onError?.(err);
    }
    this.sent = JSON.stringify(body);
  }
}
