import type { Doc, Op } from "@ponzu/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  ACTOR_KINDS,
  AGENT_BLOCKERS,
  AGENT_STATES,
  CANVAS_STATUSES,
  EVENT_KINDS,
  EVENT_PRIORITIES,
  OP_KINDS,
  PR_CHECKS,
  PR_STATES,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  SANDBOX_STATES,
  THREAD_ITEM_KINDS,
  UPLOAD_PURPOSES,
} from "../enums.ts";
import { claudeAccounts, repos, users, workspaces } from "./accounts.ts";
import { atMostBytes, createdAt, instant, type Json, oneOf, updatedAt } from "./columns.ts";

/** The most a row the sandbox writes and clients watch may carry in one json value. */
const WATCHED_PAYLOAD_BYTES = 256 * 1024;

/**
 * One canvas. The row is small on purpose: clients watch it live, so its content lives in
 * `canvas_ops` and `canvas_checkpoints` and only the pointer to it (`seq`) lives here.
 */
export const canvases = pgTable(
  "canvases",
  {
    id: text("id").primaryKey(),
    // A workspace with canvases cannot be deleted from under them; delete the canvases first.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** Null for Scratch. A repo the App lost is marked removed, never deleted, so this holds. */
    repoId: text("repo_id"),
    // A canvas belongs to its workspace and outlives the person who started it.
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Whose Claude runs it, from start to finish. */
    claudeAccountId: text("claude_account_id").references(() => claudeAccounts.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    icon: text("icon"),
    /** `pz/<topic>`. Null for Scratch. */
    branch: text("branch"),
    model: text("model"),
    effort: text("effort"),
    status: text("status", { enum: CANVAS_STATUSES }).notNull().default("active"),
    settledAt: instant("settled_at"),
    /** The seq of the last committed op: the version of the document. */
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    /** The path segment its files are served under. Knowing it is the permission to read them. */
    assetKey: text("asset_key").notNull().unique(),
    /**
     * When the asset key was last reset (`POST /v1/canvases/:id/asset-key/rotate`). Null while
     * it is the one it was made with. In the head, so a client that sees it move asks for the
     * new address.
     */
    assetKeyRotatedAt: instant("asset_key_rotated_at"),
    /** The seq the uploaded previews show. */
    previewSeq: bigint("preview_seq", { mode: "number" }),
    prNumber: integer("pr_number"),
    prState: text("pr_state", { enum: PR_STATES }),
    prChecks: text("pr_checks", { enum: PR_CHECKS }).notNull().default("none"),
    /** False when the branch conflicts with its base. Null until GitHub has worked it out. */
    prMergeable: boolean("pr_mergeable"),
    prAutoMerge: boolean("pr_auto_merge").notNull().default(false),
    /**
     * GitHub's `updated_at` for the pull request as last recorded. Webhooks arrive out of
     * order, so one older than this is not applied.
     */
    prUpdatedAt: instant("pr_updated_at"),
    /**
     * When the API began the read of GitHub that the pull request columns above come from. A
     * check finishing or mergeability being worked out leaves GitHub's `updated_at` alone, so
     * this is what keeps a slower, older read from being stored over a newer one.
     */
    prReadAt: instant("pr_read_at"),
    /**
     * The agent's words on what the branch changes, for the pull request's description. Kept
     * here until a pull request is opened, and written into its body whenever they change.
     */
    prSummary: text("pr_summary"),
    agentState: text("agent_state", { enum: AGENT_STATES }).notNull().default("idle"),
    /** One line: what the agent is doing. */
    agentStatus: text("agent_status"),
    /** The artboards the agent is on. */
    agentArtboards: text("agent_artboards").array().notNull().default(sql`'{}'::text[]`),
    /** Why the agent cannot run now, when something outside the canvas must change first. */
    agentBlocker: text("agent_blocker", { enum: AGENT_BLOCKERS }),
    /**
     * Until when the blocker holds, when a gate knows (a Claude plan's limit resets then).
     * Written with `agent_blocker`, and null whenever it is.
     */
    agentBlockedUntil: instant("agent_blocked_until"),
    /** How many questions are open. Kept in step by the question queries. */
    needsYouCount: integer("needs_you_count").notNull().default(0),
    lastActivityAt: instant("last_activity_at").notNull().defaultNow(),
    /**
     * The key its creator's app sent with the create, so that a create sent twice (a double
     * tap, a retry after a lost answer) makes one canvas.
     */
    createKey: text("create_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A canvas is in its repo's workspace: the pair is the key, so the two cannot disagree, and
    // a repo that moves to another workspace takes its canvases with it. Scratch has no repo and
    // is not checked.
    foreignKey({
      name: "canvases_repo_id_workspace_id_fk",
      columns: [t.repoId, t.workspaceId],
      foreignColumns: [repos.id, repos.workspaceId],
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
    index("canvases_workspace_id_status_idx").on(t.workspaceId, t.status),
    // One canvas, one branch. Also how a GitHub webhook finds the canvas for a pull request.
    uniqueIndex("canvases_repo_id_branch_key").on(t.repoId, t.branch),
    uniqueIndex("canvases_owner_id_create_key_key").on(t.ownerId, t.createKey),
    check("canvases_status_check", oneOf(t.status, CANVAS_STATUSES)),
    check(
      "canvases_settled_at_check",
      sql`(${t.status} = 'settled') = (${t.settledAt} is not null)`,
    ),
    check("canvases_seq_check", sql`${t.seq} >= 0`),
    check("canvases_pr_state_check", oneOf(t.prState, PR_STATES)),
    check("canvases_pr_number_check", sql`(${t.prNumber} is null) = (${t.prState} is null)`),
    check("canvases_pr_checks_check", oneOf(t.prChecks, PR_CHECKS)),
    check("canvases_agent_state_check", oneOf(t.agentState, AGENT_STATES)),
    check("canvases_agent_blocker_check", oneOf(t.agentBlocker, AGENT_BLOCKERS)),
    check("canvases_needs_you_count_check", sql`${t.needsYouCount} >= 0`),
  ],
);

/**
 * The ordered log of a canvas. `seq` counts from 1 with no gaps; `canvases.seq` is the last one.
 * `op` and `inverse` are `json`, not `jsonb`: a node's `style` and `attrs` are ordered, and
 * `jsonb` reorders keys.
 */
export const canvasOps = pgTable(
  "canvas_ops",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** The sender's id for the op. Posting it again returns this row. */
    clientOpId: text("client_op_id").notNull(),
    op: json("op").$type<Op>().notNull(),
    inverse: json("inverse").$type<Op>().notNull(),
    kind: text("kind", { enum: OP_KINDS }).notNull().default("do"),
    /** For an undo, the op it took back; for a redo, the undo it took back. */
    reversesSeq: bigint("reverses_seq", { mode: "number" }),
    /** Set on the op an undo or redo took back, so it is not taken back twice. */
    reversedBySeq: bigint("reversed_by_seq", { mode: "number" }),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    // Not a foreign key: an agent is not a user, and history outlives the people in it.
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    actorAvatarUrl: text("actor_avatar_url"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.seq] }),
    uniqueIndex("canvas_ops_canvas_id_client_op_id_key").on(t.canvasId, t.clientOpId),
    check("canvas_ops_seq_check", sql`${t.seq} > 0`),
    check("canvas_ops_kind_check", oneOf(t.kind, OP_KINDS)),
    check("canvas_ops_reverses_seq_check", sql`(${t.kind} = 'do') = (${t.reversesSeq} is null)`),
    check("canvas_ops_actor_kind_check", oneOf(t.actorKind, ACTOR_KINDS)),
  ],
);

/** The whole document as of `seq`. The current document is the latest one plus the ops after it. */
export const canvasCheckpoints = pgTable(
  "canvas_checkpoints",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    doc: json("doc").$type<Doc>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.seq] })],
);

