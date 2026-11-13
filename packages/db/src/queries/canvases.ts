import { type Doc, docSearchEntries, SEARCH_VERSION } from "@ponzu/core";
import { and, desc, eq, getTableColumns, isNull, or, sql, type WithSubquery } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { CanvasHead } from "../head.ts";
import { newAssetKey, newId } from "../ids.ts";
import {
  type CanvasStatus,
  canvasCheckpoints,
  canvases,
  canvasReads,
  events,
  type Json,
  memberships,
  type RepoPermission,
  repoAccess,
  repos,
  searchState,
  threadItems,
  workspaces,
} from "../schema/index.ts";
import type { Repo } from "./accounts.ts";
import { eventRow } from "./events.ts";
import { timeParam } from "./json.ts";
import { readableCanvases } from "./readable.ts";
import { run } from "./run.ts";
import { insertMessageRow, type MessageSearch, toSearchRows, upsertSearchRows } from "./search.ts";
import { isStorable, scrubbed, unstorableDocument } from "./text.ts";

// Whoever knows a canvas's asset key can read its files, so no query hands it back with the
// rest of the row. It has to be asked for by name: `getCanvasAssetKey`.
const { assetKey: _assetKey, ...columns } = getTableColumns(canvases);

export type Canvas = Omit<typeof canvases.$inferSelect, "assetKey">;

export interface NewCanvas {
  workspaceId: string;
  /** Null for Scratch. Otherwise a repo of this workspace; any other is refused. */
  repoId: string | null;
  ownerId: string;
  claudeAccountId: string | null;
  name: string;
  icon?: string | null;
  branch: string | null;
  model?: string | null;
  effort?: string | null;
  /** The document it starts as. */
  doc: Doc;
  /** The creator's key for this create: another create with it by the same owner is refused. */
  createKey?: string | null;
  /**
   * What its owner says first, as a message: its thread item and its event, and the PostHog
   * session of the app that sent it, if it said.
   */
  firstMessage?: {
    item: Json;
    event: Json;
    posthogSessionId?: string | null;
    /** The message as search finds it, indexed with it. Not indexed when left out. */
    search?: MessageSearch;
  };
}

/** The unique index a create with a key already used breaks. */
export const CREATE_KEY_TAKEN = "canvases_owner_id_create_key_key";
/** The unique index a branch already taken in the repo breaks. */
export const BRANCH_TAKEN = "canvases_repo_id_branch_key";

/**
 * Create a canvas and its first checkpoint, at seq 0, in one statement, with its first message
 * in the thread and the feed when it has one. Every canvas has a checkpoint from then on, which
 * is what `readDocSource` relies on. A `createKey` or a branch already taken fails the whole
 * statement with a `QueryError` naming `CREATE_KEY_TAKEN` or `BRANCH_TAKEN`.
 *
 * The same statement indexes it for search: the document's entries, the first message's (when
 * it says what to index), and `search_state` at the current `SEARCH_VERSION` and seq 0, so the
 * backfill never needs to visit it.
 */
