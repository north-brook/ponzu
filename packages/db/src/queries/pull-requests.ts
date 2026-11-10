import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type DesignStatus, designs, type PrState, repos, workspaces } from "../schema/index.ts";
import { run } from "./run.ts";

/** Which design a branch of a repo belongs to. `branch` is unique within a repo. */
interface BranchKey {
  githubRepoId: number;
  branch: string;
}

/** A design found by its branch, with what asking GitHub about its repo takes. */
export interface BranchDesign {
  id: string;
  status: DesignStatus;
  repo: { id: string; githubRepoId: number; fullName: string };
  /** The App's installation on the design's workspace. Null while the App is not installed. */
  installationId: number | null;
}

/** The design that owns a branch of a repo, or null when no design does. */
export async function findDesignByBranch(
  db: Db,
  { githubRepoId, branch }: BranchKey,
): Promise<BranchDesign | null> {
  const [row] = await run(
    db
      .select({
        id: designs.id,
        status: designs.status,
        repoId: repos.id,
        fullName: repos.fullName,
        installationId: workspaces.installationId,
      })
      .from(designs)
      .innerJoin(repos, eq(repos.id, designs.repoId))
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .where(and(eq(repos.githubRepoId, githubRepoId), eq(designs.branch, branch))),
  );
  if (!row) return null;
  const { repoId, fullName, ...design } = row;
  return { ...design, repo: { id: repoId, githubRepoId, fullName } };
}

/**
 * Record a pull request's state on the design that owns its branch. A merge settles the
 * design. Answers the design's id, or null when no design owns the branch or what is recorded
 * is newer.
 *
 * GitHub delivers webhooks out of order and again, so this keeps only the newest word: a pull
 * request is applied over the one recorded when its number is higher (a later pull request
 * from the same branch), or when it is the same one and GitHub's `updatedAt` is not older.
 */
export async function recordPullRequest(
  db: Db,
  {
    githubRepoId,
    branch,
    number,
    state,
    updatedAt,
  }: BranchKey & { number: number; state: PrState; updatedAt: Date },
): Promise<string | null> {
  const merged = state === "merged";
  const [row] = await run(
    db
      .update(designs)
      .set({
        prNumber: number,
        prState: state,
        prUpdatedAt: updatedAt,
        ...(merged
          ? { status: "settled", settledAt: sql`coalesce(${designs.settledAt}, now())` }
          : {}),
      })
      .from(repos)
      .where(
        and(
          eq(repos.id, designs.repoId),
          eq(repos.githubRepoId, githubRepoId),
          eq(designs.branch, branch),
          or(
            isNull(designs.prNumber),
            lt(designs.prNumber, number),
            and(
              eq(designs.prNumber, number),
              or(isNull(designs.prUpdatedAt), lte(designs.prUpdatedAt, updatedAt)),
            ),
          ),
        ),
      )
      .returning({ id: designs.id }),
  );
  return row?.id ?? null;
}
