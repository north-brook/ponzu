import type { Doc } from "@ponzu/core";
import { and, desc, eq, getTableColumns, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { DesignHead } from "../head.ts";
import { newId, randomString } from "../ids.ts";
import {
  type DesignStatus,
  designCheckpoints,
  designReads,
  designs,
  repos,
  workspaces,
} from "../schema/index.ts";
import type { Repo } from "./accounts.ts";
import { timeParam } from "./json.ts";
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

/** What deciding who may open a design takes: the design, its repo, and where to ask GitHub. */
export interface DesignAccess {
  design: Design;
  /** The repo whose access decides who may open it. Null for Scratch. */
  repo: { githubRepoId: number; fullName: string } | null;
  /** The App's installation on the design's workspace. Null while the App is not installed. */
  installationId: number | null;
}

/** A design with what deciding access to it takes, or null when there is no such design. */
export async function getDesignAccess(db: Db, designId: string): Promise<DesignAccess | null> {
  const [row] = await run(
    db
      .select({
        design: columns,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        installationId: workspaces.installationId,
      })
      .from(designs)
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .where(eq(designs.id, designId)),
  );
  if (!row) return null;
  const { design, githubRepoId, fullName, installationId } = row;
  return {
    design,
    repo: githubRepoId === null || fullName === null ? null : { githubRepoId, fullName },
    installationId,
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
 * Change what people may change about a design themselves: its name and icon, and whether it
 * is settled (as of `now`). Null when there is no such design.
 */
export async function updateDesign(
  db: Db,
  designId: string,
  {
    name,
    icon,
    settled,
    now,
  }: { name?: string; icon?: string | null; settled?: boolean; now: Date },
): Promise<Design | null> {
  const settling =
    settled === undefined
      ? {}
      : settled
        ? {
            status: "settled" as const,
            // Settling a settled design keeps the time it first settled.
            settledAt: sql`coalesce(${designs.settledAt}, ${timeParam(now)}::timestamptz)`,
          }
        : { status: "active" as const, settledAt: null };
  const [design] = await run(
    db
      .update(designs)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(icon === undefined ? {} : { icon }),
        ...settling,
      })
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
 * A workspace's designs, most recently active first, with how far `userId` has looked at each.
 * A Scratch design is listed only to its owner. It does not check which repos that person can
 * read; the caller does.
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
        and(
          eq(designs.workspaceId, workspaceId),
          or(isNotNull(designs.repoId), eq(designs.ownerId, userId)),
          status ? eq(designs.status, status) : undefined,
        ),
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
