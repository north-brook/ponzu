import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type GithubAccess, type MemberRole, memberships, users } from "../schema/index.ts";
import { queryJson } from "./json.ts";
import { run } from "./run.ts";

/** A member of a workspace as Settings lists them. */
export interface WorkspaceMember {
  userId: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  role: MemberRole;
  githubAccess: GithubAccess;
}

/** Everyone in a workspace, admins first, then by name. */
export function listWorkspaceMembers(db: Db, workspaceId: string): Promise<WorkspaceMember[]> {
  return run(
    db
      .select({
        userId: users.id,
        githubLogin: users.githubLogin,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        githubAccess: memberships.githubAccess,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(
        sql`${memberships.role} = 'admin' desc`,
        sql`lower(coalesce(${users.name}, ${users.githubLogin}))`,
        users.id,
      ),
  );
}

/** How many people are in each of these workspaces. A workspace with nobody in it is left out. */
export function countWorkspaceMembers(
  db: Db,
  workspaceIds: string[],
): Promise<{ workspaceId: string; members: number }[]> {
  if (workspaceIds.length === 0) return Promise.resolve([]);
  return run(
    db
      .select({ workspaceId: memberships.workspaceId, members: count() })
      .from(memberships)
      .where(inArray(memberships.workspaceId, workspaceIds))
      .groupBy(memberships.workspaceId),
  );
}

/** Whether anyone in the workspace is an admin. */
export async function workspaceHasAdmin(db: Db, workspaceId: string): Promise<boolean> {
  const admins = await run(
    db.$count(
      memberships,
      and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "admin")),
    ),
  );
  return admins > 0;
}

/**
 * Make someone an admin of a workspace that has none: the member of its organization who has
 * been in it longest. Someone who reaches it only through repos shared with them never is, so
 * a workspace whose owners and members have not signed in yet waits for one of them. Answers
 * who was made admin, or null when it already had one or nobody can be.
 *
 * Every sync calls this for each workspace it touches, so a workspace that lost its last
 * admin, or whose first members joined so close together that none saw the others, is put
 * right by the next sync of anyone in it. Joins that close can each make an admin; only ever
 * of a member of the organization.
 */
export async function ensureWorkspaceAdmin(db: Db, workspaceId: string): Promise<string | null> {
  const [promoted] = await run(
    db
      .update(memberships)
      .set({ role: "admin" })
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          sql`${memberships.userId} = (
            select heir.user_id from ${memberships} as heir
            where heir.workspace_id = ${workspaceId} and heir.github_access in ('owner', 'member')
            order by heir.created_at, heir.user_id
            limit 1
          )`,
          sql`not exists (
            select 1 from ${memberships} as admin
            where admin.workspace_id = ${workspaceId} and admin.role = 'admin'
          )`,
        ),
      )
      .returning({ userId: memberships.userId }),
  );
  return promoted?.userId ?? null;
}

export type SetRoleResult = "updated" | "not_member" | "last_admin" | "owner";

/**
 * Give a member a role, as an admin does in Settings. A sync never changes it afterwards.
 * Refused, changing nothing: demoting an owner of the account (`owner`; GitHub says they own
 * it, so they are always an admin) and demoting the workspace's last admin (`last_admin`).
 *
 * The admins are locked first, so two admins demoting each other at once cannot both succeed:
 * the second waits for the first, then sees it is the only admin left.
 */
export async function setMemberRole(
  db: Db,
  { workspaceId, userId, role }: { workspaceId: string; userId: string; role: MemberRole },
): Promise<SetRoleResult> {
  const result = await queryJson<{ member: boolean; owner: boolean; changed: boolean }>(
    db,
    sql`
      with admins as (
        select user_id from ${memberships}
        where workspace_id = ${workspaceId} and role = 'admin'
        for update
      ), target as (
        select github_access from ${memberships}
        where workspace_id = ${workspaceId} and user_id = ${userId}
      ), changed as (
        update ${memberships} set role = ${role}
        where workspace_id = ${workspaceId} and user_id = ${userId}
          and (${role}::text = 'admin' or (
            github_access <> 'owner'
            and (select count(*) from admins where user_id <> ${userId}) > 0
          ))
        returning 1
      )
      select json_build_object(
        'member', exists (select 1 from target),
        'owner', exists (select 1 from target where github_access = 'owner'),
        'changed', exists (select 1 from changed)
      ) as result`,
  );
  if (!result?.member) return "not_member";
  if (result.changed) return "updated";
  return result.owner ? "owner" : "last_admin";
}

/**
 * Drop one person's membership of the workspace an installation belongs to, for when GitHub
 * says they lost access and Ponzu cannot ask GitHub what they still reach. Answers the
 * workspace, or null when they were not in it.
 */
export async function removeMembership(
  db: Db,
  { installationId, userId }: { installationId: number; userId: string },
): Promise<string | null> {
  const result = await queryJson<{ workspaceId: string | null }>(
    db,
    sql`
      with dropped as (
        delete from ${memberships}
        where user_id = ${userId}
          and workspace_id = (select id from workspaces where installation_id = ${installationId})
        returning workspace_id
      )
      select json_build_object('workspaceId', (select workspace_id from dropped)) as result`,
  );
  return result?.workspaceId ?? null;
}

/**
 * Record the repos of a workspace one member reaches, as GitHub just listed them for that
 * person, by GitHub id with whether they can push. When the list is `complete`, any repo of
 * theirs not on it is dropped; a list GitHub cut short only adds.
 *
 * Only repos Ponzu already has for the workspace are recorded. Answers the GitHub ids it does
 * not have, which mean the workspace's own copy of its installation is behind.
 */
export async function setMemberRepos(
  db: Db,
  {
    workspaceId,
    userId,
    repos,
    complete,
  }: {
    workspaceId: string;
    userId: string;
    repos: { githubRepoId: number; canPush: boolean }[];
    complete: boolean;
  },
): Promise<{ missing: number[] }> {
  const seen = JSON.stringify(
    repos.map(({ githubRepoId, canPush }) => ({ github_repo_id: githubRepoId, can_push: canPush })),
  );
  const result = await queryJson<{ missing: number[] }>(
    db,
    sql`
      with seen as (
        select listed.github_repo_id, listed.can_push, repos.id as repo_id
        from json_to_recordset(${seen}::json) as listed(github_repo_id bigint, can_push boolean)
        left join repos
          on repos.github_repo_id = listed.github_repo_id and repos.workspace_id = ${workspaceId}
      ), linked as (
        insert into member_repos (workspace_id, user_id, repo_id, can_push)
        select distinct on (repo_id) ${workspaceId}, ${userId}, repo_id, can_push
        from seen where repo_id is not null
        on conflict (workspace_id, user_id, repo_id) do update set can_push = excluded.can_push
        returning repo_id
      ), unlinked as (
        delete from member_repos
        where ${complete}::boolean and workspace_id = ${workspaceId} and user_id = ${userId}
          and repo_id not in (select repo_id from seen where repo_id is not null)
        returning repo_id
      )
      select json_build_object(
        'missing',
        coalesce((select json_agg(github_repo_id) from seen where repo_id is null), '[]'::json)
      ) as result`,
  );
  return { missing: (result?.missing ?? []).map(Number) };
}
