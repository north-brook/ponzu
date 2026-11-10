import type { Doc } from "@ponzu/core";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { DesignHead } from "../head.ts";
import { newId, randomString } from "../ids.ts";
import {
  type DesignStatus,
  designCheckpoints,
  designReads,
  designs,
  repos,
} from "../schema/index.ts";
import { run } from "./run.ts";
import { isStorable, unstorableDocument } from "./text.ts";

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
}

/**
 * Create a design and its first checkpoint, at seq 0, in one statement. Every design has a
 * checkpoint from then on, which is what `readDocSource` relies on.
 */
export async function createDesign(db: Db, { doc, ...values }: NewDesign): Promise<Design> {
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
  const [design] = await run(
    db
      .with(checkpoint)
      .insert(designs)
      // 160 random bits: the key is all that guards the design's files.
      .values({ ...values, id, assetKey: randomString(32) })
      .returning(columns),
  );
  return design!;
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
 * A workspace's designs, most recently active first, with how far `userId` has looked at each.
 * It does not check which repos that person can read; the caller does.
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
      .where(
        and(eq(designs.workspaceId, workspaceId), status ? eq(designs.status, status) : undefined),
      )
      .orderBy(desc(designs.lastActivityAt), designs.id),
  );
}

/**
 * Record how far a person has looked at a design. It only moves forward, so a slow request
 * from one device cannot bring back a dot another device cleared.
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
  await run(
    db
      .insert(designReads)
      .values({ userId, designId, seenSeq: seq, seenThreadSeq: threadSeq })
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
