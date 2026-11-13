// The fixed lists behind the schema's check constraints, and their types. Nothing here imports
// Drizzle or a driver, so a client can import a list as a value (see `@ponzu/db/types`).

export const WORKSPACE_KINDS = ["personal", "org"] as const;
export const REPOSITORY_SELECTIONS = ["all", "selected"] as const;
export const MEMBER_ROLES = ["admin", "member"] as const;
/** What GitHub says a person may do in a repo: its four legacy answers. */
export const REPO_PERMISSIONS = ["admin", "write", "read", "none"] as const;
/**
 * How a member reaches a workspace on GitHub: they own its account (a personal account's
 * person, an organization's owners), they are in its organization, or only some of its repos
 * are shared with them.
 */
export const GITHUB_ACCESS = ["owner", "member", "collaborator"] as const;
export const BASE_STATUSES = ["none", "building", "ready", "failed"] as const;
export const CLAUDE_ACCOUNT_KINDS = ["subscription", "api_key"] as const;
export const CLAUDE_ACCOUNT_STATUSES = ["connected", "expired", "revoked"] as const;
export const DEVICE_PLATFORMS = ["ios", "macos"] as const;
export const PUSH_ENVIRONMENTS = ["development", "production"] as const;
export const AUTH_STATE_KINDS = ["github_install", "claude_sign_in"] as const;
export const AGENT_TOKEN_KINDS = ["access", "refresh"] as const;

export const CANVAS_STATUSES = ["active", "settled"] as const;
export const AGENT_STATES = ["idle", "waking", "working", "needs_you", "limited"] as const;
export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export const PR_CHECKS = ["none", "running", "failing", "passing"] as const;
export const OP_KINDS = ["do", "undo", "redo"] as const;
export const ACTOR_KINDS = ["user", "agent"] as const;
/** Who linked a pull request to a canvas: a person in Ponzu, or an agent of theirs over MCP. */
export const PR_LINK_SOURCES = ["person", "agent"] as const;
export const THREAD_ITEM_KINDS = ["message", "comment", "assistant", "tool", "notice"] as const;
export const EVENT_KINDS = [
  "message",
  "answer",
  "comment",
  "edit",
  "check",
  "review",
  "stop",
  "push",
] as const;
export const EVENT_PRIORITIES = ["now", "next", "later"] as const;
export const QUESTION_KINDS = [
  "question",
  "permission",
  "plan",
  "elicitation",
  "handoff",
  "secret",
] as const;
export const QUESTION_STATUSES = ["open", "answered", "cancelled"] as const;
/**
 * A canvas's sandbox as the API drives it (docs/cloud.md, "The sandbox"):
 *
 *   asleep     no session the row holds is running (a wake that gave up says why in `failure`)
 *   waking     a wake job holds the row: a create, a resume, or a restart in place
 *   awake      a session is running, `ponzu-start` was sent, and the row is metered
 *   stopping   the sweep is shutting the runner down and stopping the session, or a retire holds
 *              the row until its sandbox is deleted
 *
 * No row is no sandbox.
 */
export const SANDBOX_STATES = ["asleep", "waking", "awake", "stopping"] as const;
/**
 * Why a canvas's agent cannot run, when something outside the canvas must change first: its
 * owner's Claude is not connected, or has expired; its owner, whose Claude it runs on, is no
 * longer in its workspace; no machine can be started for now, so the wake is waiting (and
 * retrying by itself); or the sandbox failed to start for good.
 *
 * The wake gates (apps/api/src/sandboxes/gates.ts) add the rest: Ponzu has paused wakes while
 * it updates (`paused`); the workspace has used its free credits with no card, reached its
 * spend cap, or has a payment that didn't go through; or the owner's Claude plan is at its
 * limit until `agent_blocked_until` (`claude_limited`).
 */
export const AGENT_BLOCKERS = [
  "claude_not_connected",
  "claude_expired",
  "claude_owner_left",
  "sandbox_busy",
  "sandbox_failed",
  "paused",
  "credits_used_up",
  "cap_reached",
  "payment_failed",
  "claude_limited",
] as const;
/**
 * What uploaded bytes are for: a file of the canvas, a file a link reaches, the sidebar's
 * picture; and two the runner keeps that no client ever reads: the Claude session's transcript
 * and a Scratch canvas's work in progress, each a compressed archive (docs/cloud.md, "Saving
 * the sandbox"). A `comment` is a person's picture of where they left a comment, as the thread
 * shows it.
 */
export const UPLOAD_PURPOSES = [
  "asset",
  "export",
  "preview",
  "session",
  "workspace",
  "comment",
] as const;

