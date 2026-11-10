import type { AgentState, DesignStatus, PrChecks, PrState } from "./enums.ts";

/**
 * The part of a design that clients watch live. It is small and changes often; when `seq`
 * moves, a client fetches the ops after its own seq from the API.
 */
export interface DesignHead {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  status: DesignStatus;
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
}

/**
 * The columns of `designs` a live query for the head selects, by their own names, which is
 * what Realtime wants its keys to be: `select ${DESIGN_HEAD_COLUMNS.join(", ")} from designs …`.
 */
export const DESIGN_HEAD_COLUMNS = [
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
] as const;

/** A head as Realtime delivers it: keyed by column, with each `bigint` as a string. */
export type LiveDesignHead = Record<(typeof DESIGN_HEAD_COLUMNS)[number], unknown>;

/**
 * Turn a row from a live query into a `DesignHead`. Realtime hands a `bigint` over as a string,
 * and two seqs compared as strings put "10" before "9", so nothing should read the row raw.
 */
export function toDesignHead(row: LiveDesignHead): DesignHead {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    icon: row.icon as string | null,
    status: row.status as DesignStatus,
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
  };
}
