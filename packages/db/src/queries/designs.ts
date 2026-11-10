import type { Doc } from "@ponzu/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId, randomString } from "../ids.ts";
import {
  type DesignStatus,
  designCheckpoints,
  designReads,
  designs,
  repos,
} from "../schema/index.ts";

export type Design = typeof designs.$inferSelect;

export interface NewDesign {
  workspaceId: string;
  /** Null for Scratch. */
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
export async function createDesign(db: Db, { doc, ...columns }: NewDesign): Promise<Design> {
  const id = newId("des");
  const checkpoint = db
    .$with("checkpoint")
    .as(
      db
        .insert(designCheckpoints)
        .values({ designId: id, seq: 0, doc })
        .returning({ seq: designCheckpoints.seq }),
    );
  const [design] = await db
    .with(checkpoint)
    .insert(designs)
    // 160 random bits: the key is all that guards the design's files.
    .values({ ...columns, id, assetKey: randomString(32) })
    .returning();
  return design!;
}

/**
 * The part of a design that clients watch live. It is small and changes often; when `seq`
 * moves, a client fetches the ops after its own seq. A live query for it selects these columns.
 */
const head = {
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

export type DesignHead = Pick<Design, keyof typeof head>;

export async function getDesignHead(db: Db, designId: string): Promise<DesignHead | null> {
  const [row] = await db.select(head).from(designs).where(eq(designs.id, designId));
  return row ?? null;
}

export async function getDesign(db: Db, designId: string): Promise<Design | null> {
  const [row] = await db.select().from(designs).where(eq(designs.id, designId));
  return row ?? null;
}

/** A design as a list shows it to one person. */
export interface DesignListItem extends Design {
  /** `owner/name`. Null for Scratch. */
  repoFullName: string | null;
  /** How far this person has looked. Null when they have never opened it. */
  seenSeq: number | null;
  seenThreadSeq: number | null;
}

/**
 * A workspace's designs, most recently active first, with how far `userId` has looked at each.
 * It does not check which repos that person can read; the caller does.
 */
export async function listWorkspaceDesigns(
  db: Db,
  { workspaceId, userId, status }: { workspaceId: string; userId: string; status?: DesignStatus },
): Promise<DesignListItem[]> {
  const rows = await db
    .select({
      design: designs,
      repoFullName: repos.fullName,
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
    .orderBy(desc(designs.lastActivityAt), designs.id);
  return rows.map(({ design, ...rest }) => ({ ...design, ...rest }));
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
  await db
    .insert(designReads)
    .values({ userId, designId, seenSeq: seq, seenThreadSeq: threadSeq })
    .onConflictDoUpdate({
      target: [designReads.userId, designReads.designId],
      set: {
        seenSeq: sql`greatest(${designReads.seenSeq}, excluded.seen_seq)`,
        seenThreadSeq: sql`greatest(${designReads.seenThreadSeq}, excluded.seen_thread_seq)`,
        seenAt: sql`now()`,
      },
    });
}
