import { and, eq, exists, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { designs, type RepoPermission, repoAccess, repos } from "../schema/index.ts";
import { run } from "./run.ts";

/** The permissions that let a person open a design in the repo. */
export const READABLE_PERMISSIONS = ["admin", "write", "read"] as const satisfies RepoPermission[];

/** What GitHub said one person may do in one repo, and when. */
export interface RepoAccessAnswer {
  userId: string;
  repoId: string;
  permission: RepoPermission;
  checkedAt: Date;
}

/**
 * Keep what GitHub said. An answer older than the one kept already is dropped, so a slow
 * request cannot bring back access that a later one saw taken away.
 */
export async function recordRepoAccess(db: Db, answers: RepoAccessAnswer[]): Promise<void> {
  if (answers.length === 0) return;
  await run(
    db
      .insert(repoAccess)
      .values(answers)
      .onConflictDoUpdate({
        target: [repoAccess.userId, repoAccess.repoId],
        set: { permission: sql`excluded.permission`, checkedAt: sql`excluded.checked_at` },
        setWhere: sql`${repoAccess.checkedAt} <= excluded.checked_at`,
      }),
  );
}

/** A repo with a design in it, and what GitHub last said one person may do there. */
export interface DesignRepoAccess {
  repoId: string;
  githubRepoId: number;
  /** Null when nobody has asked GitHub about this person and repo yet. */
  permission: RepoPermission | null;
  checkedAt: Date | null;
}

/** The repos of a workspace that hold at least one design, with what `userId` may do in each. */
export function listDesignRepoAccess(
  db: Db,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<DesignRepoAccess[]> {
  return run(
    db
      .select({
        repoId: repos.id,
        githubRepoId: repos.githubRepoId,
        permission: repoAccess.permission,
        checkedAt: repoAccess.checkedAt,
      })
      .from(repos)
      .leftJoin(repoAccess, and(eq(repoAccess.repoId, repos.id), eq(repoAccess.userId, userId)))
      .where(
        and(
          eq(repos.workspaceId, workspaceId),
          exists(db.select({ one: sql`1` }).from(designs).where(eq(designs.repoId, repos.id))),
        ),
      ),
  );
}
