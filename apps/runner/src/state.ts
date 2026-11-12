import { type RunnerApi, retryable } from "./api/api.ts";
import type { ClaudeLimitReport, StateRequest } from "./api/protocol.ts";
import { Pacer } from "./pacer.ts";

/**
 * Reports what the agent is doing as it changes, at most a couple of times a second, and again
 * every heartbeat whether it changed or not: the heartbeat is how the API keeps a working
 * sandbox awake and notices a runner that died. Each answer carries the canvas's head.
 */
export class StateReporter {
  private state: StateRequest = {
    state: "idle",
    status: null,
    artboards: [],
    claudeSessionId: null,
  };
  private sent = "";
  /** The branch report last sent, by identity: each push's outcome is a new object. */
  private sentBranch: StateRequest["branch"];
  /**
   * What Claude Code said of the plan's limits and the API has not been told, the latest for
   * each window, oldest first: one goes with each report, so a burst about two windows inside
   * one pacer gap loses neither.
   */
  private limits: ClaudeLimitReport[] = [];
  /** What each window last said that went to the API, so the same news is not sent twice. */
  private readonly saidLimits = new Map<string | null, string>();
  /** The limit report on its way to the API, if any: what the API will hold once it lands. */
  private sendingLimit: ClaudeLimitReport | null = null;
  private readonly pacer: Pacer;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: RunnerApi,
    private readonly opts: {
      gapMs: number;
      heartbeatMs: number;
      /** The canvas's head, from each answer. */
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
    const news = change.branch !== undefined && change.branch !== this.sentBranch;
    if (news || JSON.stringify(next) !== this.sent) this.pacer.kick();
  }

  /**
   * Pass on what Claude Code said of one of the plan's limits, once: news, like the branch, and
   * said again only when it changes.
   */
  limit(report: ClaudeLimitReport): void {
    const said = JSON.stringify(report);
    // Compared with what the API will hold: the report in flight for this window when there is
    // one, so a change back while it travels is still said.
    const sending = this.sendingLimit;
    const last =
      sending?.window === report.window
        ? JSON.stringify(sending)
        : this.saidLimits.get(report.window);
    if (last === said) {
      this.limits = this.limits.filter((l) => l.window !== report.window);
      return;
    }
    this.limits = [...this.limits.filter((l) => l.window !== report.window), report];
    this.pacer.kick();
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
    const state = this.state;
    // `branch` is news, said once per push: the API keeps it until the next one (absent leaves
    // it), and clears its error itself when a person asks for a new push (Create PR). Said again
    // with every heartbeat, an old failure would undo that clearing before the new push ends.
    // A limit is news the same way, one window at a time.
    const { branch, claudeLimit: _never, ...rest } = state;
    const limit = this.limits[0];
    const body: StateRequest = {
      ...rest,
      ...(branch !== undefined && branch !== this.sentBranch ? { branch } : {}),
      ...(limit ? { claudeLimit: limit } : {}),
    };
    this.sendingLimit = limit ?? null;
    try {
      const { seq } = await this.api.putState(body);
      this.opts.onSeq(seq);
    } catch (err) {
      if (retryable(err)) {
        // Not taken: it goes again, unless newer news for its window has come meanwhile.
        if (limit && !this.limits.some((l) => l.window === limit.window)) {
          this.limits = [limit, ...this.limits.filter((l) => l !== limit)];
        }
        this.sendingLimit = null;
        throw err;
      }
      // Refused outright: the next change or heartbeat says it again.
      this.opts.onError?.(err);
    }
    this.sentBranch = branch;
    this.sent = JSON.stringify(state);
    if (limit) {
      this.sendingLimit = null;
      this.saidLimits.set(limit.window, JSON.stringify(limit));
      this.limits = this.limits.filter((l) => l !== limit);
      if (this.limits.length) this.pacer.kick();
    }
  }
}
