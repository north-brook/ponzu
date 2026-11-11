import type { AgentState, DesignStatus, PrChecks, PrState, QuestionStatus } from "@ponzu/db/types";
import type { QuestionBody, ThreadItem } from "@ponzu/runner/protocol";

/*
 * The rows each live query delivers, as the apps read them. The registry is the API's
 * (apps/api/src/live/queries.ts): these column lists mirror its SQL, and rows.test.ts fails
 * when the two drift apart. Realtime sends Postgres's names and a `bigint` as a string; each
 * row is decoded here into camelCase with numbers, and times as ISO 8601 strings, the way the
 * REST routes send them.
 */

export const LIVE_COLUMNS = {
  me: [
    "id",
    "github_login",
    "name",
    "email",
    "avatar_url",
    "default_agent",
    "default_model",
    "default_effort",
    "ping_needs_you",
    "ping_replies",
    "ping_pr_ready",
    "ping_teammate_comments",
    "email_digest",
    "onboarding_where_at",
    "onboarding_iphone_at",
    "claude_account_id",
    "claude_account_kind",
    "claude_account_status",
    "claude_plan_label",
    "claude_limited_until",
  ],
  "workspace.designs": [
    "id",
    "workspace_id",
    "repo_id",
    "repo_full_name",
    "owner_id",
    "name",
    "icon",
    "branch",
    "status",
    "settled_at",
    "seq",
    "preview_seq",
    "agent_state",
    "agent_status",
    "needs_you_count",
    "pr_number",
    "pr_state",
    "pr_checks",
    "last_activity_at",
    "created_at",
    "seen_seq",
    "seen_thread_seq",
  ],
  "design.head": [
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
    "sandbox_state",
  ],
  "design.thread": [
    "id",
    "design_id",
    "seq",
    "kind",
    "user_id",
    "payload",
    "streaming",
    "created_at",
    "updated_at",
  ],
  "design.questions": ["id", "design_id", "seq", "kind", "payload", "status", "created_at"],
  "design.presence": [
    "design_id",
    "user_id",
    "page_id",
    "joined_at",
    "seen_at",
    "github_login",
    "name",
    "avatar_url",
  ],
} as const;

export type LiveQueryName = keyof typeof LIVE_COLUMNS;

/** A row as Realtime delivers it: Postgres's column names, values not yet decoded. */
export type RawRow<Name extends LiveQueryName> = Record<
  (typeof LIVE_COLUMNS)[Name][number],
  unknown
>;

/** What each query is asked with. */
export interface LiveArgs {
  me: Record<string, never>;
  "workspace.designs": { workspaceId: string };
  "design.head": { designId: string };
  "design.thread": { designId: string };
  "design.questions": { designId: string };
  "design.presence": { designId: string };
}

/** The person's own row: their settings and their Claude account's state. */
export interface MeRow {
  id: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  defaultAgent: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
  pingNeedsYou: boolean;
  pingReplies: boolean;
  pingPrReady: boolean;
  pingTeammateComments: boolean;
  emailDigest: boolean;
  onboardingWhereAt: string | null;
  onboardingIphoneAt: string | null;
  claudeAccount: {
    id: string;
    kind: string;
    status: string;
    planLabel: string | null;
    limitedUntil: string | null;
  } | null;
}

/** A row of the sidebar: a design and how far the person has looked at it. */
export interface DesignListRow {
  id: string;
  workspaceId: string;
  repoId: string | null;
  repoFullName: string | null;
  ownerId: string | null;
  name: string;
  icon: string | null;
  branch: string | null;
  status: DesignStatus;
  settledAt: string | null;
  seq: number;
  previewSeq: number | null;
  agentState: AgentState;
  agentStatus: string | null;
  needsYouCount: number;
  prNumber: number | null;
  prState: PrState | null;
  prChecks: PrChecks;
  lastActivityAt: string;
  createdAt: string;
  seenSeq: number | null;
  seenThreadSeq: number | null;
}

/** A design's head: when `seq` moves, there are ops to fetch. */
export interface DesignHeadRow {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  status: DesignStatus;
  seq: number;
  previewSeq: number | null;
  agentState: AgentState;
  agentStatus: string | null;
  agentArtboards: string[];
  needsYouCount: number;
  prNumber: number | null;
  prState: PrState | null;
  prChecks: PrChecks;
  prMergeable: boolean | null;
  prAutoMerge: boolean;
  lastActivityAt: string;
  /** Null while the design has no sandbox. */
  sandboxState: string | null;
}

/** An open question the agent is waiting on a person for. */
export type QuestionRow = {
  id: string;
  designId: string;
  seq: number;
  status: QuestionStatus;
  at: string;
} & QuestionBody;

