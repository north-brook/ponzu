import type { CanvasOpen } from "@ponzu/core/links";
import type { QuestionBody, ThreadItem } from "@ponzu/runner/protocol";
import type { Api } from "../api.ts";

/** The lists a canvas's columns take, as the API's own answer about a canvas names them. */
type CanvasView = Awaited<ReturnType<Api["canvases"]["get"]>>;
type CanvasStatus = CanvasView["status"];
type AgentState = CanvasView["agentState"];
type AgentBlocker = NonNullable<CanvasView["agentBlocker"]>;
type PrState = NonNullable<CanvasView["prState"]>;
type PrChecks = CanvasView["prChecks"];
type QuestionStatus = "open" | "answered" | "cancelled";

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
    "claude_key_hint",
    "claude_connected_at",
    "claude_expires_at",
    "claude_limited_until",
  ],
  "me.notifications": [
    "id",
    "kind",
    "workspace_id",
    "canvas_id",
    "title",
    "subtitle",
    "body",
    "link",
    "count",
    "muted",
    "read_at",
    "resolved_at",
    "created_at",
    "updated_at",
  ],
  "workspace.canvases": [
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
    "agent_blocker",
    "needs_you_count",
    "pr_number",
    "pr_state",
    "pr_checks",
    "last_activity_at",
    "created_at",
    "seen_seq",
    "seen_thread_seq",
  ],
  "canvas.head": [
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
    "agent_blocker",
    "agent_blocked_until",
    "sandbox_state",
  ],
  "canvas.thread": [
    "id",
    "canvas_id",
    "seq",
    "kind",
    "user_id",
    "payload",
    "streaming",
    "created_at",
    "updated_at",
  ],
  "canvas.questions": ["id", "canvas_id", "seq", "kind", "payload", "status", "created_at"],
  "canvas.presence": [
    "canvas_id",
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
  "me.notifications": Record<string, never>;
  "workspace.canvases": { workspaceId: string };
  "canvas.head": { canvasId: string };
  "canvas.thread": { canvasId: string };
  "canvas.questions": { canvasId: string };
  "canvas.presence": { canvasId: string };
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
    /** The last four characters of an API key. */
    keyHint: string | null;
    connectedAt: string | null;
    /** When a subscription's token runs out: ask to sign in again a few weeks before. */
    expiresAt: string | null;
    limitedUntil: string | null;
  } | null;
}

/** What a notification opens, as ids: the thread, the pull request, a comment's pin, or usage. */
export interface NotificationLink {
  open: CanvasOpen;
  pageId?: string;
  artboardId?: string;
  commentThreadId?: string;
  questionId?: string;
}

/**
 * Something Ponzu told the person, in their inbox: unread, or a needs-you whose question is still
 * open. A canvas's name and Ponzu's own sentences, never anything a person or the agent wrote.
 */
