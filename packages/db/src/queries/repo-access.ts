import { and, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { canvases, type RepoPermission, repoAccess, repos } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * `repo_access`: what GitHub last said each person may do in each repo, and when. It is the one
 * place every question of "may this person see or steer this repo" is answered from; the API's
 * `auth/repo-access.ts` decides when an answer is fresh enough and asks GitHub when it is not.
 * Whoever reads it also requires the person's membership of the repo's workspace.
 */

/**
 * The permissions that let a person open a canvas in the repo, and see the repo listed. A
 * `read` in `repo_access` is one GitHub gave the person, never the read anyone has of a public
 * repo (`recordReachableRepos`, and `repoPermission` in the API).
 */
export const READABLE_PERMISSIONS = ["admin", "write", "read"] as const satisfies RepoPermission[];
/** The permissions that let a person steer a canvas in the repo, and start one there. */
export const WRITABLE_PERMISSIONS = ["admin", "write"] as const satisfies RepoPermission[];

/** What GitHub said one person may do in one repo, and when. */
export interface RepoAccessAnswer {
  userId: string;
  repoId: string;
  permission: RepoPermission;
  checkedAt: Date;
}

/** The time a stale answer carries: older than any freshness or fallback window. */
const STALE = new Date(0);

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

/**
 * Record what one person's own token lists of an installation's repos
 * (`GET /user/installations/{id}/repositories`), asked at `checkedAt`: each listed repo of the
 * workspace with the permission it shows, and, when the list is `complete`, every other repo
 * of the workspace as `none`, except a public one when `readsPublic`. GitHub lists exactly the
 * repos it has given the person (they own it, they are one of its collaborators, directly or
 * through a team, or their organization membership reaches it), and leaves out a public repo
 * whose only tie to them is that anyone may read it. Ponzu shows a canvas only to people GitHub
 * has given its repo (docs/cloud.md, "Identity and access"), so such a repo is `none` for them.
 * `readsPublic` says they are a member or an owner of the organization the workspace is, or are
 * its personal account: GitHub gives them every public repo of it, listed or not. A list GitHub
 * cut short only adds. As with `recordRepoAccess`, nothing replaces a newer answer.
 *
 * Only repos Ponzu already has for the workspace are recorded. Answers the GitHub ids it does
 * not have, which mean the workspace's own copy of its installation is behind.
 */
export async function recordReachableRepos(
  db: Db,
  {
    workspaceId,
    userId,
    repos: listed,
    complete,
    readsPublic,
    checkedAt,
  }: {
    workspaceId: string;
    userId: string;
    repos: { githubRepoId: number; permission: Exclude<RepoPermission, "none"> }[];
    complete: boolean;
    /** They are in the organization the workspace is, or are its personal account. */
    readsPublic: boolean;
    checkedAt: Date;
  },
): Promise<{ missing: number[] }> {
  const seen = JSON.stringify(
    listed.map(({ githubRepoId, permission }) => ({ github_repo_id: githubRepoId, permission })),
  );
  const result = await queryJson<{ missing: number[] }>(
    db,
    sql`
      with seen as (
        select listed.github_repo_id, listed.permission, repos.id as repo_id
        from json_to_recordset(${seen}::json) as listed(github_repo_id bigint, permission text)
        left join repos
          on repos.github_repo_id = listed.github_repo_id and repos.workspace_id = ${workspaceId}
      ), answers as (
        select distinct on (repo_id) repo_id, permission from seen where repo_id is not null
        union all
        select repos.id,
          case when not repos.private and ${readsPublic}::boolean then 'read' else 'none' end
        from repos
        where ${complete}::boolean and repos.workspace_id = ${workspaceId}
          and repos.id not in (select repo_id from seen where repo_id is not null)
      ), recorded as (
        insert into repo_access (user_id, repo_id, permission, checked_at)
        select ${userId}, repo_id, permission, ${timeParam(checkedAt)}::timestamptz from answers
        on conflict (user_id, repo_id) do update
          set permission = excluded.permission, checked_at = excluded.checked_at
          where repo_access.checked_at <= excluded.checked_at
        returning repo_id
      )
      select json_build_object(
        'missing',
        coalesce((select json_agg(github_repo_id) from seen where repo_id is null), '[]'::json)
      ) as result`,
  );
  return { missing: (result?.missing ?? []).map(Number) };
}

/** What GitHub last said one person may do in one repo, or null if it was never asked. */
export async function getRepoAccess(
  db: Db,
  { userId, repoId }: { userId: string; repoId: string },
): Promise<{ permission: RepoPermission; checkedAt: Date } | null> {
  const [row] = await run(
    db
      .select({ permission: repoAccess.permission, checkedAt: repoAccess.checkedAt })
      .from(repoAccess)
      .where(and(eq(repoAccess.userId, userId), eq(repoAccess.repoId, repoId))),
  );
  return row ?? null;
}

/**
 * The workspace a repo belongs to and whether GitHub last said it is private, or null when
 * Ponzu has no such repo.
 */
export async function getRepoVisibility(
  db: Db,
  repoId: string,
): Promise<{ workspaceId: string; private: boolean } | null> {
  const [row] = await run(
    db
      .select({ workspaceId: repos.workspaceId, private: repos.private })
      .from(repos)
      .where(eq(repos.id, repoId)),
  );
  return row ?? null;
}

/**
 * Make answers stale, for when GitHub says access may have changed and Ponzu cannot ask the
 * person (a repo left the installation, went private or moved; a team's repos changed; their
 * token is dead). Each keeps its permission, so a list goes on showing what it showed until it
 * is renewed, but nothing takes it as fresh, or stands in with it while GitHub is down: the
 * next question asks GitHub. Name a workspace (its repos, for everyone), GitHub repo ids (for
 * everyone), or a person (every repo). Answers how many it touched.
 */
export async function markRepoAccessStale(
  db: Db,
  target: { workspaceId: string } | { githubRepoIds: number[] } | { userId: string },
): Promise<number> {
  let where: SQL;
  if ("userId" in target) where = eq(repoAccess.userId, target.userId);
  else if ("workspaceId" in target) {
    where = inArray(
      repoAccess.repoId,
      db.select({ id: repos.id }).from(repos).where(eq(repos.workspaceId, target.workspaceId)),
    );
  } else {
    if (target.githubRepoIds.length === 0) return 0;
    where = inArray(
      repoAccess.repoId,
      db
        .select({ id: repos.id })
        .from(repos)
        .where(inArray(repos.githubRepoId, target.githubRepoIds)),
    );
  }
  const touched = await run(
    db
      .update(repoAccess)
      .set({ checkedAt: STALE })
      .where(and(where, sql`${repoAccess.checkedAt} > ${timeParam(STALE)}::timestamptz`))
      .returning({ repoId: repoAccess.repoId }),
  );
  return touched.length;
}

/**
 * Record that one person may do nothing in any repo of a workspace, as of `checkedAt`: what
 * holds while the App is not installed on it or is suspended, when Ponzu has no way to reach
 * its repos for anyone. Nothing replaces a newer answer.
 */
export async function recordNoRepoAccess(
  db: Db,
  { workspaceId, userId, checkedAt }: { workspaceId: string; userId: string; checkedAt: Date },
): Promise<void> {
  const ids = await run(
    db.select({ id: repos.id }).from(repos).where(eq(repos.workspaceId, workspaceId)),
  );
  await recordRepoAccess(
    db,
    ids.map(({ id }) => ({ userId, repoId: id, permission: "none", checkedAt })),
  );
}

/** A repo of a workspace, and what GitHub last said one person may do there. */
export interface WorkspaceRepoAccess {
  repoId: string;
  githubRepoId: number;
  fullName: string;
  /** Whether GitHub last said it is private. */
  private: boolean;
  /** Whether it holds a canvas. */
  hasCanvas: boolean;
  /** Null when nobody has asked GitHub about this person and repo yet. */
  permission: RepoPermission | null;
  checkedAt: Date | null;
}

/**
 * Every repo of a workspace, the App's removed ones too (a canvas may still be in one), with
 * what `userId` may do in each: every answer some reader of the workspace may act on.
 */
export function listWorkspaceRepoAccess(
  db: Db,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<WorkspaceRepoAccess[]> {
  return run(
    db
      .select({
        repoId: repos.id,
        githubRepoId: repos.githubRepoId,
        fullName: repos.fullName,
        private: repos.private,
        hasCanvas: exists(
          db.select({ one: sql`1` }).from(canvases).where(eq(canvases.repoId, repos.id)),
        ).mapWith(Boolean),
        permission: repoAccess.permission,
        checkedAt: repoAccess.checkedAt,
      })
      .from(repos)
      .leftJoin(repoAccess, and(eq(repoAccess.repoId, repos.id), eq(repoAccess.userId, userId)))
      .where(eq(repos.workspaceId, workspaceId)),
  );
}
