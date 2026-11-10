import type { ColorScheme, Replica } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import {
  EventHub,
  type NamedBytes,
  PresenceHub,
  type Telemetry,
  type Workspace,
} from "../context.ts";
import { ReplicaDesign } from "./replica-design.ts";

/** What the agent is doing, as the design's row shows it to everyone who has it open. */
export interface AgentStatus {
  /** The artboards it is working on. Empty once it has gone quiet. */
  artboards: string[];
  /** A few words from set_status, if it has said. */
  status?: string;
}

/**
 * What leaves the runner's process on the tools' behalf. The runner implements each against
 * the API; none is called while a tool reads or edits the canvas.
 */
export interface CloudHost {
  /** The agent's status changed. Called only when it differs from the last one told. */
  status(status: AgentStatus): void;
  /** What the person asked for, as the agent distilled it (set_status's intent). */
  intent(text: string): void;
  /**
   * Keep a file as one of the design's assets and resolve to the reference markup uses for
   * it, `assets/<name>`, once the bytes can be loaded from `assetBase`.
   */
  storeAsset(asset: NamedBytes): Promise<string>;
  /** What `assets/…` references resolve against when the renderer loads them. */
  assetBase(): string | undefined;
  /** Put an export where a link reaches it, and resolve to the link. Absent when nothing can. */
  publish?(file: NamedBytes): Promise<string>;
  /** A link that opens the design in Ponzu. */
  link(): string | undefined;
  /** The theme renders default to: the canvas of the person the agent is working for, once known. */
  theme(): ColorScheme | undefined;
}

export interface CloudWorkspaceOptions {
  /** The design's id: the key its events and presence go by. */
  id: string;
  /** The design. The runner opened it and closes it. */
  replica: Replica;
  /** Without one, screenshot, record and export say they can't run. */
  renderer?: Renderer;
  host: CloudHost;
  telemetry?: Telemetry;
}

/** The workspace for the one design a sandbox works on. */
export interface CloudWorkspace extends Workspace {
  readonly design: ReplicaDesign;
  /**
   * The agent's edits that were undone and that no tool result has said yet. `runTool` takes
   * them for each result; the runner takes what is left once a turn's edits have settled.
   */
  notices(): string[];
  /** Stop listening to the replica and telling the host. The replica and renderer stay open. */
  close(): void;
}

/**
 * The `Workspace` the runner hands to `runTool`, with `cloudTools`, for its sandbox's one
 * design. Events and presence are kept in this process, which lives as long as the sandbox is
 * awake.
 *
 * At the end of a turn, and before the sandbox sleeps, the runner waits on `design.settled`,
 * tells the agent whatever `notices` still holds, and calls `presence.leave` with the caller's
 * id so nothing shows as worked on.
 */
export function createCloudWorkspace(opts: CloudWorkspaceOptions): CloudWorkspace {
  const { id: key, host } = opts;
  const events = new EventHub();
  const presence = new PresenceHub();
  const design = new ReplicaDesign(opts.replica, { key, events, presence });
  const open = { key, design };

  // Every tool call touches presence, and most change nothing the host shows.
  let told = JSON.stringify({ artboards: [] } satisfies AgentStatus);
  const offPresence = presence.on((list) => {
    const status: AgentStatus = {
      artboards: [...new Set(list.flatMap((p) => p.working))],
      status: list.find((p) => p.status)?.status,
    };
    const next = JSON.stringify(status);
    if (next === told) return;
    told = next;
    host.status(status);
  });

  return {
    design,
    events,
    presence,
    renderer: opts.renderer,
    telemetry: opts.telemetry,
    designs: () => [open],
    resolve: async () => open,
    get theme() {
      return host.theme();
    },
    assetBase: () => host.assetBase(),
    link: () => host.link(),
    intent: (_key, text) => host.intent(text),
    storeAsset: (_key, asset) => host.storeAsset(asset),
    publish: host.publish && ((_key, file) => host.publish!(file)),
    notices: () => design.notices(),
    close() {
      offPresence();
      design.close();
    },
  };
}
