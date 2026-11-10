import type { Doc, Op } from "@ponzu/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  AGENT_STATES,
  DESIGN_STATUSES,
  EVENT_KINDS,
  EVENT_PRIORITIES,
  OP_KINDS,
  PR_CHECKS,
  PR_STATES,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  SANDBOX_PROVIDERS,
  SANDBOX_STATES,
  THREAD_ITEM_KINDS,
} from "../enums.ts";
import { claudeAccounts, repos, users, workspaces } from "./accounts.ts";
import { atMostBytes, createdAt, instant, type Json, oneOf, updatedAt } from "./columns.ts";

/** The most a row the sandbox writes and clients watch may carry in one json value. */
const WATCHED_PAYLOAD_BYTES = 256 * 1024;

/**
 * One design. The row is small on purpose: clients watch it live, so its content lives in
 * `design_ops` and `design_checkpoints` and only the pointer to it (`seq`) lives here.
 */
export const designs = pgTable(
  "designs",
  {
    id: text("id").primaryKey(),
    // A workspace with designs cannot be deleted from under them; delete the designs first.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** Null for Scratch. A repo the App lost is marked removed, never deleted, so this holds. */
    repoId: text("repo_id"),
    // A design belongs to its workspace and outlives the person who started it.
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
    status: text("status", { enum: DESIGN_STATUSES }).notNull().default("active"),
    settledAt: instant("settled_at"),
    /** The seq of the last committed op: the version of the document. */
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    /** The path segment its files are served under. Knowing it is the permission to read them. */
    assetKey: text("asset_key").notNull().unique(),
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
    agentState: text("agent_state", { enum: AGENT_STATES }).notNull().default("idle"),
    /** One line: what the agent is doing. */
    agentStatus: text("agent_status"),
    /** The artboards the agent is on. */
    agentArtboards: text("agent_artboards").array().notNull().default(sql`'{}'::text[]`),
    /** How many questions are open. Kept in step by the question queries. */
    needsYouCount: integer("needs_you_count").notNull().default(0),
    lastActivityAt: instant("last_activity_at").notNull().defaultNow(),
    /** The sandbox it has now, if any. */
    sandboxId: text("sandbox_id").references((): AnyPgColumn => sandboxes.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A design is in its repo's workspace: the pair is the key, so the two cannot disagree, and
    // a repo that moves to another workspace takes its designs with it. Scratch has no repo and
    // is not checked.
    foreignKey({
      name: "designs_repo_id_workspace_id_fk",
      columns: [t.repoId, t.workspaceId],
      foreignColumns: [repos.id, repos.workspaceId],
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
    index("designs_workspace_id_status_idx").on(t.workspaceId, t.status),
    // One design, one branch. Also how a GitHub webhook finds the design for a pull request.
    uniqueIndex("designs_repo_id_branch_key").on(t.repoId, t.branch),
    // Deleting a sandbox clears the designs that point at it.
    index("designs_sandbox_id_idx").on(t.sandboxId),
    check("designs_status_check", oneOf(t.status, DESIGN_STATUSES)),
    check(
      "designs_settled_at_check",
      sql`(${t.status} = 'settled') = (${t.settledAt} is not null)`,
    ),
    check("designs_seq_check", sql`${t.seq} >= 0`),
    check("designs_pr_state_check", oneOf(t.prState, PR_STATES)),
    check("designs_pr_number_check", sql`(${t.prNumber} is null) = (${t.prState} is null)`),
    check("designs_pr_checks_check", oneOf(t.prChecks, PR_CHECKS)),
    check("designs_agent_state_check", oneOf(t.agentState, AGENT_STATES)),
    check("designs_needs_you_count_check", sql`${t.needsYouCount} >= 0`),
  ],
);

/**
 * The ordered log of a design. `seq` counts from 1 with no gaps; `designs.seq` is the last one.
 * `op` and `inverse` are `json`, not `jsonb`: a node's `style` and `attrs` are ordered, and
 * `jsonb` reorders keys.
 */
export const designOps = pgTable(
  "design_ops",
  {
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [t.designId, t.seq] }),
    uniqueIndex("design_ops_design_id_client_op_id_key").on(t.designId, t.clientOpId),
    check("design_ops_seq_check", sql`${t.seq} > 0`),
    check("design_ops_kind_check", oneOf(t.kind, OP_KINDS)),
    check("design_ops_reverses_seq_check", sql`(${t.kind} = 'do') = (${t.reversesSeq} is null)`),
    check("design_ops_actor_kind_check", oneOf(t.actorKind, ACTOR_KINDS)),
  ],
);

/** The whole document as of `seq`. The current document is the latest one plus the ops after it. */
export const designCheckpoints = pgTable(
  "design_checkpoints",
  {
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    doc: json("doc").$type<Doc>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.designId, t.seq] })],
);

