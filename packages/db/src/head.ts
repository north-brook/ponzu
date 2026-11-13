import type { AgentState, CanvasStatus, PrChecks, PrState } from "./enums.ts";
import type { CanvasDriverView } from "./schema/canvases.ts";

/**
 * The part of a canvas that clients watch live. It is small and changes often; when `seq`
 * moves, a client fetches the ops after its own seq from the API.
 */
export interface CanvasHead {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  status: CanvasStatus;
  /** The seq of the last committed op: the version of the document. */
  seq: number;
  /** The seq the uploaded previews show. */
  previewSeq: number | null;
  agentState: AgentState;
  /** One line: what the agent is doing. */
  agentStatus: string | null;
  agentArtboards: string[];
  needsYouCount: number;
  prNumber: number | null;
  prState: PrState | null;
  prChecks: PrChecks;
  prMergeable: boolean | null;
  prAutoMerge: boolean;
  lastActivityAt: Date;
  /**
   * When the canvas's file links were last reset; null while they never were. When it moves,
   * the canvas's address for its files (`GET /v1/canvases/:id`) has changed.
   */
  assetKeyRotatedAt: Date | null;
  /**
   * The person's own agent driving the canvas in place of Ponzu's agent, or null
   * (docs/cloud.md, "Driving a canvas").
   */
  driver: CanvasDriverView | null;
}

/**
 * The columns of `canvases` a live query for the head selects, by their own names, which is
 * what Realtime wants its keys to be: `select ${CANVAS_HEAD_COLUMNS.join(", ")} from canvases …`.
 */
export const CANVAS_HEAD_COLUMNS = [
  "id",
  "workspace_id",
  "name",
  "icon",
  "status",
  "seq",
  "preview_seq",
  "agent_state",
  "agent_status",
  "agent_artboards",
  "needs_you_count",
  "pr_number",
  "pr_state",
  "pr_checks",
  "pr_mergeable",
  "pr_auto_merge",
  "last_activity_at",
  "asset_key_rotated_at",
  "driver",
] as const;

/** A head as Realtime delivers it: keyed by column, with each `bigint` as a string. */
export type LiveCanvasHead = Record<(typeof CANVAS_HEAD_COLUMNS)[number], unknown>;

/**
 * Turn a row from a live query into a `CanvasHead`. Realtime hands a `bigint` over as a string,
 * and two seqs compared as strings put "10" before "9", so nothing should read the row raw.
 */
export function toCanvasHead(row: LiveCanvasHead): CanvasHead {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    icon: row.icon as string | null,
    status: row.status as CanvasStatus,
    seq: Number(row.seq),
    previewSeq: row.preview_seq === null ? null : Number(row.preview_seq),
    agentState: row.agent_state as AgentState,
    agentStatus: row.agent_status as string | null,
    agentArtboards: row.agent_artboards as string[],
    needsYouCount: row.needs_you_count as number,
    prNumber: row.pr_number as number | null,
    prState: row.pr_state as PrState | null,
    prChecks: row.pr_checks as PrChecks,
    prMergeable: row.pr_mergeable as boolean | null,
    prAutoMerge: row.pr_auto_merge as boolean,
    lastActivityAt: new Date(row.last_activity_at as string | Date),
    assetKeyRotatedAt:
      row.asset_key_rotated_at === null || row.asset_key_rotated_at === undefined
        ? null
        : new Date(row.asset_key_rotated_at as string | Date),
    driver: (row.driver ?? null) as CanvasDriverView | null,
  };
}
