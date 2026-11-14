import { and, asc, eq, getTableColumns, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type CanvasStatus,
  canvases,
  canvasPullRequests,
  jobs,
  type PrChecks,
  type PrLinkSource,
  type PrState,
  repos,
  users,
  workspaces,
} from "../schema/index.ts";
import type { Canvas } from "./canvases.ts";
import { onceId } from "./jobs.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * Pull requests linked to a canvas (docs/cloud.md, "Linked pull requests"): those a person or
 * their agent said are the canvas's work, besides the one from its branch (`canvases.pr_*`).
 * Each row keeps what the last read of GitHub said, under the same newest-read rule as the
 * branch's, and the canvas keeps how many there are and how many are still open
 * (`pr_linked_count`, `pr_linked_open`) for its head, which clients watch live.
 */

// The asset key is the permission to read a canvas's files: it is asked for by name only.
const { assetKey: _assetKey, ...canvasColumns } = getTableColumns(canvases);

/** The most pull requests one canvas links. */
export const MAX_LINKED_PULL_REQUESTS = 20;

/** The states in which a pull request is finished. */
const FINISHED: PrState[] = ["merged", "closed"];

export type LinkedPullRequestRow = typeof canvasPullRequests.$inferSelect;

/** A linked pull request as clients show it: its row, its repo, and who linked it. */
export interface LinkedPullRequestView extends LinkedPullRequestRow {
  /** `owner/repo`. */
  repository: string;
  linkedBy: { id: string; name: string; avatarUrl: string | null } | null;
}

/** Which link: a canvas, a repo of its workspace and a number. */
export interface LinkKey {
  canvasId: string;
  repoId: string;
  number: number;
}

const keyOf = ({ canvasId, repoId, number }: LinkKey) =>
  and(
    eq(canvasPullRequests.canvasId, canvasId),
    eq(canvasPullRequests.repoId, repoId),
    eq(canvasPullRequests.number, number),
  );

/** What linking to a canvas takes: the canvas and its workspace's App. */
export interface LinkContext {
  canvas: Pick<Canvas, "id" | "workspaceId" | "repoId" | "branch" | "prNumber" | "status">;
  workspace: {
    id: string;
    name: string;
    githubLogin: string;
    installationId: number | null;
    suspendedAt: Date | null;
  };
}

/** The canvas and its workspace, or null when there is no such canvas. */
export async function getLinkContext(db: Db, canvasId: string): Promise<LinkContext | null> {
  const [row] = await run(
    db
      .select({
        canvas: {
          id: canvases.id,
          workspaceId: canvases.workspaceId,
          repoId: canvases.repoId,
          branch: canvases.branch,
          prNumber: canvases.prNumber,
          status: canvases.status,
        },
        workspace: {
          id: workspaces.id,
          name: workspaces.name,
          githubLogin: workspaces.githubLogin,
          installationId: workspaces.installationId,
          suspendedAt: workspaces.suspendedAt,
        },
      })
      .from(canvases)
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .where(eq(canvases.id, canvasId)),
  );
  return row ?? null;
}

/** A repo of a workspace, as linking needs it. */
export interface WorkspaceRepo {
  id: string;
  workspaceId: string;
  githubRepoId: number;
  fullName: string;
  defaultBranch: string;
  /** Set once the App lost it. */
  removedAt: Date | null;
}

/** The workspace's repo named `owner/name` (GitHub's names are not case sensitive), or null. */
export async function findWorkspaceRepo(
  db: Db,
  { workspaceId, fullName }: { workspaceId: string; fullName: string },
): Promise<WorkspaceRepo | null> {
  const [row] = await run(
    db
      .select({
        id: repos.id,
        workspaceId: repos.workspaceId,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        defaultBranch: repos.defaultBranch,
        removedAt: repos.removedAt,
      })
      .from(repos)
      .where(
        and(eq(repos.workspaceId, workspaceId), sql`lower(${repos.fullName}) = lower(${fullName})`),
      )
      // A repo renamed onto a name another of the workspace's had: the one the App still has.
      .orderBy(sql`${repos.removedAt} is not null`)
      .limit(1),
  );
  return row ?? null;
}

const viewColumns = {
  ...getTableColumns(canvasPullRequests),
  repository: repos.fullName,
  linkedById: users.id,
  linkedByName: sql<string>`coalesce(${users.name}, ${users.githubLogin})`,
  linkedByAvatarUrl: users.avatarUrl,
};

function toView(row: {
  linkedById: string | null;
  linkedByName: string | null;
  linkedByAvatarUrl: string | null;
}): LinkedPullRequestView {
  const { linkedById, linkedByName, linkedByAvatarUrl, ...rest } = row as typeof row &
    LinkedPullRequestView;
  return {
    ...rest,
    linkedBy:
      linkedById === null
        ? null
        : { id: linkedById, name: linkedByName ?? "", avatarUrl: linkedByAvatarUrl },
  };
}

