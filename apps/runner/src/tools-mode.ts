import { type Actor, Replica } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import {
  type CloudWorkspace,
  createCloudWorkspace,
  getRemoteTool,
  runTool,
  type ToolCaller,
  type ToolResult,
} from "@ponzu/tools";
import { fatal, type RunnerApi, retryable, watchFatal } from "./api/api.ts";
import { CLAIM_LIMIT, HEARTBEAT_MS, type RunnerSession } from "./api/protocol.ts";
import { randomId } from "./ids.ts";
import { StateReporter } from "./state.ts";

/*
 * The runner in tools mode (docs/cloud.md, "Driving a canvas"): a person's own agent drives the
 * canvas through Ponzu's MCP, so there is no Claude Code here. What runs is the canvas (its
 * replica, the renderer for measuring, screenshots, recordings, exports and lint) and the canvas
 * tools, which the API relays the agent's calls to (`POST /tool` on the runner's port).
 *
 * It keeps the runner protocol a Claude runner keeps, as far as a canvas with no agent needs:
 * the session and its lease, the heartbeat (a state report every `HEARTBEAT_MS`, always idle),
 * and claims. The API hands a driven canvas's runner only what begins no turn (a stop, an edit,
 * a push: `claimableKinds`), which it acknowledges and has nothing to do with: the branch never
 * moves here, and an edit reaches the driving agent through its own `wait_for_activity`.
 * Nothing in the sandbox changes but the canvas, which lives at the API, so there is nothing to
 * checkpoint.
 */

/** Who the replica edits as. The API takes the real actor from the runner token. */
const ACTOR: Actor = { kind: "agent", id: "agent_driver", name: "Agent" };

/** Who calls a tool: the agent driving, as its notes and comments name it. */
export interface Driver {
  name: string;
  client: string;
}

export interface ToolsRunnerOptions {
  api: RunnerApi;
  renderer?: Renderer;
  log(message: string): void;
  /** A token or lease that the API will never take again: the process should exit. */
  onFatal?(): void;
  /** For tests: how often to claim when nothing pokes, and to report. */
  timing?: { claimEveryMs?: number; heartbeatMs?: number };
}

/** What `POST /tool` answers: MCP's tool content, ready to hand on. */
export interface ToolAnswer {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
}

export class ToolsRunner {
  private readonly api: RunnerApi;
  private session!: RunnerSession;
  private replica!: Replica;
  private ws!: CloudWorkspace;
  private state!: StateReporter;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private claiming: Promise<void> | null = null;
  private claimAgain = false;
  private claimId: string | null = null;
  private stopping = false;
  /** One call at a time, in the order they came: the replica is one agent's view. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ToolsRunnerOptions) {
    this.api = watchFatal(opts.api, () => {
      this.stopping = true;
      opts.onFatal?.();
    });
  }

  async start(): Promise<void> {
    this.session = await this.retry(() => this.api.session({}));
    this.state = new StateReporter(this.api, {
      gapMs: 500,
      heartbeatMs: this.opts.timing?.heartbeatMs ?? HEARTBEAT_MS,
      onSeq: (seq) => this.replica?.notify(seq),
      onError: (err) => this.opts.log(`state report failed: ${said(err)}`),
    });
    this.state.set({ state: "idle", status: null, artboards: [], claudeSessionId: null });
    this.state.start();
    this.replica = await this.retry(() =>
      Replica.open({ transport: this.api.sync, schedule: timer, actor: ACTOR }),
    );
    this.replica.notify(this.session.seq);
    this.ws = createCloudWorkspace({
      id: this.session.canvas.id,
      replica: this.replica,
      ...(this.opts.renderer ? { renderer: this.opts.renderer } : {}),
      host: {
        // What the agent says it is doing shows where Ponzu's agent's status would.
        status: (status) =>
          this.state.set({ status: status.status ?? null, artboards: status.artboards }),
        intent: () => {},
        storeAsset: async (asset) => {
          const [stored] = await this.api.upload([
            { purpose: "asset", name: asset.name, contentType: asset.mime, bytes: asset.bytes },
          ]);
          return stored!.ref!;
        },
        assetBase: () => this.session.assetBase,
        publish: async (file) => {
          const [stored] = await this.api.upload([
            { purpose: "export", name: file.name, contentType: file.mime, bytes: file.bytes },
          ]);
          return stored!.url;
        },
        link: () => this.session.link,
        theme: () => this.session.theme ?? undefined,
      },
    });
    this.claimTimer = setInterval(() => this.claim(), this.opts.timing?.claimEveryMs ?? 60_000);
    this.claimTimer.unref?.();
    this.claim();
  }

  /** Something may be waiting to be claimed. */
  poke(): void {
    this.claim();
  }

  health(): { started: boolean; state: "idle"; mode: "tools" } {
    return { started: this.claimTimer !== null && !this.stopping, state: "idle", mode: "tools" };
  }

  /**
   * One of the driving agent's calls: the canvas tool `name` with `args`, as `driver`. Calls
   * run one at a time, in order. A tool's own refusal is an answer with `isError`; only a tool
   * that doesn't exist, or a runner not started, is thrown.
   */
  call(name: string, args: unknown, driver: Driver): Promise<ToolAnswer> {
    const def = getRemoteTool(name);
    if (!def) throw new ToolsModeError(404, `There is no canvas tool ${name}.`);
    if (!this.claimTimer || this.stopping) {
      throw new ToolsModeError(503, "The canvas isn't open here yet.");
    }
    const caller: ToolCaller = {
      id: `driver:${driver.client}`,
      author: { kind: "agent", name: driver.name },
      client: driver.client,
    };
    const run = this.queue.then(() => runTool(def, args, { ws: this.ws, caller }));
    this.queue = run.catch(() => {});
    return run.then(toAnswer);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.claimTimer) clearInterval(this.claimTimer);
    // The agent's last edits reach the API before the process goes.
    await this.ws?.canvas.settled?.(5_000).catch(() => {});
    await this.state?.stop().catch(() => {});
    await this.opts.renderer?.close?.().catch(() => {});
  }

  private claim(): void {
    if (this.stopping || !this.claimTimer) return;
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = (async () => {
      do {
        this.claimAgain = false;
        try {
          this.claimId ??= randomId("clm");
          const { events, seq } = await this.api.claim({
            claimId: this.claimId,
            limit: CLAIM_LIMIT,
          });
          this.claimId = null;
          this.replica.notify(seq);
          // Nothing here takes them up: said to be taken, so none is handed out again.
          if (events.length > 0)
            await this.api.ack(
              events.map((event) => event.id),
              null,
            );
        } catch (err) {
          if (fatal(err)) return;
          this.opts.log(`claim failed: ${said(err)}`);
          if (!retryable(err)) this.claimId = null;
        }
      } while (this.claimAgain && !this.stopping);
    })().finally(() => {
      this.claiming = null;
    });
  }

  private async retry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!retryable(err) || attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
}

/** A call `POST /tool` refuses before any tool runs. */
export class ToolsModeError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ToolsModeError";
  }
}

/** A tool's result as MCP content. */
export function toAnswer(result: ToolResult): ToolAnswer {
  return {
    content: [
      { type: "text", text: result.text },
      ...(result.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mime,
      })),
    ],
    isError: result.isError ?? false,
  };
}

const timer = (run: () => void, ms: number) => {
  const t = setTimeout(run, ms);
  return () => clearTimeout(t);
};

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
