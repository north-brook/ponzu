import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type CanvasStatus,
  canvases,
  canvasRunners,
  type PrChecks,
  type PrState,
  repos,
  workspaces,
} from "../schema/index.ts";
import type { Canvas } from "./canvases.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

// The asset key is the permission to read a canvas's files: it is asked for by name only.
const { assetKey: _assetKey, ...canvasColumns } = getTableColumns(canvases);

/** Which canvas a branch of a repo belongs to. `branch` is unique within a repo. */
interface BranchKey {
  githubRepoId: number;
  branch: string;
}

/** A canvas found by its branch, with what asking GitHub about its repo takes. */
export interface BranchCanvas {
  id: string;
  status: CanvasStatus;
  repo: { id: string; githubRepoId: number; fullName: string };
  /** The App's installation on the canvas's workspace. Null while the App is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
}

/** The canvas that owns a branch of a repo, or null when no canvas does. */
export async function findCanvasByBranch(
  db: Db,
  { githubRepoId, branch }: BranchKey,
): Promise<BranchCanvas | null> {
  const [row] = await run(
    db
      .select({
        id: canvases.id,
        status: canvases.status,
        repoId: repos.id,
        fullName: repos.fullName,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
      })
      .from(canvases)
      .innerJoin(repos, eq(repos.id, canvases.repoId))
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .where(and(eq(repos.githubRepoId, githubRepoId), eq(canvases.branch, branch))),
  );
  if (!row) return null;
  const { repoId, fullName, ...canvas } = row;
  return { ...canvas, repo: { id: repoId, githubRepoId, fullName } };
}

/** The most canvases one event about a repo makes the API read GitHub again for. */
const PULL_REQUEST_CANVASES_LISTED = 50;

/**
 * The canvases of a repo with a pull request, most recently updated on GitHub first, at most 50.
 * With `open`, only active canvases whose pull request is open or a draft: those a push to the
 * branch they merge into can give conflicts.
 */
export async function listPullRequestCanvases(
  db: Db,
  { githubRepoId, open }: { githubRepoId: number; open: boolean },
): Promise<string[]> {
  const rows = await run(
    db
      .select({ id: canvases.id })
      .from(canvases)
      .innerJoin(repos, eq(repos.id, canvases.repoId))
      .where(
        and(
          eq(repos.githubRepoId, githubRepoId),
          open
            ? and(eq(canvases.status, "active"), inArray(canvases.prState, ["draft", "open"]))
            : isNotNull(canvases.prNumber),
        ),
      )
      .orderBy(sql`${canvases.prUpdatedAt} desc nulls last`)
      .limit(PULL_REQUEST_CANVASES_LISTED),
  );
  return rows.map((row) => row.id);
}

/** What working on a canvas's pull request takes, in one read. */
export interface PullRequestContext {
  canvas: Canvas;
  assetKey: string;
  /** Null for Scratch. */
  repo: { githubRepoId: number; fullName: string; defaultBranch: string; private: boolean } | null;
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
  /**
   * The canvas's branch in its sandbox as the runner last said: commits GitHub does not have,
   * and why the last push of them failed. None before a runner has said.
   */
  sandbox: { unpushed: number; pushError: string | null };
}

/** A canvas with its repo and installation, or null when there is no such canvas. */
export async function getPullRequestContext(
  db: Db,
  canvasId: string,
): Promise<PullRequestContext | null> {
  const [row] = await run(
    db
      .select({
        canvas: canvasColumns,
        assetKey: canvases.assetKey,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        defaultBranch: repos.defaultBranch,
        private: repos.private,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
        unpushed: canvasRunners.unpushed,
        pushError: canvasRunners.pushError,
      })
      .from(canvases)
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .leftJoin(repos, eq(repos.id, canvases.repoId))
      .leftJoin(canvasRunners, eq(canvasRunners.canvasId, canvases.id))
      .where(eq(canvases.id, canvasId)),
  );
  if (!row) return null;
  const { githubRepoId, fullName, defaultBranch } = row;
  return {
    canvas: row.canvas,
    assetKey: row.assetKey,
    repo:
      githubRepoId === null || fullName === null || defaultBranch === null
        ? null
        : { githubRepoId, fullName, defaultBranch, private: row.private ?? true },
    installationId: row.installationId,
    suspendedAt: row.suspendedAt,
    sandbox: { unpushed: row.unpushed ?? 0, pushError: row.pushError ?? null },
  };
}

/** A pull request as one read of GitHub found it. */
export interface PullRequestRead {
  canvasId: string;
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
 * Record what a read of GitHub found about a canvas's pull request, and settle the canvas when
 * the read found it merged. Answers the canvas as it now stands, or null when the read was not
 * applied: there is no such canvas, what is recorded is newer, or it already says all this.
 *
 * Reads finish out of order, so this keeps only the newest: a read is applied over the one
 * recorded when its pull request's number is higher (a later pull request from the branch), or
 * when it is the same one and the read began no earlier. A merge is the last word on its pull
 * request, so nothing about it is applied after one, and a canvas reopened after its merge
 * stays open.
 *
 * A read that finds nothing new writes nothing, not even when it began: every write to the row
 * reaches everyone watching the workspace's canvases, and most reads (a webhook for each check)
 * find what is already there.
 */
export async function recordPullRequestRead(db: Db, read: PullRequestRead): Promise<Canvas | null> {
  const merged = read.state === "merged";
  const recorded = sql`(${canvases.prNumber}, ${canvases.prState}, ${canvases.prChecks}, ${canvases.prMergeable}, ${canvases.prAutoMerge}, ${canvases.prUpdatedAt})`;
  const found = sql`(${read.number}::integer, ${read.state}::text, ${read.checks}::text, ${read.mergeable}::boolean, ${read.autoMerge}::boolean, ${timeParam(read.updatedAt)}::timestamptz)`;
  const [row] = await run(
    db
      .update(canvases)
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
              settledAt: sql`coalesce(${canvases.settledAt}, ${timeParam(read.readAt)}::timestamptz)`,
            }
          : {}),
      })
      .where(
        and(
          eq(canvases.id, read.canvasId),
          sql`${recorded} is distinct from ${found}`,
          or(
            isNull(canvases.prNumber),
            lt(canvases.prNumber, read.number),
            and(
              eq(canvases.prNumber, read.number),
              sql`${canvases.prState} <> 'merged'`,
              or(isNull(canvases.prReadAt), lte(canvases.prReadAt, read.readAt)),
            ),
          ),
        ),
      )
      .returning(canvasColumns),
  );
  return row ?? null;
}

/** Keep the agent's words on what the branch changes. Null when there is no such canvas. */
export async function setPullRequestSummary(
  db: Db,
  { canvasId, summary }: { canvasId: string; summary: string },
): Promise<{ prNumber: number | null; prState: PrState | null } | null> {
  const [row] = await run(
    db
      .update(canvases)
      .set({ prSummary: summary })
      .where(eq(canvases.id, canvasId))
      .returning({ prNumber: canvases.prNumber, prState: canvases.prState }),
  );
  return row ?? null;
}