/** How far one person has looked at one canvas: what the unseen dot compares against. */
export const canvasReads = pgTable(
  "canvas_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    /** The `canvases.seq` they have seen. */
    seenSeq: bigint("seen_seq", { mode: "number" }).notNull().default(0),
    /** The `thread_items.seq` they have seen. */
    seenThreadSeq: bigint("seen_thread_seq", { mode: "number" }).notNull().default(0),
    seenAt: instant("seen_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.canvasId] }),
    index("canvas_reads_canvas_id_idx").on(t.canvasId),
  ],
);

/** Who has a canvas open. One row per person per canvas, refreshed while it is open. */
export const presence = pgTable(
  "presence",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pageId: text("page_id"),
    joinedAt: instant("joined_at").notNull().defaultNow(),
    seenAt: instant("seen_at").notNull().defaultNow(),
    /**
     * When the person's window was last focused and showing this canvas, or null when it is
     * not. Nobody is pinged about a canvas they are looking at.
     */
    focusedAt: instant("focused_at"),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.userId] })],
);

/** A file a canvas uses. The bytes are in R2 under the canvas's asset key and this path. */
export const assets = pgTable(
  "assets",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    /** As nodes reference it, like `assets/logo.png`. */
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    /** Null when the agent uploaded it. */
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.path] }),
    check("assets_size_check", sql`${t.size} >= 0`),
  ],
);