/** Someone with the design open. Gone after 75 seconds without `seenAt` moving (`presentNow`). */
export interface PresenceRow {
  designId: string;
  userId: string;
  pageId: string | null;
  joinedAt: string;
  seenAt: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface LiveRows {
  me: MeRow;
  "workspace.designs": DesignListRow;
  "design.head": DesignHeadRow;
  "design.thread": ThreadItem;
  "design.questions": QuestionRow;
  "design.presence": PresenceRow;
}

const text = (value: unknown) => value as string;
const maybeText = (value: unknown) => (value ?? null) as string | null;
const number = (value: unknown) => Number(value);
const maybeNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const time = (value: unknown) => new Date(value as string | Date).toISOString();
const maybeTime = (value: unknown) => (value === null || value === undefined ? null : time(value));

export const DECODE: { [Name in LiveQueryName]: (row: RawRow<Name>) => LiveRows[Name] } = {
  me: (r) => ({
    id: text(r.id),
    githubLogin: text(r.github_login),
    name: maybeText(r.name),
    email: maybeText(r.email),
    avatarUrl: maybeText(r.avatar_url),
    defaultAgent: maybeText(r.default_agent),
    defaultModel: maybeText(r.default_model),
    defaultEffort: maybeText(r.default_effort),
    pingNeedsYou: Boolean(r.ping_needs_you),
    pingReplies: Boolean(r.ping_replies),
    pingPrReady: Boolean(r.ping_pr_ready),
    pingTeammateComments: Boolean(r.ping_teammate_comments),
    emailDigest: Boolean(r.email_digest),
    onboardingWhereAt: maybeTime(r.onboarding_where_at),
    onboardingIphoneAt: maybeTime(r.onboarding_iphone_at),
    claudeAccount:
      r.claude_account_id === null || r.claude_account_id === undefined
        ? null
        : {
            id: text(r.claude_account_id),
            kind: text(r.claude_account_kind),
            status: text(r.claude_account_status),
            planLabel: maybeText(r.claude_plan_label),
            limitedUntil: maybeTime(r.claude_limited_until),
          },
  }),
  "workspace.designs": (r) => ({
    id: text(r.id),
    workspaceId: text(r.workspace_id),
    repoId: maybeText(r.repo_id),
    repoFullName: maybeText(r.repo_full_name),
    ownerId: maybeText(r.owner_id),
    name: text(r.name),
    icon: maybeText(r.icon),
    branch: maybeText(r.branch),
    status: r.status as DesignStatus,
    settledAt: maybeTime(r.settled_at),
    seq: number(r.seq),
    previewSeq: maybeNumber(r.preview_seq),
    agentState: r.agent_state as AgentState,
    agentStatus: maybeText(r.agent_status),
    needsYouCount: number(r.needs_you_count),
    prNumber: maybeNumber(r.pr_number),
    prState: (r.pr_state ?? null) as PrState | null,
    prChecks: r.pr_checks as PrChecks,
    lastActivityAt: time(r.last_activity_at),
    createdAt: time(r.created_at),
    seenSeq: maybeNumber(r.seen_seq),
    seenThreadSeq: maybeNumber(r.seen_thread_seq),
  }),
  "design.head": (r) => ({
    id: text(r.id),
    workspaceId: text(r.workspace_id),
    name: text(r.name),
    icon: maybeText(r.icon),
    status: r.status as DesignStatus,
    seq: number(r.seq),
    previewSeq: maybeNumber(r.preview_seq),
    agentState: r.agent_state as AgentState,
    agentStatus: maybeText(r.agent_status),
    agentArtboards: (r.agent_artboards ?? []) as string[],
    needsYouCount: number(r.needs_you_count),
    prNumber: maybeNumber(r.pr_number),
    prState: (r.pr_state ?? null) as PrState | null,
    prChecks: r.pr_checks as PrChecks,
    prMergeable: (r.pr_mergeable ?? null) as boolean | null,
    prAutoMerge: Boolean(r.pr_auto_merge),
    lastActivityAt: time(r.last_activity_at),
    sandboxState: maybeText(r.sandbox_state),
  }),
  "design.thread": (r) =>
    ({
      id: text(r.id),
      seq: number(r.seq),
      at: time(r.created_at),
      streaming: Boolean(r.streaming),
      kind: r.kind,
      payload: r.payload,
    }) as ThreadItem,
  "design.questions": (r) =>
    ({
      id: text(r.id),
      designId: text(r.design_id),
      seq: number(r.seq),
      status: r.status as QuestionStatus,
      at: time(r.created_at),
      kind: r.kind,
      payload: r.payload,
    }) as QuestionRow,
  "design.presence": (r) => ({
    designId: text(r.design_id),
    userId: text(r.user_id),
    pageId: maybeText(r.page_id),
    joinedAt: time(r.joined_at),
    seenAt: time(r.seen_at),
    githubLogin: text(r.github_login),
    name: maybeText(r.name),
    avatarUrl: maybeText(r.avatar_url),
  }),
};
