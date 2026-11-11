import { and, eq, getTableColumns, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type DesignStatus,
  designs,
  type PrChecks,
  type PrState,
  repos,
  workspaces,
} from "../schema/index.ts";
import type { Design } from "./designs.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

// The asset key is the permission to read a design's files: it is asked for by name only.
const { assetKey: _assetKey, ...designColumns } = getTableColumns(designs);

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
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
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
        suspendedAt: workspaces.suspendedAt,
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

/** The most designs one push to a default branch makes the API read GitHub again for. */
const OPEN_PULL_REQUESTS_READ = 50;

/**
 * The active designs of a repo whose pull request is open or a draft, at most 50: those a push
 * to the branch they merge into can give conflicts.
 */
export async function listDesignsWithOpenPullRequests(
  db: Db,
  githubRepoId: number,
): Promise<string[]> {
  const rows = await run(
    db
      .select({ id: designs.id })
      .from(designs)
      .innerJoin(repos, eq(repos.id, designs.repoId))
      .where(
        and(
          eq(repos.githubRepoId, githubRepoId),
          eq(designs.status, "active"),
          inArray(designs.prState, ["draft", "open"]),
        ),
      )
      .limit(OPEN_PULL_REQUESTS_READ),
  );
  return rows.map((row) => row.id);
}

/** What working on a design's pull request takes, in one read. */
export interface PullRequestContext {
  design: Design;
  assetKey: string;
  /** Null for Scratch. */
  repo: { githubRepoId: number; fullName: string; defaultBranch: string; private: boolean } | null;
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
}

/** A design with its repo and installation, or null when there is no such design. */
export async function getPullRequestContext(
  db: Db,
  designId: string,
): Promise<PullRequestContext | null> {
  const [row] = await run(
    db
      .select({
        design: designColumns,
        assetKey: designs.assetKey,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        defaultBranch: repos.defaultBranch,
        private: repos.private,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
      })
      .from(designs)
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .where(eq(designs.id, designId)),
  );
  if (!row) return null;
  const { githubRepoId, fullName, defaultBranch } = row;
  return {
    design: row.design,
    assetKey: row.assetKey,
    repo:
      githubRepoId === null || fullName === null || defaultBranch === null
        ? null
        : { githubRepoId, fullName, defaultBranch, private: row.private ?? true },
    installationId: row.installationId,
    suspendedAt: row.suspendedAt,
  };
}

/** A pull request as one read of GitHub found it. */
export interface PullRequestRead {
  designId: string;
  number: number;
  state: PrState;
  checks: PrChecks;
  /** False when it conflicts with its base; null while GitHub works it out. */
  mergeable: boolean | null;
  autoMerge: boolean;
  /** GitHub's `updatedAt` for it. */
  updatedAt: Date;
  /** When the read began, by the API's clock. */
  readAt: Date;
}

/**
 * Record what a read of GitHub found about a design's pull request, and settle the design when
 * the read found it merged. Answers the design as it now stands, or null when the read was not
 * applied: there is no such design, or what is recorded is newer.
 *
 * Reads finish out of order, so this keeps only the newest: a read is applied over the one
 * recorded when its pull request's number is higher (a later pull request from the branch), or
 * when it is the same one and the read began no earlier. A merge is the last word on its pull
 * request, so nothing about it is applied after one, and a design reopened after its merge
 * stays open.
 */
export async function recordPullRequestRead(db: Db, read: PullRequestRead): Promise<Design | null> {
  const merged = read.state === "merged";
  const [row] = await run(
    db
      .update(designs)
      .set({
        prNumber: read.number,
        prState: read.state,
        prChecks: read.checks,
        prMergeable: read.mergeable,
        prAutoMerge: read.autoMerge,
        prUpdatedAt: read.updatedAt,
        prReadAt: read.readAt,
        ...(merged
          ? {
              status: "settled",
              settledAt: sql`coalesce(${designs.settledAt}, ${timeParam(read.readAt)}::timestamptz)`,
            }
          : {}),
      })
      .where(
        and(
          eq(designs.id, read.designId),
          or(
            isNull(designs.prNumber),
            lt(designs.prNumber, read.number),
            and(
              eq(designs.prNumber, read.number),
              sql`${designs.prState} <> 'merged'`,
              or(isNull(designs.prReadAt), lte(designs.prReadAt, read.readAt)),
            ),
          ),
        ),
      )
      .returning(designColumns),
  );
  return row ?? null;
}

/** Keep the agent's words on what the branch changes. Null when there is no such design. */
export async function setPullRequestSummary(
  db: Db,
  { designId, summary }: { designId: string; summary: string },
): Promise<{ prNumber: number | null; prState: PrState | null } | null> {
  const [row] = await run(
    db
      .update(designs)
      .set({ prSummary: summary })
      .where(eq(designs.id, designId))
      .returning({ prNumber: designs.prNumber, prState: designs.prState }),
  );
  return row ?? null;
}
