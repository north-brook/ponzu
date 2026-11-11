import {
  type Actor,
  type ColorScheme,
  CommitRefusedError,
  type Doc,
  InvalidOpError,
  type Op,
  Replica,
  type Scheduler,
  type SyncTransport,
} from "@ponzu/core";
import { Sequencer } from "@ponzu/core/testing";
import type { Renderer } from "@ponzu/render";
import type { NamedBytes, Telemetry, ToolContext } from "../context.ts";
import type { AgentFiles } from "../disk.ts";
import {
  type AgentStatus,
  type CloudHost,
  type CloudWorkspace,
  createCloudWorkspace,
} from "./workspace.ts";

/*
 * A whole cloud host in memory, for tests: the API's side of the sync protocol (core's
 * `Sequencer`), a replica of the design talking to it, and a host that records what the tools
 * hand it. Nothing touches a network or a clock but the replica's own retry timer.
 */

/** Who the tools edit as. */
export const AGENT: Actor = { kind: "agent", id: "agent_claude", name: "Claude" };

/** A host that keeps what it is handed, so a test can look. */
export interface MemoryHost extends CloudHost {
  statuses: AgentStatus[];
  intents: string[];
  /** Stored assets, by the reference `storeAsset` gave back. */
  assets: Map<string, NamedBytes>;
  published: NamedBytes[];
  /** What `theme()` answers. Unset until a test says. */
  canvasTheme?: ColorScheme;
}

export function memoryHost(): MemoryHost {
  const host: MemoryHost = {
    statuses: [],
    intents: [],
    assets: new Map(),
    published: [],
    status: (status) => void host.statuses.push(status),
    intent: (text) => void host.intents.push(text),
    async storeAsset(asset) {
      const ref = `assets/${asset.name}`;
      host.assets.set(ref, asset);
      return ref;
    },
    assetBase: () => "https://assets.ponzu.test/key",
    async publish(file) {
      host.published.push(file);
      return `https://exports.ponzu.test/${file.name}`;
    },
    link: () => "https://ponzu.test/designs/dsn_test",
    theme: () => host.canvasTheme,
  };
  return host;
}

/** The API as `actor` reaches it: every request answered at once, from memory. */
export function memoryTransport(api: Sequencer, actor: Actor): SyncTransport {
  return {
    async commit(ops) {
      try {
        return api.commit(ops, actor);
      } catch (err) {
        // A post that isn't one: the API answers 400, and that never changes.
        if (err instanceof InvalidOpError) throw new CommitRefusedError(err.message);
        throw err;
      }
    },
    fetchOps: async (after) => api.opsAfter(after),
    fetchDoc: async () => api.snapshot(),
  };
}

export interface MemoryCloud {
  /** The API's side: the design as committed, and its log. */
  api: Sequencer;
  replica: Replica;
  host: MemoryHost;
  ws: CloudWorkspace;
  /** What to hand `runTool`, as the agent. */
  ctx: ToolContext;
  /**
   * Commit an op as someone else, straight to the API. The replica doesn't know until
   * `synced` tells it, as it wouldn't until the design's head row moved.
   */
  commitAs(actor: Actor, op: Op): void;
  /** Tell the replica where the head is, and wait until it is there with nothing of its own pending. */
  synced(): Promise<void>;
  close(): void;
}

export function memoryCloud(
  doc: Doc,
  opts: {
    renderer?: Renderer;
    host?: MemoryHost;
    /** In place of `memoryTransport`, to hold requests back or fail them. */
    transport?: (api: Sequencer) => SyncTransport;
    /** In place of real timers for the replica's retries, to hold one back. */
    schedule?: Scheduler;
    telemetry?: Telemetry;
    files?: AgentFiles;
  } = {},
): MemoryCloud {
  const api = new Sequencer(doc);
  const replica = new Replica({
    transport: opts.transport?.(api) ?? memoryTransport(api, AGENT),
    schedule:
      opts.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      }),
    actor: AGENT,
    ...api.snapshot(),
  });
  const host = opts.host ?? memoryHost();
  const ws = createCloudWorkspace({
    id: "dsn_test",
    replica,
    renderer: opts.renderer,
    host,
    telemetry: opts.telemetry,
    files: opts.files,
  });
  let posted = 0;
  return {
    api,
    replica,
    host,
    ws,
    ctx: {
      ws,
      caller: { id: "agent", author: { kind: "agent", name: AGENT.name }, client: "claude" },
    },
    commitAs(actor, op) {
      const { rejected } = api.commit([{ id: `op_remote_${++posted}`, op }], actor);
      if (rejected[0]) throw new Error(`The API rejected it: ${rejected[0].reason}`);
    },
    synced() {
      replica.notify(api.seq);
      return new Promise((resolve) => {
        const check = () => {
          if (replica.seq !== api.seq || replica.pending.length) return;
          off();
          resolve();
        };
        const off = replica.subscribe(check);
        check();
      });
    },
    close() {
      ws.close();
      replica.close();
    },
  };
}