export interface NotificationRow {
  id: string;
  /**
   * `needs_you`, `reply`, `teammate_comment` and the rest (apps/api/src/notifications/kinds.ts).
   * A string, so a kind a newer API adds still shows.
   */
  kind: string;
  workspaceId: string | null;
  /** Null for a ping about a workspace (billing). */
  canvasId: string | null;
  /** The canvas's name, or the workspace's. */
  title: string;
  subtitle: string | null;
  body: string;
  link: NotificationLink;
  /** How many things it stands for: a teammate's comments fold into one row. */
  count: number;
  /** The person's toggle for its kind was off: no banner and no ping, but a needs-you still counts on the badge. */
  muted: boolean;
  readAt: string | null;
  /** When its question closed, for a needs-you. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A row of the sidebar: a canvas and how far the person has looked at it. */
export interface CanvasListRow {
  id: string;
  workspaceId: string;
  repoId: string | null;
  repoFullName: string | null;
  ownerId: string | null;
  name: string;
  icon: string | null;
  branch: string | null;
  status: CanvasStatus;
  settledAt: string | null;
  seq: number;
  previewSeq: number | null;
  agentState: AgentState;
  agentStatus: string | null;
  agentBlocker: AgentBlocker | null;
  needsYouCount: number;
  prNumber: number | null;
  prState: PrState | null;
  prChecks: PrChecks;
  lastActivityAt: string;
  createdAt: string;
  seenSeq: number | null;
  seenThreadSeq: number | null;
}

/** A canvas's head: when `seq` moves, there are ops to fetch. */
export interface CanvasHeadRow {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  status: CanvasStatus;
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
  /** Why the agent cannot run now: "connect Claude", "waiting for a machine". Null when it can. */
  agentBlocker: AgentBlocker | null;
  /** Until when the blocker holds, when that is known (a Claude plan's limit resets then). */
  agentBlockedUntil: string | null;
  /** Null while the canvas has no sandbox. */
  sandboxState: string | null;
}

/** An open question the agent is waiting on a person for. */
export type QuestionRow = {
  id: string;
  canvasId: string;
  seq: number;
  status: QuestionStatus;
  at: string;
} & QuestionBody;

/** Someone with the canvas open. Gone after 75 seconds without `seenAt` moving (`presentNow`). */
export interface PresenceRow {
  canvasId: string;
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
  "me.notifications": NotificationRow;
  "workspace.canvases": CanvasListRow;
  "canvas.head": CanvasHeadRow;
  "canvas.thread": ThreadItem;
  "canvas.questions": QuestionRow;
  "canvas.presence": PresenceRow;
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
            keyHint: maybeText(r.claude_key_hint),
            connectedAt: maybeTime(r.claude_connected_at),
            expiresAt: maybeTime(r.claude_expires_at),
            limitedUntil: maybeTime(r.claude_limited_until),
          },
  }),
  "me.notifications": (r) => ({
    id: text(r.id),
    kind: text(r.kind),
    workspaceId: maybeText(r.workspace_id),
    canvasId: maybeText(r.canvas_id),
    title: text(r.title),
    subtitle: maybeText(r.subtitle),
    body: text(r.body),
    link: r.link as NotificationLink,
    count: number(r.count),
    muted: Boolean(r.muted),
    readAt: maybeTime(r.read_at),
    resolvedAt: maybeTime(r.resolved_at),
    createdAt: time(r.created_at),
    updatedAt: time(r.updated_at),
  }),
  "workspace.canvases": (r) => ({
    id: text(r.id),
    workspaceId: text(r.workspace_id),
    repoId: maybeText(r.repo_id),
    repoFullName: maybeText(r.repo_full_name),
    ownerId: maybeText(r.owner_id),
    name: text(r.name),
    icon: maybeText(r.icon),
    branch: maybeText(r.branch),
    status: r.status as CanvasStatus,
    settledAt: maybeTime(r.settled_at),
    seq: number(r.seq),
    previewSeq: maybeNumber(r.preview_seq),
    agentState: r.agent_state as AgentState,
    agentStatus: maybeText(r.agent_status),
    agentBlocker: (r.agent_blocker ?? null) as AgentBlocker | null,
    needsYouCount: number(r.needs_you_count),
    prNumber: maybeNumber(r.pr_number),
    prState: (r.pr_state ?? null) as PrState | null,
    prChecks: r.pr_checks as PrChecks,
    lastActivityAt: time(r.last_activity_at),
    createdAt: time(r.created_at),
    seenSeq: maybeNumber(r.seen_seq),
    seenThreadSeq: maybeNumber(r.seen_thread_seq),
  }),
  "canvas.head": (r) => ({
    id: text(r.id),
    workspaceId: text(r.workspace_id),
    name: text(r.name),
    icon: maybeText(r.icon),
    status: r.status as CanvasStatus,
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
    agentBlocker: (r.agent_blocker ?? null) as AgentBlocker | null,
    agentBlockedUntil: maybeTime(r.agent_blocked_until),
    sandboxState: maybeText(r.sandbox_state),
  }),
  "canvas.thread": (r) =>
    ({
      id: text(r.id),
      seq: number(r.seq),
      at: time(r.created_at),
      streaming: Boolean(r.streaming),
      kind: r.kind,
      payload: r.payload,
    }) as ThreadItem,
  "canvas.questions": (r) =>
    ({
      id: text(r.id),
      canvasId: text(r.canvas_id),
      seq: number(r.seq),
      status: r.status as QuestionStatus,
      at: time(r.created_at),
      kind: r.kind,
      payload: r.payload,
    }) as QuestionRow,
  "canvas.presence": (r) => ({
    canvasId: text(r.canvas_id),
    userId: text(r.user_id),
    pageId: maybeText(r.page_id),
    joinedAt: time(r.joined_at),
    seenAt: time(r.seen_at),
    githubLogin: text(r.github_login),
    name: maybeText(r.name),
    avatarUrl: maybeText(r.avatar_url),
  }),
};