export const USAGE_KINDS = ["sandbox", "model"] as const;
export const USAGE_PAYERS = ["ponzu", "own_plan"] as const;
export const LEDGER_REASONS = ["grant", "use", "topup", "refund", "adjustment"] as const;

export const WEBHOOK_SOURCES = ["github", "stripe", "workos"] as const;

/**
 * What a search entry is (`search_entries.kind`): a canvas's name, a page's or a board's name, a
 * message of a comment thread, a thread message (a person's, or the agent's settled answer), or
 * a pull request's title. The same list as `SEARCH_KINDS` in `@ponzu/core`, which a test holds
 * in step; it is written out here so this file imports nothing.
 */
export const SEARCH_KINDS = [
  "canvas",
  "page",
  "board",
  "comment",
  "message",
  "pull_request",
] as const;
/**
 * What Ponzu pings a person about (docs/cloud.md, "Notifications"). Each is under one of the
 * person's toggles, except the four billing kinds, which are always on and go to a workspace's
 * admins. apps/api/src/notifications/kinds.ts gives each its toggle, where it opens and its
 * dedupe key.
 */
export const NOTIFICATION_KINDS = [
  "needs_you",
  "reply",
  "finished",
  "failed",
  "claude_limit",
  "pr_ready",
  "pr_approved",
  "teammate_comment",
  "billing_free_used",
  "billing_cap_warning",
  "billing_cap_reached",
  "billing_payment_failed",
] as const;
/**
 * Where a notification opens: the canvas's thread, its pull request, a comment's pin, or Plan
 * and usage. The words are the link grammar's (`open` on a canvas link, @ponzu/core/links).
 */
export const NOTIFICATION_OPENS = ["thread", "pull-request", "comment", "usage"] as const;
/**
 * How a notification came to be read: on the Mac or the iPhone (a banner or a tap), by opening
 * its canvas (`seen`), because the person was looking at the canvas when it was made
 * (`looking`), or by the sweep, unread after three days (`expired`).
 */
export const NOTIFICATION_READ_VIA = ["mac", "ios", "seen", "looking", "expired"] as const;
/**
 * One push to one iPhone:
 *
 *   waiting     planned, to go at `send_at` (now, or later while the person is at a Mac)
 *   sending     handed to Expo, whose answer has not come back. A send whose answer was lost
 *               (a timeout, a 5xx) may have been accepted, so it is not sent again; the
 *               receipts sweep settles it as `unknown`. One Expo plainly did not take (a 429)
 *               goes back to waiting, to try again
 *   sent        Expo took it and gave a ticket; its receipt is still to read
 *   delivered   Expo's receipt says Apple took it
 *   cancelled   not sent, and `outcome` says why
 *   failed      Expo refused it, at the ticket or the receipt, and `outcome` has its code
 *   unknown     no answer or receipt came within a day
 */
export const DELIVERY_STATES = [
  "waiting",
  "sending",
  "sent",
  "delivered",
  "cancelled",
  "failed",
  "unknown",
] as const;
/** The states a delivery does not leave. */
export const SETTLED_DELIVERY_STATES = ["delivered", "cancelled", "failed", "unknown"] as const;

/**
 * How a legal notice's email ended for one person (`email_notices`): `pending` while it is being
 * sent, then what happened. Only `pending` is ever written again.
 */
export const EMAIL_NOTICE_OUTCOMES = ["pending", "sent", "refused", "no_address", "held"] as const;

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type RepoPermission = (typeof REPO_PERMISSIONS)[number];
export type GithubAccess = (typeof GITHUB_ACCESS)[number];
export type BaseStatus = (typeof BASE_STATUSES)[number];
export type ClaudeAccountKind = (typeof CLAUDE_ACCOUNT_KINDS)[number];
export type ClaudeAccountStatus = (typeof CLAUDE_ACCOUNT_STATUSES)[number];
export type CanvasStatus = (typeof CANVAS_STATUSES)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type PrState = (typeof PR_STATES)[number];
export type PrChecks = (typeof PR_CHECKS)[number];
export type OpKind = (typeof OP_KINDS)[number];
export type AgentTokenKind = (typeof AGENT_TOKEN_KINDS)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type PrLinkSource = (typeof PR_LINK_SOURCES)[number];
export type ThreadItemKind = (typeof THREAD_ITEM_KINDS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventPriority = (typeof EVENT_PRIORITIES)[number];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export type SandboxState = (typeof SANDBOX_STATES)[number];
export type AgentBlocker = (typeof AGENT_BLOCKERS)[number];
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationOpen = (typeof NOTIFICATION_OPENS)[number];
export type NotificationReadVia = (typeof NOTIFICATION_READ_VIA)[number];
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type EmailNoticeOutcome = (typeof EMAIL_NOTICE_OUTCOMES)[number];