export async function createCanvas(
  db: Db,
  { doc, firstMessage, ...values }: NewCanvas,
): Promise<Canvas> {
  if (!isStorable(doc)) throw unstorableDocument();
  const id = newId("cnv");
  const indexed: WithSubquery[] = [
    db
      .$with("indexed_state")
      .as(
        db
          .insert(searchState)
          .values({ canvasId: id, version: SEARCH_VERSION, indexedSeq: 0, indexedAt: sql`now()` })
          .returning({ canvasId: searchState.canvasId }),
      ),
  ];
  const rows = toSearchRows(docSearchEntries(doc));
  if (rows.length > 0) {
    indexed.push(
      db
        .$with("indexed_doc", { canvasId: sql<string>`canvas_id` })
        .as(sql`${upsertSearchRows(id, JSON.stringify(rows), sql`true`)} returning canvas_id`),
    );
  }
  const checkpoint = db
    .$with("checkpoint")
    .as(
      db
        .insert(canvasCheckpoints)
        .values({ canvasId: id, seq: 0, doc })
        .returning({ seq: canvasCheckpoints.seq }),
    );
  // Postgres runs a data-modifying `with` whether or not the statement reads it.
  const said = firstMessage && [
    db.$with("queued").as(
      db
        .insert(events)
        .values({
          canvasId: id,
          ...eventRow({
            kind: "message",
            priority: "now",
            payload: firstMessage.event,
            userId: values.ownerId,
            posthogSessionId: firstMessage.posthogSessionId ?? null,
          }),
        })
        .returning({ id: events.id }),
    ),
    db.$with("said").as(
      db
        .insert(threadItems)
        .values({
          id: newId("ti"),
          canvasId: id,
          kind: "message",
          userId: values.ownerId,
          payload: scrubbed(firstMessage.item),
        })
        .returning({
          id: threadItems.id,
          seq: threadItems.seq,
          createdAt: threadItems.createdAt,
        }),
    ),
  ];
  const message = firstMessage?.search && insertMessageRow(id, firstMessage.search, "said");
  if (said && message) {
    indexed.push(
      db
        .$with("indexed_message", { canvasId: sql<string>`canvas_id` })
        .as(sql`${message} returning canvas_id`),
    );
  }
  const [canvas] = await run(
    db
      .with(checkpoint, ...(said ?? []), ...indexed)
      .insert(canvases)
      // 160 random bits: the key is all that guards the canvas's files.
      .values({ ...values, id, assetKey: newAssetKey() })
      .returning(columns),
  );
  return canvas!;
}

/** The canvas an owner already created under `createKey`, if any. */
export async function findCanvasByCreateKey(
  db: Db,
  { ownerId, createKey }: { ownerId: string; createKey: string },
): Promise<Canvas | null> {
  const [row] = await run(
    db
      .select(columns)
      .from(canvases)
      .where(and(eq(canvases.ownerId, ownerId), eq(canvases.createKey, createKey))),
  );
  return row ?? null;
}

