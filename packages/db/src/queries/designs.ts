import type { Doc } from "@ponzu/core";
import { and, desc, eq, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { DesignHead } from "../head.ts";
import { newId, randomString } from "../ids.ts";
import {
  type DesignStatus,
  designCheckpoints,
  designReads,
  designs,
  events,
  type Json,
  memberships,
  type RepoPermission,
  repoAccess,
  repos,
  threadItems,
  workspaces,
} from "../schema/index.ts";
import type { Repo } from "./accounts.ts";
import { eventRow } from "./events.ts";
import { timeParam } from "./json.ts";
import { READABLE_PERMISSIONS } from "./repo-access.ts";
import { run } from "./run.ts";
import { isStorable, scrubbed, unstorableDocument } from "./text.ts";

// Whoever knows a design's asset key can read its files, so no query hands it back with the
// rest of the row. It has to be asked for by name: `getDesignAssetKey`.
const { assetKey: _assetKey, ...columns } = getTableColumns(designs);

export type Design = Omit<typeof designs.$inferSelect, "assetKey">;

export interface NewDesign {
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
  firstMessage?: { item: Json; event: Json; posthogSessionId?: string | null };
}

/** The unique index a create with a key already used breaks. */
export const CREATE_KEY_TAKEN = "designs_owner_id_create_key_key";
/** The unique index a branch already taken in the repo breaks. */
export const BRANCH_TAKEN = "designs_repo_id_branch_key";

/**
 * Create a design and its first checkpoint, at seq 0, in one statement, with its first message
 * in the thread and the feed when it has one. Every design has a checkpoint from then on, which
 * is what `readDocSource` relies on. A `createKey` or a branch already taken fails the whole
 * statement with a `QueryError` naming `CREATE_KEY_TAKEN` or `BRANCH_TAKEN`.
 */
export async function createDesign(
  db: Db,
  { doc, firstMessage, ...values }: NewDesign,
): Promise<Design> {
  if (!isStorable(doc)) throw unstorableDocument();
  const id = newId("des");
  const checkpoint = db
    .$with("checkpoint")
    .as(
      db
        .insert(designCheckpoints)
        .values({ designId: id, seq: 0, doc })
        .returning({ seq: designCheckpoints.seq }),
    );
  // Postgres runs a data-modifying `with` whether or not the statement reads it.
  const said = firstMessage && [
    db.$with("queued").as(
      db
        .insert(events)
        .values({
          designId: id,
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
          designId: id,
          kind: "message",
          userId: values.ownerId,
          payload: scrubbed(firstMessage.item),
        })
        .returning({ id: threadItems.id }),
    ),
  ];
  const [design] = await run(
    db
      .with(checkpoint, ...(said ?? []))
      .insert(designs)
      // 160 random bits: the key is all that guards the design's files.
      .values({ ...values, id, assetKey: randomString(32) })
      .returning(columns),
  );
  return design!;
}

/** The design an owner already created under `createKey`, if any. */
export async function findDesignByCreateKey(
  db: Db,
  { ownerId, createKey }: { ownerId: string; createKey: string },
): Promise<Design | null> {
  const [row] = await run(
    db
      .select(columns)
      .from(designs)
      .where(and(eq(designs.ownerId, ownerId), eq(designs.createKey, createKey))),
  );
  return row ?? null;
}

/** The branches of a repo's designs that are `prefix` or start with `prefix-`. */
export async function listRepoBranches(
  db: Db,
  { repoId, prefix }: { repoId: string; prefix: string },
): Promise<string[]> {
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`;
  const rows = await run(
    db
      .select({ branch: designs.branch })
      .from(designs)
      .where(
        and(
          eq(designs.repoId, repoId),
          or(eq(designs.branch, prefix), sql`${designs.branch} like ${like}`),
        ),
      ),
  );
  return rows.flatMap((row) => (row.branch ? [row.branch] : []));
}

// `DesignHead` and the column list a live query selects are in ../head.ts, where a client can
// import them. A test holds the three in step.
export const head = {
  id: designs.id,
  workspaceId: designs.workspaceId,
  name: designs.name,
  icon: designs.icon,
  status: designs.status,
  seq: designs.seq,
  previewSeq: designs.previewSeq,
  agentState: designs.agentState,
  agentStatus: designs.agentStatus,
  agentArtboards: designs.agentArtboards,
  needsYouCount: designs.needsYouCount,
  prNumber: designs.prNumber,
  prState: designs.prState,
  prChecks: designs.prChecks,
  prMergeable: designs.prMergeable,
  prAutoMerge: designs.prAutoMerge,
  lastActivityAt: designs.lastActivityAt,
};

export async function getDesignHead(db: Db, designId: string): Promise<DesignHead | null> {
  const [row] = await run(db.select(head).from(designs).where(eq(designs.id, designId)));
  return row ?? null;
}

/** A design's row, without its asset key. */
export async function getDesign(db: Db, designId: string): Promise<Design | null> {
  const [row] = await run(db.select(columns).from(designs).where(eq(designs.id, designId)));
  return row ?? null;
}

/** What deciding who may open a design takes: the design, its repo, and where to ask GitHub. */
export interface DesignAccess {
  design: Design;
  /** The repo whose access decides who may open it. Null for Scratch. */
  repo: { id: string; githubRepoId: number; fullName: string } | null;
  /** The App's installation on the design's workspace. Null while the App is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace, when nobody can reach its repos. */
  suspendedAt: Date | null;
  /** What GitHub last said the person asking may do in the repo, if it was ever asked. */
  known: { permission: RepoPermission; checkedAt: Date } | null;
  /**
   * Whether the person asking is a member of the design's workspace. Nobody else may open it,
   * whatever `known` says: an answer is only ever about a member (see `repo_access`).
   */
  member: boolean;
}

/**
 * A design with what deciding whether `userId` may open it takes, or null when there is no
 * such design. Pass null for a caller who is not a person.
 */
export async function getDesignAccess(
  db: Db,
  { designId, userId }: { designId: string; userId: string | null },
): Promise<DesignAccess | null> {
  const [row] = await run(
    db
      .select({
        design: columns,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
        permission: repoAccess.permission,
        checkedAt: repoAccess.checkedAt,
        member: sql<boolean>`${memberships.userId} is not null`.mapWith(Boolean),
      })
      .from(designs)
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .leftJoin(
        memberships,
        and(
          eq(memberships.workspaceId, designs.workspaceId),
          userId === null ? sql`false` : eq(memberships.userId, userId),
        ),
      )
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .leftJoin(
        repoAccess,
        and(
          eq(repoAccess.repoId, designs.repoId),
          userId === null ? sql`false` : eq(repoAccess.userId, userId),
        ),
      )
      .where(eq(designs.id, designId)),
  );
  if (!row) return null;
  const { design, githubRepoId, fullName, installationId, suspendedAt, permission, checkedAt } =
    row;
  const { member } = row;
  return {
    design,
    repo:
      design.repoId === null || githubRepoId === null || fullName === null
        ? null
        : { id: design.repoId, githubRepoId, fullName },
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
 * Settle a design (as of `now`) or reopen it. Null when there is no such design. Its name and
 * icon are the document's, and change by op.
 */
export async function settleDesign(
  db: Db,
  designId: string,
  { settled, now }: { settled: boolean; now: Date },
): Promise<Design | null> {
  const [design] = await run(
    db
      .update(designs)
      .set(
        settled
          ? {
              status: "settled",
              // Settling a settled design keeps the time it first settled.
              settledAt: sql`coalesce(${designs.settledAt}, ${timeParam(now)}::timestamptz)`,
            }
          : { status: "active", settledAt: null },
      )
      .where(eq(designs.id, designId))
      .returning(columns),
  );
  return design ?? null;
}

/** Delete a design and everything that is only its own (see the README). False if there was none. */
export async function deleteDesign(db: Db, designId: string): Promise<boolean> {
  const deleted = await run(
    db.delete(designs).where(eq(designs.id, designId)).returning({ id: designs.id }),
  );
  return deleted.length > 0;
}

/**
 * The path segment a design's files are served under. Knowing it is the permission to read
 * them, so give it only to someone who may open the design.
 */
export async function getDesignAssetKey(db: Db, designId: string): Promise<string | null> {
  const [row] = await run(
    db.select({ assetKey: designs.assetKey }).from(designs).where(eq(designs.id, designId)),
  );
  return row?.assetKey ?? null;
}

/** A design as a list shows it to one person. */
export interface DesignListItem extends DesignHead {
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
 * A workspace's designs, most recently active first, with how far `userId` has looked at each:
 * those in a repo `repo_access` says they can read, and their own Scratch designs. That they are
 * a member, and that those answers are recent, is the caller's to make sure of.
 */
export function listWorkspaceDesigns(
  db: Db,
  { workspaceId, userId, status }: { workspaceId: string; userId: string; status?: DesignStatus },
): Promise<DesignListItem[]> {
  return run(
    db
      .select({
        ...head,
        repoId: designs.repoId,
        repoFullName: repos.fullName,
        ownerId: designs.ownerId,
        branch: designs.branch,
        settledAt: designs.settledAt,
        createdAt: designs.createdAt,
        seenSeq: designReads.seenSeq,
        seenThreadSeq: designReads.seenThreadSeq,
      })
      .from(designs)
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .leftJoin(
        designReads,
        and(eq(designReads.designId, designs.id), eq(designReads.userId, userId)),
      )
      .leftJoin(
        repoAccess,
        and(eq(repoAccess.repoId, designs.repoId), eq(repoAccess.userId, userId)),
      )
      .where(
        and(
          eq(designs.workspaceId, workspaceId),
          or(
            and(isNull(designs.repoId), eq(designs.ownerId, userId)),
            inArray(repoAccess.permission, READABLE_PERMISSIONS),
          ),
          status ? eq(designs.status, status) : undefined,
        ),
      )
      .orderBy(desc(designs.lastActivityAt), designs.id),
  );
}

/**
 * Record how far a person has looked at a design. It only moves forward, so a slow request
 * from one device cannot bring back a dot another device cleared, and never past the design's
 * seq or its newest thread item: nobody has seen what is not there yet, and a number from
 * further on would hide the dot for good.
 */
export async function markDesignSeen(
  db: Db,
  {
    userId,
    designId,
    seq = 0,
    threadSeq = 0,
  }: { userId: string; designId: string; seq?: number; threadSeq?: number },
): Promise<void> {
  const newestSeq = db.select({ seq: designs.seq }).from(designs).where(eq(designs.id, designId));
  const newestThreadSeq = db
    .select({ seq: sql`coalesce(max(${threadItems.seq}), 0)` })
    .from(threadItems)
    .where(eq(threadItems.designId, designId));
  await run(
    db
      .insert(designReads)
      .values({
        userId,
        designId,
        seenSeq: sql`least(${seq}::bigint, (${newestSeq}))`,
        seenThreadSeq: sql`least(${threadSeq}::bigint, (${newestThreadSeq}))`,
      })
      .onConflictDoUpdate({
        target: [designReads.userId, designReads.designId],
        set: {
          seenSeq: sql`greatest(${designReads.seenSeq}, excluded.seen_seq)`,
          seenThreadSeq: sql`greatest(${designReads.seenThreadSeq}, excluded.seen_thread_seq)`,
          seenAt: sql`now()`,
        },
      }),
  );
}
