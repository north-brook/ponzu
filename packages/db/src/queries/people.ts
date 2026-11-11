import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { GithubAccess, MemberRole, RepoPermission } from "../enums.ts";
import { queryJson, timeParam } from "./json.ts";

/*
 * `workspace_people`: everyone GitHub says can reach a workspace, whether or not they have
 * opened Ponzu, as the API last read it as the App. It is who is in the team; `memberships`
 * is still who has opened Ponzu there and their role, and `repo_access` what each may do.
 */

/** Someone GitHub says can reach a workspace, as one read of it found them. */
export interface GithubPerson {
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  githubAccess: GithubAccess;
  /** What they may do in each repo of it they reach, by GitHub repo id. Never `none`. */
  repoPermissions: Record<string, Exclude<RepoPermission, "none">>;
}

/** Strongest first. */
const STRENGTH: RepoPermission[] = ["admin", "write", "read", "none"];

/** The most any of `permissions` allows. */
export function bestPermission(permissions: Iterable<RepoPermission>): RepoPermission {
  let best: RepoPermission = "none";
  for (const permission of permissions) {
    if (STRENGTH.indexOf(permission) < STRENGTH.indexOf(best)) best = permission;
  }
  return best;
}

/**
 * Keep one read of who can reach a workspace, made at `seenAt`. Everyone in it is written; when
 * the read was `complete`, everyone it did not find is deleted, and when it was cut short they
 * stay as last seen. A read older than the one kept already changes nothing, so a slow one
 * cannot bring back someone a later one saw leave. Answers whether it was kept.
 */
export async function recordWorkspacePeople(
  db: Db,
  {
    workspaceId,
    people,
    complete,
    seenAt,
  }: { workspaceId: string; people: GithubPerson[]; complete: boolean; seenAt: Date },
): Promise<boolean> {
  const listed = JSON.stringify(
    people.flatMap((person) => {
      const permission = bestPermission(Object.values(person.repoPermissions));
      if (permission === "none") return [];
      return [
        {
          github_user_id: person.githubUserId,
          github_login: person.githubLogin,
          name: person.name,
          avatar_url: person.avatarUrl,
          github_access: person.githubAccess,
          permission,
          repo_permissions: person.repoPermissions,
        },
      ];
    }),
  );
  const at = timeParam(seenAt);
  const result = await queryJson<{ kept: boolean }>(
    db,
    sql`
      with fresh as (
        select id from workspaces
        where id = ${workspaceId}
          and (people_synced_at is null or people_synced_at <= ${at}::timestamptz)
      ), listed as (
        select * from json_to_recordset(${listed}::json) as listed(
          github_user_id bigint, github_login text, name text, avatar_url text,
          github_access text, permission text, repo_permissions jsonb
        )
      ), written as (
        insert into workspace_people (
          workspace_id, github_user_id, github_login, name, avatar_url, github_access,
          permission, repo_permissions, last_seen_at
        )
        select fresh.id, listed.github_user_id, listed.github_login, listed.name,
          listed.avatar_url, listed.github_access, listed.permission, listed.repo_permissions,
          ${at}::timestamptz
        from listed cross join fresh
        on conflict (workspace_id, github_user_id) do update set
          github_login = excluded.github_login,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          github_access = excluded.github_access,
          permission = excluded.permission,
          repo_permissions = excluded.repo_permissions,
          last_seen_at = excluded.last_seen_at
        returning 1
      ), gone as (
        delete from workspace_people
        where ${complete}::boolean
          and workspace_id in (select id from fresh)
          and github_user_id not in (select github_user_id from listed)
        returning 1
      ), marked as (
        update workspaces set people_synced_at = ${at}::timestamptz, people_complete = ${complete}
        where id in (select id from fresh)
        returning 1
      )
      select json_build_object('kept', exists (select 1 from marked)) as result`,
  );
  return result?.kept ?? false;
}

/**
 * Forget who could reach a workspace, for when nobody can any more: the App was uninstalled.
 * Its count is unknown again until the App is back and read.
 */
export async function forgetWorkspacePeople(db: Db, workspaceId: string): Promise<void> {
  await queryJson(
    db,
    sql`
      with gone as (
        delete from workspace_people where workspace_id = ${workspaceId} returning 1
      ), marked as (
        update workspaces set people_synced_at = null, people_complete = false
        where id = ${workspaceId}
        returning 1
      )
      select json_build_object('gone', (select count(*) from gone)) as result`,
  );
}

/**
 * How many people can reach each of these workspaces: everyone GitHub said, and anyone who has
 * opened Ponzu there that the last read had not found yet. Null for a workspace that was never
 * read: how many is not known.
 */