/** The branches of a repo's canvases that are `prefix` or start with `prefix-`. */
export async function listRepoBranches(
  db: Db,
  { repoId, prefix }: { repoId: string; prefix: string },
): Promise<string[]> {
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`;
  const rows = await run(
    db
      .select({ branch: canvases.branch })
      .from(canvases)
      .where(
        and(
          eq(canvases.repoId, repoId),
          or(eq(canvases.branch, prefix), sql`${canvases.branch} like ${like}`),
        ),
      ),
  );
  return rows.flatMap((row) => (row.branch ? [row.branch] : []));
}

// `CanvasHead` and the column list a live query selects are in ../head.ts, where a client can
// import them. A test holds the three in step.
export const head = {
  id: canvases.id,
  workspaceId: canvases.workspaceId,
  name: canvases.name,
  icon: canvases.icon,
  status: canvases.status,
  seq: canvases.seq,
  previewSeq: canvases.previewSeq,
  agentState: canvases.agentState,
  agentStatus: canvases.agentStatus,
  agentArtboards: canvases.agentArtboards,
  needsYouCount: canvases.needsYouCount,
  prNumber: canvases.prNumber,
  prState: canvases.prState,
  prChecks: canvases.prChecks,
  prMergeable: canvases.prMergeable,
  prAutoMerge: canvases.prAutoMerge,
  prLinkedCount: canvases.prLinkedCount,
  prLinkedOpen: canvases.prLinkedOpen,
  lastActivityAt: canvases.lastActivityAt,
  assetKeyRotatedAt: canvases.assetKeyRotatedAt,
  driver: canvases.driver,
};

export async function getCanvasHead(db: Db, canvasId: string): Promise<CanvasHead | null> {
  const [row] = await run(db.select(head).from(canvases).where(eq(canvases.id, canvasId)));
  return row ?? null;
}

/** A canvas's row, without its asset key. */
export async function getCanvas(db: Db, canvasId: string): Promise<Canvas | null> {
  const [row] = await run(db.select(columns).from(canvases).where(eq(canvases.id, canvasId)));
  return row ?? null;
}

/** What deciding who may open a canvas takes: the canvas, its repo, and where to ask GitHub. */
export interface CanvasAccess {
  canvas: Canvas;
  /** The repo whose access decides who may open it. Null for Scratch. */
  repo: { id: string; githubRepoId: number; fullName: string } | null;
  /** The App's installation on the canvas's workspace. Null while the App is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace, when nobody can reach its repos. */
  suspendedAt: Date | null;
  /** What GitHub last said the person asking may do in the repo, if it was ever asked. */
  known: { permission: RepoPermission; checkedAt: Date } | null;
  /**
   * Whether the person asking is a member of the canvas's workspace. Nobody else may open it,
   * whatever `known` says: an answer is only ever about a member (see `repo_access`).
   */
  member: boolean;
}

/**
 * A canvas with what deciding whether `userId` may open it takes, or null when there is no
 * such canvas. Pass null for a caller who is not a person.
 */
export async function getCanvasAccess(
  db: Db,
  { canvasId, userId }: { canvasId: string; userId: string | null },
): Promise<CanvasAccess | null> {
  const [row] = await run(
    db
      .select({
        canvas: columns,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
        permission: repoAccess.permission,
        checkedAt: repoAccess.checkedAt,
        member: sql<boolean>`${memberships.userId} is not null`.mapWith(Boolean),
      })
      .from(canvases)
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .leftJoin(
        memberships,
        and(
          eq(memberships.workspaceId, canvases.workspaceId),
          userId === null ? sql`false` : eq(memberships.userId, userId),
        ),
      )
      .leftJoin(repos, eq(repos.id, canvases.repoId))
      .leftJoin(
        repoAccess,
        and(
          eq(repoAccess.repoId, canvases.repoId),
          userId === null ? sql`false` : eq(repoAccess.userId, userId),
        ),
      )
      .where(eq(canvases.id, canvasId)),
  );
  if (!row) return null;
  const { canvas, githubRepoId, fullName, installationId, suspendedAt, permission, checkedAt } =
    row;
  const { member } = row;
  return {
    canvas,
    repo:
      canvas.repoId === null || githubRepoId === null || fullName === null
        ? null
        : { id: canvas.repoId, githubRepoId, fullName },
    installationId,
    suspendedAt,
    known: permission === null || checkedAt === null ? null : { permission, checkedAt },
    member,
  };
}

/** A repo of this workspace that the App can still see, or null. */
export async function getWorkspaceRepo(
  db: Db,
  { workspaceId, repoId }: { workspaceId: string; repoId: string },
): Promise<Repo | null> {
  const [repo] = await run(
    db
      .select()
      .from(repos)
      .where(
        and(eq(repos.id, repoId), eq(repos.workspaceId, workspaceId), isNull(repos.removedAt)),
      ),
  );
  return repo ?? null;
}

/**
 * Settle a canvas (as of `now`) or reopen it. Null when there is no such canvas. Its name and
 * icon are the document's, and change by op.
 */
export async function settleCanvas(
  db: Db,
  canvasId: string,
  { settled, now }: { settled: boolean; now: Date },
): Promise<Canvas | null> {
  const [canvas] = await run(
    db
      .update(canvases)
      .set(
        settled
          ? {
              status: "settled",
              // Settling a settled canvas keeps the time it first settled.
              settledAt: sql`coalesce(${canvases.settledAt}, ${timeParam(now)}::timestamptz)`,
            }
          : { status: "active", settledAt: null },
      )
      .where(eq(canvases.id, canvasId))
      .returning(columns),
  );
  return canvas ?? null;
}

/** Delete a canvas and everything that is only its own (see the README). False if there was none. */
export async function deleteCanvas(db: Db, canvasId: string): Promise<boolean> {
  const deleted = await run(
    db.delete(canvases).where(eq(canvases.id, canvasId)).returning({ id: canvases.id }),
  );
  return deleted.length > 0;
}

/**
 * The path segment a canvas's files are served under. Knowing it is the permission to read
 * them, so give it only to someone who may open the canvas.
 */
export async function getCanvasAssetKey(db: Db, canvasId: string): Promise<string | null> {
  const [row] = await run(
    db.select({ assetKey: canvases.assetKey }).from(canvases).where(eq(canvases.id, canvasId)),
  );
  return row?.assetKey ?? null;
}

/** A canvas as a list shows it to one person. */
export interface CanvasListItem extends CanvasHead {
  /** Null for Scratch. */
  repoId: string | null;
  /** `owner/name`. Null for Scratch. */
  repoFullName: string | null;
  ownerId: string | null;
  branch: string | null;
  settledAt: Date | null;
  createdAt: Date;
  /** How far this person has looked. Null when they have never opened it. */
  seenSeq: number | null;
  seenThreadSeq: number | null;
}

/**
 * A workspace's canvases, most recently active first, with how far `userId` has looked at each:
 * those `readableCanvases` lets them read (their own Scratch canvases, and those in a repo
 * `repo_access` says they can read, while they are a member). Search uses the same rule. That
 * those answers are recent is the caller's to make sure of.
 */
export function listWorkspaceCanvases(
  db: Db,
  { workspaceId, userId, status }: { workspaceId: string; userId: string; status?: CanvasStatus },
): Promise<CanvasListItem[]> {
  return run(
    db
      .select({
        ...head,
        repoId: canvases.repoId,
        repoFullName: repos.fullName,
        ownerId: canvases.ownerId,
        branch: canvases.branch,
        settledAt: canvases.settledAt,
        createdAt: canvases.createdAt,
        seenSeq: canvasReads.seenSeq,
        seenThreadSeq: canvasReads.seenThreadSeq,
      })
      .from(canvases)
      .leftJoin(repos, eq(repos.id, canvases.repoId))
      .leftJoin(
        canvasReads,
        and(eq(canvasReads.canvasId, canvases.id), eq(canvasReads.userId, userId)),
      )
      .where(
        and(
          readableCanvases({ workspaceId, userId }),
          status ? eq(canvases.status, status) : undefined,
        ),
      )
      .orderBy(desc(canvases.lastActivityAt), canvases.id),
  );
}

/**
 * Record how far a person has looked at a canvas. It only moves forward, so a slow request
 * from one device cannot bring back a dot another device cleared, and never past the canvas's
 * seq or its newest thread item: nobody has seen what is not there yet, and a number from
 * further on would hide the dot for good.
 */
export async function markCanvasSeen(
  db: Db,
  {
    userId,
    canvasId,
    seq = 0,
    threadSeq = 0,
  }: { userId: string; canvasId: string; seq?: number; threadSeq?: number },
): Promise<void> {
  const newestSeq = db
    .select({ seq: canvases.seq })
    .from(canvases)
    .where(eq(canvases.id, canvasId));
  const newestThreadSeq = db
    .select({ seq: sql`coalesce(max(${threadItems.seq}), 0)` })
    .from(threadItems)
    .where(eq(threadItems.canvasId, canvasId));
  await run(
    db
      .insert(canvasReads)
      .values({
        userId,
        canvasId,
        seenSeq: sql`least(${seq}::bigint, (${newestSeq}))`,
        seenThreadSeq: sql`least(${threadSeq}::bigint, (${newestThreadSeq}))`,
      })
      .onConflictDoUpdate({
        target: [canvasReads.userId, canvasReads.canvasId],
        set: {
          seenSeq: sql`greatest(${canvasReads.seenSeq}, excluded.seen_seq)`,
          seenThreadSeq: sql`greatest(${canvasReads.seenThreadSeq}, excluded.seen_thread_seq)`,
          seenAt: sql`now()`,
        },
      }),
  );
}