/** The rows with their repo and who linked them; the caller runs it (`run`). */
const viewQuery = (db: Db) =>
  db
    .select(viewColumns)
    .from(canvasPullRequests)
    .innerJoin(repos, eq(repos.id, canvasPullRequests.repoId))
    .leftJoin(users, eq(users.id, canvasPullRequests.linkedByUserId));

/** The pull requests a canvas links, the first linked first. */
export async function listLinkedPullRequests(
  db: Db,
  canvasId: string,
): Promise<LinkedPullRequestView[]> {
  const rows = await run(
    viewQuery(db)
      .where(eq(canvasPullRequests.canvasId, canvasId))
      .orderBy(asc(canvasPullRequests.linkedAt), asc(canvasPullRequests.number)),
  );
  return rows.map(toView);
}

/** One link, or null. */
export async function getLinkedPullRequest(
  db: Db,
  key: LinkKey,
): Promise<LinkedPullRequestView | null> {
  const [row] = await run(viewQuery(db).where(keyOf(key)));
  return row ? toView(row) : null;
}

/** A pull request as one read of GitHub found it, for a link. */
export interface LinkedRead extends LinkKey {
  title: string;
  url: string;
  state: PrState;
  checks: PrChecks;
  mergeable: boolean | null;
  autoMerge: boolean;
  /** GitHub's `updatedAt` for it. */
  updatedAt: Date;
  /** When the read began, by the API's clock. */
  readAt: Date;
}

/** A new link: the pull request as read, and who linked it. */
export interface NewLink extends LinkedRead {
  githubRepoId: number;
  source: PrLinkSource;
  linkedByUserId: string | null;
  linkedVia: string | null;
  linkedAt: Date;
}

/** How adding a link went. */
export type AddLinkResult =
  | { kind: "linked"; link: LinkedPullRequestView }
  /** The canvas already links it. */
  | { kind: "exists" }
  /** The canvas links `MAX_LINKED_PULL_REQUESTS` already. */
  | { kind: "full" };

/**
 * Link a pull request to a canvas, unless it already is, or the canvas already links
 * `MAX_LINKED_PULL_REQUESTS`. One already merged or closed is recorded finished (`finished_at`
 * at the read), and settles nothing by itself. The canvas's counts follow.
 *
 * The count is read in the same statement as the insert, without a lock, so two links at the same
 * moment can go one past the most; it is there to keep a canvas's list readable, not to count
 * exactly.
 */
export async function addLinkedPullRequest(
  db: Db,
  link: NewLink,
  { max = MAX_LINKED_PULL_REQUESTS }: { max?: number } = {},
): Promise<AddLinkResult> {
  const finished = FINISHED.includes(link.state);
  const { rows: inserted } = (await run(
    db.execute(sql`
      insert into canvas_pull_requests
        (canvas_id, repo_id, github_repo_id, number, title, url, state, checks, mergeable,
         auto_merge, updated_at, read_at, finished_at, source, linked_by_user_id, linked_via,
         linked_at)
      select ${link.canvasId}, ${link.repoId}, ${link.githubRepoId}, ${link.number}, ${link.title},
             ${link.url}, ${link.state}, ${link.checks}, ${link.mergeable}::boolean,
             ${link.autoMerge}, ${timeParam(link.updatedAt)}::timestamptz,
             ${timeParam(link.readAt)}::timestamptz,
             ${finished ? timeParam(link.readAt) : null}::timestamptz, ${link.source},
             ${link.linkedByUserId}, ${link.linkedVia}, ${timeParam(link.linkedAt)}::timestamptz
       where (select count(*) from canvas_pull_requests where canvas_id = ${link.canvasId}) < ${max}
      on conflict do nothing
      returning number`),
  )) as unknown as { rows: unknown[] };
  if (inserted.length === 0) {
    const existing = await getLinkedPullRequest(db, link);
    return existing ? { kind: "exists" } : { kind: "full" };
  }
  await countLinkedPullRequests(db, link.canvasId);
  const added = await getLinkedPullRequest(db, link);
  // Unlinked between the two statements: as good as never linked.
  if (!added) return { kind: "exists" };
  return { kind: "linked", link: added };
}

/** How many links a canvas has, for the most it may. */
export async function countLinks(db: Db, canvasId: string): Promise<number> {
  const [row] = await run(
    db
      .select({ count: sql<number>`count(*)::integer` })
      .from(canvasPullRequests)
      .where(eq(canvasPullRequests.canvasId, canvasId)),
  );
  return row?.count ?? 0;
}