export async function countWorkspacePeople(
  db: Db,
  workspaceIds: string[],
): Promise<{ workspaceId: string; people: number | null }[]> {
  if (workspaceIds.length === 0) return [];
  const result = await queryJson<{ workspaceId: string; people: number | null }[]>(
    db,
    sql`
      select coalesce(json_agg(json_build_object(
        'workspaceId', w.id,
        'people', case when w.people_synced_at is null then null else (
          select count(*)::int from (
            select github_user_id from workspace_people where workspace_id = w.id
            union
            select u.github_user_id from memberships m join users u on u.id = m.user_id
            where m.workspace_id = w.id
          ) as everyone
        ) end
      )), '[]'::json) as result
      from workspaces w
      where w.id in (select json_array_elements_text(${JSON.stringify(workspaceIds)}::json))`,
  );
  return result ?? [];
}

/** Someone who can reach a workspace, as Settings › Members and Share list them. */
export interface WorkspacePerson {
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  githubAccess: GithubAccess;
  /** Their Ponzu user, once they have opened Ponzu and joined the workspace. */
  userId: string | null;
  /** Their role in Ponzu, once they have joined. */
  role: MemberRole | null;
}

/** A person's columns, preferring what Ponzu has of someone who has joined. */
const PERSON_COLUMNS = sql`
  coalesce(j.github_user_id, p.github_user_id) as github_user_id,
  coalesce(j.github_login, p.github_login) as github_login,
  coalesce(j.name, p.name) as name,
  coalesce(j.avatar_url, p.avatar_url) as avatar_url,
  coalesce(j.github_access, p.github_access) as github_access,
  j.user_id,
  j.role`;

/** Who has joined a workspace in Ponzu: their membership and their user. */
const joinedIn = (workspaceId: string) => sql`
  select u.id as user_id, u.github_user_id, u.github_login, u.name, u.avatar_url,
    m.role, m.github_access
  from memberships m join users u on u.id = m.user_id
  where m.workspace_id = ${workspaceId}`;

const PERSON_JSON = sql`json_build_object(
  'githubUserId', github_user_id, 'githubLogin', github_login, 'name', name,
  'avatarUrl', avatar_url, 'githubAccess', github_access, 'userId', user_id, 'role', role
)`;

/** Joined admins, joined members, then those who have not opened Ponzu; each by name. */
const PERSON_ORDER = sql`
  user_id is null, role = 'admin' desc, lower(coalesce(name, github_login)), github_user_id`;

/**
 * Everyone who can reach a workspace: the people GitHub said (`workspace_people`) and everyone
 * who has joined it in Ponzu, once each, matched by GitHub id.
 */
export async function listWorkspacePeople(db: Db, workspaceId: string): Promise<WorkspacePerson[]> {
  const result = await queryJson<WorkspacePerson[]>(
    db,
    sql`
      select coalesce(json_agg(${PERSON_JSON} order by ${PERSON_ORDER}), '[]'::json) as result
      from (
        select ${PERSON_COLUMNS}
        from (${joinedIn(workspaceId)}) as j
        full join (select * from workspace_people where workspace_id = ${workspaceId}) as p
          on p.github_user_id = j.github_user_id
      ) as everyone`,
  );
  return (result ?? []).map(asPerson);
}

/** Someone with access to one repo, and the most GitHub lets them do there. */
export interface RepoPerson extends WorkspacePerson {
  permission: Exclude<RepoPermission, "none">;
}

/**
 * Everyone with access to one repo: those GitHub said can reach it (`workspace_people`), and
 * those who have joined its workspace whose own answer (`repo_access`) lets them read it.
 * Where both say, the more recent read of the two is not known, so the more generous is shown.
 */
export async function listRepoPeople(
  db: Db,
  { workspaceId, repoId }: { workspaceId: string; repoId: string },
): Promise<RepoPerson[]> {
  const result = await queryJson<RepoPerson[]>(
    db,
    sql`
      with repo as (
        select id, github_repo_id::text as key from repos
        where id = ${repoId} and workspace_id = ${workspaceId}
      ), everyone as (
        select ${PERSON_COLUMNS},
          p.repo_permissions ->> (select key from repo) as listed,
          (select permission from repo_access ra
            where ra.user_id = j.user_id and ra.repo_id = (select id from repo)) as answered
        from (${joinedIn(workspaceId)}) as j
        full join (select * from workspace_people where workspace_id = ${workspaceId}) as p
          on p.github_user_id = j.github_user_id
      ), ranked as (
        select *, case
          when 'admin' in (listed, answered) then 'admin'
          when 'write' in (listed, answered) then 'write'
          when 'read' in (listed, answered) then 'read'
        end as permission
        from everyone
      )
      select coalesce(json_agg(
        ${PERSON_JSON}::jsonb || jsonb_build_object('permission', permission)
        order by ${PERSON_ORDER}
      ), '[]'::json) as result
      from ranked
      where permission is not null and exists (select 1 from repo)`,
  );
  return (result ?? []).map((person) => ({ ...asPerson(person), permission: person.permission }));
}

/** A row as json hands it back: a bigint may arrive as text. */
function asPerson(person: WorkspacePerson): WorkspacePerson {
  return {
    githubUserId: Number(person.githubUserId),
    githubLogin: person.githubLogin,
    name: person.name,
    avatarUrl: person.avatarUrl,
    githubAccess: person.githubAccess,
    userId: person.userId,
    role: person.role,
  };
}