/**
 * The agent thread: what people said, what the agent said, and the tool steps between.
 * `seq` orders it. It comes from one sequence shared by every canvas, so it has gaps.
 * An item is found by its canvas and its id, so an id a runner chose reaches its own canvas's
 * thread and nothing else.
 */
export const threadItems = pgTable(
  "thread_items",
  {
    /** Chosen by the writer, so the runner can post an item again without doubling it. */
    id: text("id").notNull(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: THREAD_ITEM_KINDS }).notNull(),
    /** The person who wrote it. Null for the agent and for Ponzu. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Json>().notNull(),
    /** True while the agent is still writing it. Only a streaming item can be updated. */
    streaming: boolean("streaming").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.id] }),
    index("thread_items_canvas_id_seq_idx").on(t.canvasId, t.seq),
    check("thread_items_kind_check", oneOf(t.kind, THREAD_ITEM_KINDS)),
    check("thread_items_payload_check", atMostBytes(t.payload, WATCHED_PAYLOAD_BYTES)),
  ],
);

/** The feed of things that happened to a canvas, for the agent to take up. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    priority: text("priority", { enum: EVENT_PRIORITIES }).notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    /** The person behind it. Null when GitHub was. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * The PostHog session of the app that sent it, when it said (docs/analytics.md): the turn
     * it starts is traced under that session, so a recording links to the agent's work.
     */
    posthogSessionId: text("posthog_session_id"),
    createdAt: createdAt(),
    /** When a runner last took it. */
    claimedAt: instant("claimed_at"),
    /**
     * The runner process (`canvas_runners.runner_id`) it was last handed to. It is handed to
     * each runner once: taken and not delivered, it is the next runner's.
     */
    claimedBy: text("claimed_by"),
    /**
     * The runner's id for the claim that handed it out (`clm_…`), so that a claim sent again
     * after its answer was lost hands out the same events.
     */
    claimId: text("claim_id"),
    /** When the runner said the Claude session holds it, by the API's clock. */
    deliveredAt: instant("delivered_at"),
    /**
     * When the API stopped waiting for the turn it was owed (docs/cloud.md, "A turn that never
     * came"): it was delivered and nothing the runner wrote followed, so the thread said so and,
     * once, the event was put in the feed again as a copy (`payload.retryOf`).
     */
    lapsedAt: instant("lapsed_at"),
  },
  (t) => [
    // What a claim reads.
    index("events_canvas_id_seq_pending_idx")
      .on(t.canvasId, t.seq)
      .where(sql`${t.deliveredAt} is null`),
    // What the sweep reads: what was delivered after the runner last wrote.
    index("events_canvas_id_delivered_at_idx").on(t.canvasId, t.deliveredAt),
    // Deleting a canvas deletes its events, delivered ones included.
    index("events_canvas_id_idx").on(t.canvasId),
    check("events_kind_check", oneOf(t.kind, EVENT_KINDS)),
    check("events_priority_check", oneOf(t.priority, EVENT_PRIORITIES)),
  ],
);

/**
 * Something the agent needs a person for: a question, a permission, a plan, a secret, a link.
 * The runner chooses the id, and a question is found by its canvas and its id.
 */