/** Take links off a canvas. Answers those that were there. The canvas's counts follow. */
export async function removeLinkedPullRequests(
  db: Db,
  canvasId: string,
  keys: { repoId: string; number: number }[],
): Promise<{ repoId: string; number: number }[]> {
  if (keys.length === 0) return [];
  const removed = await run(
    db
      .delete(canvasPullRequests)
      .where(
        and(
          eq(canvasPullRequests.canvasId, canvasId),
          or(
            ...keys.map(({ repoId, number }) =>
              and(eq(canvasPullRequests.repoId, repoId), eq(canvasPullRequests.number, number)),
            ),
          ),
        ),
      )
      .returning({ repoId: canvasPullRequests.repoId, number: canvasPullRequests.number }),
  );
  if (removed.length > 0) await countLinkedPullRequests(db, canvasId);
  return removed;
}

/**
 * Bring the canvas's `pr_linked_count` and `pr_linked_open` up to its links, writing only when
 * they differ: every write to the row reaches everyone watching the workspace's canvases.
 */
export async function countLinkedPullRequests(db: Db, canvasId: string): Promise<void> {
  const count = sql`(select count(*)::integer from canvas_pull_requests where canvas_id = ${canvasId})`;
  const open = sql`(select count(*)::integer from canvas_pull_requests where canvas_id = ${canvasId} and finished_at is null)`;
  await run(
    db
      .update(canvases)
      .set({ prLinkedCount: count, prLinkedOpen: open })
      .where(
        and(
          eq(canvases.id, canvasId),
          sql`(${canvases.prLinkedCount}, ${canvases.prLinkedOpen}) is distinct from (${count}, ${open})`,
        ),
      ),
  );
}

/** What recording a read of a link did. */
export interface RecordedLink {
  link: LinkedPullRequestRow;
  /** The read moved it into merged or closed: what may settle its canvas. */
  finished: boolean;
}

/**
 * Record what a read of GitHub found about a linked pull request. Answers the link as it now
 * stands, or null when the read was not applied: there is no such link, a read that began later
 * was recorded first, it merged already (a merge is the last word), or it already says all this.
 * `finished_at` is set the first time it is seen merged or closed, and cleared if it is reopened.
 * The canvas's counts follow.
 */
export async function recordLinkedRead(db: Db, read: LinkedRead): Promise<RecordedLink | null> {
  const finished = FINISHED.includes(read.state);
  const t = canvasPullRequests;
  const prior = db
    .$with("link_prior", { state: sql<PrState>`state` })
    .as(
      sql`select state from canvas_pull_requests where canvas_id = ${read.canvasId} and repo_id = ${read.repoId} and number = ${read.number}`,
    );
  const recorded = sql`(${t.title}, ${t.url}, ${t.state}, ${t.checks}, ${t.mergeable}, ${t.autoMerge}, ${t.updatedAt})`;
  const found = sql`(${read.title}::text, ${read.url}::text, ${read.state}::text, ${read.checks}::text, ${read.mergeable}::boolean, ${read.autoMerge}::boolean, ${timeParam(read.updatedAt)}::timestamptz)`;
  const [row] = await run(
    db
      .with(prior)
      .update(t)
      .set({
        title: read.title,
        url: read.url,
        state: read.state,
        checks: read.checks,
        mergeable: read.mergeable,
        autoMerge: read.autoMerge,
        updatedAt: read.updatedAt,
        readAt: read.readAt,
        finishedAt: finished
          ? sql`coalesce(${t.finishedAt}, ${timeParam(read.readAt)}::timestamptz)`
          : null,
      })
      .where(
        and(
          keyOf(read),
          sql`${recorded} is distinct from ${found}`,
          sql`${t.state} <> 'merged'`,
          sql`${t.readAt} <= ${timeParam(read.readAt)}::timestamptz`,
        ),
      )
      .returning({
        ...getTableColumns(t),
        priorState: sql<PrState>`(select state from link_prior)`,
      }),
  );
  if (!row) return null;
  const { priorState, ...link } = row;
  const wasFinished = FINISHED.includes(priorState);
  if (finished !== wasFinished) await countLinkedPullRequests(db, read.canvasId);
  return { link, finished: finished && !wasFinished };
}

/** A canvas that links a pull request, with what reading it as the App takes. */
export interface LinkingCanvas extends LinkKey {
  repo: { githubRepoId: number; fullName: string };
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  suspendedAt: Date | null;
  canvasStatus: CanvasStatus;
}

/** The links with their repo and workspace; the caller runs it (`run`). */
const linkingQuery = (db: Db) =>
  db
    .select({
      canvasId: canvasPullRequests.canvasId,
      repoId: canvasPullRequests.repoId,
      number: canvasPullRequests.number,
      githubRepoId: repos.githubRepoId,
      fullName: repos.fullName,
      installationId: workspaces.installationId,
      suspendedAt: workspaces.suspendedAt,
      canvasStatus: canvases.status,
    })
    .from(canvasPullRequests)
    .innerJoin(repos, eq(repos.id, canvasPullRequests.repoId))
    .innerJoin(canvases, eq(canvases.id, canvasPullRequests.canvasId))
    .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId));