/** How far one person has looked at one design: what the unseen dot compares against. */
export const designReads = pgTable(
  "design_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    /** The `designs.seq` they have seen. */
    seenSeq: bigint("seen_seq", { mode: "number" }).notNull().default(0),
    /** The `thread_items.seq` they have seen. */
    seenThreadSeq: bigint("seen_thread_seq", { mode: "number" }).notNull().default(0),
    seenAt: instant("seen_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.designId] }),
    index("design_reads_design_id_idx").on(t.designId),
  ],
);

/** Who has a design open. One row per person per design, refreshed while it is open. */
export const presence = pgTable(
  "presence",
  {
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pageId: text("page_id"),
    joinedAt: instant("joined_at").notNull().defaultNow(),
    seenAt: instant("seen_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.designId, t.userId] })],
);

/** A file a design uses. The bytes are in R2 under the design's asset key and this path. */
export const assets = pgTable(
  "assets",
  {
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [t.designId, t.path] }),
    check("assets_size_check", sql`${t.size} >= 0`),
  ],
);

/**
 * The agent thread: what people said, what the agent said, and the tool steps between.
 * `seq` orders it. It comes from one sequence shared by every design, so it has gaps.
 */
export const threadItems = pgTable(
  "thread_items",
  {
    /** Chosen by the writer, so the runner can post an item again without doubling it. */
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
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
    index("thread_items_design_id_seq_idx").on(t.designId, t.seq),
    check("thread_items_kind_check", oneOf(t.kind, THREAD_ITEM_KINDS)),
    check("thread_items_payload_check", atMostBytes(t.payload, WATCHED_PAYLOAD_BYTES)),
  ],
);

/** The feed of things that happened to a design, for the agent to take up. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    priority: text("priority", { enum: EVENT_PRIORITIES }).notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    /** The person behind it. Null when GitHub was. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** When a runner last took it. Taken and not delivered, it can be taken again. */
    claimedAt: instant("claimed_at"),
    deliveredAt: instant("delivered_at"),
  },
  (t) => [
    // What a claim reads.
    index("events_design_id_seq_pending_idx")
      .on(t.designId, t.seq)
      .where(sql`${t.deliveredAt} is null`),
    // Deleting a design deletes its events, delivered ones included.
    index("events_design_id_idx").on(t.designId),
    check("events_kind_check", oneOf(t.kind, EVENT_KINDS)),
    check("events_priority_check", oneOf(t.priority, EVENT_PRIORITIES)),
  ],
);

/** Something the agent needs a person for: a question, a permission, a plan, a secret, a link. */
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: QUESTION_KINDS }).notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    status: text("status", { enum: QUESTION_STATUSES }).notNull().default("open"),
    answer: jsonb("answer").$type<Json>(),
    answeredByUserId: text("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    answeredAt: instant("answered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("questions_design_id_status_idx").on(t.designId, t.status),
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

/** A sandbox a design has or had. A lost one is marked gone and a new row replaces it. */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: SANDBOX_PROVIDERS }).notNull(),
    providerId: text("provider_id").notNull(),
    state: text("state", { enum: SANDBOX_STATES }).notNull().default("starting"),
    /** Where the API reaches the runner. */
    address: text("address"),
    encryptedAddressToken: text("encrypted_address_token"),
    /** Set while it is awake. Awake time is billed from here when it next sleeps. */
    awakeSince: instant("awake_since"),
    lastActivityAt: instant("last_activity_at").notNull().defaultNow(),
    /** The Claude session to resume. */
    claudeSessionId: text("claude_session_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sandboxes_provider_provider_id_key").on(t.provider, t.providerId),
    // One design owns one sandbox.
    uniqueIndex("sandboxes_design_id_live_key").on(t.designId).where(sql`${t.state} <> 'gone'`),
    // Deleting a design deletes its sandboxes, gone ones included.
    index("sandboxes_design_id_idx").on(t.designId),
    // What the idle sweep reads.
    index("sandboxes_awake_last_activity_at_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.state} = 'awake'`),
    check("sandboxes_provider_check", oneOf(t.provider, SANDBOX_PROVIDERS)),
    check("sandboxes_state_check", oneOf(t.state, SANDBOX_STATES)),
    check(
      "sandboxes_awake_since_check",
      sql`(${t.state} = 'awake') = (${t.awakeSince} is not null)`,
    ),
  ],
);

/** What a runner signs in with. Good for one design; only a hash of it is stored. */
export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: text("id").primaryKey(),
    designId: text("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    revokedAt: instant("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("runner_tokens_design_id_idx").on(t.designId)],
);