export const questions = pgTable(
  "questions",
  {
    id: text("id").notNull(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: QUESTION_KINDS }).notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    status: text("status", { enum: QUESTION_STATUSES }).notNull().default("open"),
    answer: jsonb("answer").$type<Json>(),
    answeredByUserId: text("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    answeredAt: instant("answered_at"),
    /**
     * For a `secret` question: when its value went to the runner of the turn that asked for it
     * (`POST /v1/runner/secret`). It goes once; null until then, and for every other kind.
     */
    deliveredAt: instant("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.id] }),
    index("questions_canvas_id_status_idx").on(t.canvasId, t.status),
    check("questions_kind_check", oneOf(t.kind, QUESTION_KINDS)),
    check("questions_status_check", oneOf(t.status, QUESTION_STATUSES)),
    check("questions_answer_check", sql`(${t.status} = 'answered') = (${t.answer} is not null)`),
    // This row is plaintext and clients watch it. A secret's answer says which secret was
    // given and nothing else; the value goes to `repo_secrets`, encrypted.
    check(
      "questions_secret_answer_check",
      sql`${t.kind} <> 'secret' or ${t.answer} is null or (jsonb_typeof(${t.answer} -> 'name') = 'string' and ${t.answer} - 'name' = '{}'::jsonb)`,
    ),
    check("questions_payload_check", atMostBytes(t.payload, WATCHED_PAYLOAD_BYTES)),
  ],
);

/**
 * A canvas's sandbox, and where it is in its life (docs/cloud.md, "The sandbox"). At most one
 * per canvas: the sandbox at Vercel is named for the canvas (`pz-<scope>-<canvasId>`), so the
 * row needs no id of its own, and no row means no sandbox. Every call to Vercel after the wake's
 * `up()` is pinned to `session_id`, so a session that ended is never resumed by accident. Every
 * move between states is a statement that holds to the state it moves from (and, for a row held
 * by a job, to `waking_by`), so two function instances racing on one sandbox cannot both make it.
 */
export const sandboxes = pgTable(
  "sandboxes",
  {
    canvasId: text("canvas_id")
      .primaryKey()
      .references(() => canvases.id, { onDelete: "cascade" }),
    state: text("state", { enum: SANDBOX_STATES }).notNull(),
    /** When it entered its state: how a row a crashed function left mid-move is found. */
    stateAt: instant("state_at").notNull().defaultNow(),
    /**
     * The job holding a `waking` or `stopping` row (its id; `retire:<job>` while a retire holds
     * it). Only that job moves it on, until it has sat unmoved for a lease (`WAKING_LEASE_MS`).
     */
    wakingBy: text("waking_by"),
    /** Why the last wake gave up. The row is asleep and the canvas shows `sandbox_failed`. */
    failure: text("failure"),
    /** The Vercel session the row holds. Every call is pinned to it. */
    sessionId: text("session_id"),
    /**
     * That session's start, which a restart in place keeps: what the 23.5-hour cycle and the
     * clamp on extending it count from.
     */
    sessionStartedAt: instant("session_started_at"),
    /** `https://<sub>.vercel.run`: the runner's port. */
    address: text("address"),
    /** The bearer of that port, new at every start, sealed (`sandboxes.encrypted_port_token`). */
    encryptedPortToken: text("encrypted_port_token"),
    /** The running session's deadline at Vercel, as last set. */
    expiresAt: instant("expires_at"),
    /**
     * The image the sandbox runs (`current.json`'s `image`). A wake on another one recreates it,
     * unless the canvas's last checkpoint is behind (docs/cloud.md, "How images roll out").
     */
    image: text("image"),
    /** The runner token the running runner was started with. */
    runnerTokenId: text("runner_token_id").references(() => runnerTokens.id, {
      onDelete: "set null",
    }),
    /**
     * Which Claude credential the running runner was started with: the account and when it was
     * connected. A wake that finds the owner's credential changed restarts it in place.
     */
    claudeCredential: text("claude_credential"),
    /** Set while it is awake. Awake time is metered from here when it next leaves `awake`. */
    awakeSince: instant("awake_since"),
    /** Who its awake time is put down to: the person who woke it or last kept it awake. */
    awakeUserId: text("awake_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The last time a person or a working agent kept it awake. Idle is counted from here. */
    lastActivityAt: instant("last_activity_at").notNull().defaultNow(),
    /** How often its runner was found dead and restarted since one was last heard from. */
    restarts: integer("restarts").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // What the idle sweep reads.
    index("sandboxes_awake_last_activity_at_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.state} = 'awake'`),
    check("sandboxes_state_check", oneOf(t.state, SANDBOX_STATES)),
    check(
      "sandboxes_awake_since_check",
      sql`(${t.state} = 'awake') = (${t.awakeSince} is not null)`,
    ),
  ],
);

/** What a runner signs in with. Good for one canvas; only a hash of it is stored. */
export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    revokedAt: instant("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("runner_tokens_canvas_id_idx").on(t.canvasId)],
);

/**
 * The runner a canvas has now: its lease and when it was last heard from. One row per canvas,
 * apart from `canvases` so that a heartbeat every 30 seconds does not touch the row clients
 * watch. The Claude session is kept here because it is the canvas's: a runner that starts
 * again, in this sandbox or a new one, resumes the session the canvas's events went into.
 */
export const canvasRunners = pgTable("canvas_runners", {
  canvasId: text("canvas_id")
    .primaryKey()
    .references(() => canvases.id, { onDelete: "cascade" }),
  /**
   * The lease, `rnr_…`: the one runner process the API takes calls from. Each new session
   * replaces it, and a call that carries any other is refused.
   */
  runnerId: text("runner_id").notNull(),
  startedAt: instant("started_at").notNull(),
  /**
   * What the runner holding the lease said it is as it took it (`X-Ponzu-Client`: its version,
   * and the bundle it runs, as in `runner/0.1.0+2de5aff8d903`). Null for a runner that did not
   * say.
   */
  client: text("client"),
  /** When the runner last took the lease or reported its state. */
  heardAt: instant("heard_at").notNull(),
  /**
   * When a runner last wrote something of a turn to the thread (the agent's text, a turn's work,
   * a question, a stop, an error), by the API's clock. An event delivered after it has had no
   * answer yet: the sweep keeps the sandbox awake for it, and lapses it when none comes.
   */
  saidAt: instant("said_at"),
  /** The Claude session the next runner resumes, as an ack or a state report last named it. */
  claudeSessionId: text("claude_session_id"),
  /**
   * The runner's last checkpoint (docs/cloud.md, "Saving the sandbox"): its turn marker, which
   * only goes up, when it was recorded, the Claude session its transcript is of, the commit of
   * work in progress it pushed to `refs/ponzu/wip/<canvas>` (a repo canvas), and the uploads
   * holding the transcript and a Scratch canvas's files. A runner whose disk is behind this
   * restores from it.
   */
  savedTurn: integer("saved_turn"),
  savedAt: instant("saved_at"),
  savedClaudeSessionId: text("saved_claude_session_id"),
  savedWipCommit: text("saved_wip_commit"),
  sessionUploadId: text("session_upload_id"),
  workspaceUploadId: text("workspace_upload_id"),
  /**
   * The newest of the canvas's events that had gone into its session (`events.seq`, delivered)
   * when the last checkpoint was recorded. An event delivered after it is work the checkpoint may
   * not hold, so the canvas is not moved onto a new sandbox until a later checkpoint covers it.
   */
  savedThrough: bigint("saved_through", { mode: "number" }),
  /**
   * The canvas's branch in the sandbox against GitHub, as the runner last said: commits GitHub
   * lacks, and why the last push of them failed. Create PR goes by it while GitHub lacks them.
   */
  unpushed: integer("unpushed").notNull().default(0),
  pushError: text("push_error"),
});

/**
 * Bytes on their way to storage: a signed address was handed out for exactly these, and the
 * file is recorded where it belongs (an asset, the canvas's previews) once it is completed.
 */
export const uploads = pgTable(
  "uploads",
  {
    id: text("id").notNull(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: UPLOAD_PURPOSES }).notNull(),
    /** The file name it was asked for under, with its extension. */
    name: text("name").notNull(),
    /** Where the signed address puts the bytes, from the bucket's root. */
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Hex. */
    sha256: text("sha256").notNull(),
    /** The person who asked for it. Null for the runner. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: instant("expires_at").notNull(),
    /** Where it is served from, set once the bytes were found and recorded. */
    servedKey: text("served_key"),
    completedAt: instant("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.id] }),
    check("uploads_purpose_check", oneOf(t.purpose, UPLOAD_PURPOSES)),
    check("uploads_size_check", sql`${t.size} >= 0`),
    check("uploads_completed_check", sql`(${t.completedAt} is null) = (${t.servedKey} is null)`),
  ],
);