function toLinking(row: Awaited<ReturnType<ReturnType<typeof linkingQuery>["execute"]>>[number]) {
  const { githubRepoId, fullName, ...rest } = row;
  return { ...rest, repo: { githubRepoId, fullName } } satisfies LinkingCanvas;
}

/** The canvases that link pull request `number` of the repo GitHub knows as `githubRepoId`. */
export async function findLinkingCanvases(
  db: Db,
  { githubRepoId, numbers }: { githubRepoId: number; numbers: number[] },
): Promise<LinkingCanvas[]> {
  if (numbers.length === 0) return [];
  const rows = await run(
    linkingQuery(db).where(
      and(
        eq(canvasPullRequests.githubRepoId, githubRepoId),
        inArray(canvasPullRequests.number, numbers),
      ),
    ),
  );
  return rows.map(toLinking);
}

/** One link with what reading it takes, or null. */
export async function getLinkingCanvas(db: Db, key: LinkKey): Promise<LinkingCanvas | null> {
  const [row] = await run(linkingQuery(db).where(keyOf(key)));
  return row ? toLinking(row) : null;
}

/** An open link the sweep reads again. */
export interface StaleLink extends LinkKey {
  readAt: Date;
}

/**
 * The links still open (or drafts) last read before `readBefore`, oldest read first, at most
 * `limit`: those whose webhooks may all have been lost. Left out, as for the branch's
 * (`listStalePullRequests`): links with a read already waiting, those this window's sweep took
 * already, and those whose workspace has no App installation that works, or whose repo it lost.
 */
export async function listStaleLinkedPullRequests(
  db: Db,
  opts: { readBefore: Date; refreshKind: string; sweptKind: string; window: string; limit: number },
): Promise<StaleLink[]> {
  const { readBefore, refreshKind, sweptKind, window, limit } = opts;
  const t = canvasPullRequests;
  return run(
    db
      .select({ canvasId: t.canvasId, repoId: t.repoId, number: t.number, readAt: t.readAt })
      .from(t)
      .innerJoin(repos, eq(repos.id, t.repoId))
      .innerJoin(workspaces, eq(workspaces.id, repos.workspaceId))
      .where(
        and(
          isNull(t.finishedAt),
          lt(t.readAt, readBefore),
          isNull(repos.removedAt),
          sql`${workspaces.installationId} is not null`,
          isNull(workspaces.suspendedAt),
          sql`not exists (select 1 from ${jobs} where ${jobs.kind} = ${refreshKind} and ${jobs.completedAt} is null and ${jobs.failedAt} is null and ${jobs.payload}->>'canvasId' = ${t.canvasId} and ${jobs.payload}->>'repoId' = ${t.repoId} and ${jobs.payload}->>'number' = ${t.number}::text)`,
          sql`not exists (select 1 from ${jobs} where ${jobs.id} = ${onceId(sweptKind, "link:")} || ${t.canvasId} || ':' || ${t.repoId} || ':' || ${t.number}::text || ${`@${window}`})`,
        ),
      )
      .orderBy(asc(t.readAt), t.canvasId, t.repoId, t.number)
      .limit(limit),
  );
}

/**
 * Settle an active canvas whose pull requests are all done (docs/cloud.md, "Settling"): it has
 * at least one, the branch's (if any) and every linked one is merged or closed, and at least one
 * of them merged. One statement, so two reads finishing at once settle it once. Answers the
 * canvas once settled, or null when it was not (not done, already settled, or no such canvas).
 *
 * Called whenever a record moves a pull request into merged or closed, never otherwise: a canvas
 * a person reopened stays open until another one does.
 */
export async function settleWhenDone(db: Db, canvasId: string, at: Date): Promise<Canvas | null> {
  const [row] = await run(
    db
      .update(canvases)
      .set({
        status: "settled",
        settledAt: sql`coalesce(${canvases.settledAt}, ${timeParam(at)}::timestamptz)`,
      })
      .where(
        and(
          eq(canvases.id, canvasId),
          eq(canvases.status, "active"),
          or(isNull(canvases.prState), inArray(canvases.prState, FINISHED)),
          sql`not exists (select 1 from canvas_pull_requests l where l.canvas_id = ${canvases.id} and l.finished_at is null)`,
          or(
            eq(canvases.prState, "merged"),
            sql`exists (select 1 from canvas_pull_requests l where l.canvas_id = ${canvases.id} and l.state = 'merged')`,
          ),
        ),
      )
      .returning(canvasColumns),
  );
  return row ?? null;
}
