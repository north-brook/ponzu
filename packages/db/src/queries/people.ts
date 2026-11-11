import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { GithubAccess, MemberRole, RepoPermission } from "../enums.ts";
import { queryJson, timeParam } from "./json.ts";

/*
 * `workspace_people`: everyone GitHub says can reach a workspace, whether or not they have
 * opened Ponzu, as the API last read it as the App. It is who is in the team; `memberships`
 * is still who has opened Ponzu there and their role, and `repo_access` what each may do.
 * Its `repo_permissions` is a display-only snapshot: it grants nothing, and for anyone with a
 * `repo_access` answer that answer wins.
 *
 * Who is shown whom follows what GitHub would show them (docs/cloud.md, "Identity and
 * access"): an organization's owners see everyone; its members see its owners and members, and
 * an outside collaborator only on a repo they can push to (only then does GitHub show a repo's
 * collaborators); an outside collaborator sees only themselves.
 */

/** Someone GitHub says can reach a workspace, as one read of it found them. */
export interface GithubPerson {
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  /**
   * How they reach it. Null when this read could not tell (an organization whose members it may
   * not list): what was known before stays, and someone new is taken for an outside
   * collaborator, who is shown to the fewest.
   */
  githubAccess: GithubAccess | null;
  /** What they may do in each repo this read found them in, by GitHub repo id. Never `none`. */
  repoPermissions: Record<string, Exclude<RepoPermission, "none">>;
}

/** One repo a read asked about, and whether its list of people came back whole. */
export interface PeopleRepoRead {
  githubRepoId: number;
  complete: boolean;
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
 * When each repo of a workspace was last asked who can reach it, by GitHub repo id; null for
 * one never asked. A read asks about those asked longest ago first.
 */
export async function listPeopleRepoReads(
  db: Db,
  workspaceId: string,
): Promise<{ githubRepoId: number; peopleReadAt: Date | null }[]> {
  const result = await queryJson<{ githubRepoId: number | string; peopleReadAt: string | null }[]>(
    db,
    sql`
      select coalesce(json_agg(json_build_object(
        'githubRepoId', github_repo_id, 'peopleReadAt', people_read_at
      )), '[]'::json) as result
      from repos where workspace_id = ${workspaceId}`,
  );
  return (result ?? []).map((row) => ({
    githubRepoId: Number(row.githubRepoId),
    peopleReadAt: row.peopleReadAt === null ? null : new Date(row.peopleReadAt),
  }));
}

/**
 * Keep one read of who can reach a workspace, made at `seenAt`, repo by repo. For each repo in
 * `reposRead` whose list came back whole, what it found replaces that repo's entry in
 * everyone's `repo_permissions`; a list cut short only adds. When `installedRepoIds` is known
 * (the installation's repo list came back whole), entries for repos no longer installed are
 * dropped. Anyone left reaching no repo is deleted. `complete` (every installed repo read whole
 * this time) is only kept for show.
 *
 * A read older than the one kept changes nothing, so a slow one cannot bring back someone a
 * later one saw leave. Answers whether it was kept.
 */
export async function recordWorkspacePeople(
  db: Db,
  {
    workspaceId,
    people,
    reposRead,
    installedRepoIds,
    complete,
    seenAt,
  }: {
    workspaceId: string;
    people: GithubPerson[];
    reposRead: PeopleRepoRead[];
    installedRepoIds: number[] | null;
    complete: boolean;
    seenAt: Date;
  },
): Promise<boolean> {
  const listed = JSON.stringify(
    people.flatMap((person) => {
      if (bestPermission(Object.values(person.repoPermissions)) === "none") return [];
      return [
        {
          github_user_id: person.githubUserId,
          github_login: person.githubLogin,
          name: person.name,
          avatar_url: person.avatarUrl,
          github_access: person.githubAccess,
          repo_permissions: person.repoPermissions,
        },
      ];
    }),
  );
  const asked = JSON.stringify(reposRead.map((repo) => String(repo.githubRepoId)));
  const whole = JSON.stringify(
    reposRead.filter((repo) => repo.complete).map((repo) => String(repo.githubRepoId)),
  );
  const installed = installedRepoIds === null ? null : JSON.stringify(installedRepoIds.map(String));
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
          github_access text, repo_permissions jsonb
        )
      ), kept as (
        select * from workspace_people where workspace_id in (select id from fresh)
      ), merged as (
        select
          coalesce(l.github_user_id, k.github_user_id) as github_user_id,
          coalesce(l.github_login, k.github_login) as github_login,
          case when l.github_user_id is null then k.name else l.name end as name,
          case when l.github_user_id is null then k.avatar_url else l.avatar_url end as avatar_url,
          coalesce(l.github_access, k.github_access, 'collaborator') as github_access,
          coalesce((
            select jsonb_object_agg(e.key, e.value) from jsonb_each(k.repo_permissions) as e
            where e.key not in (select json_array_elements_text(${whole}::json))
              and (${installed}::json is null
                or e.key in (select json_array_elements_text(${installed}::json)))
          ), '{}'::jsonb) || coalesce(l.repo_permissions, '{}'::jsonb) as repo_permissions,
          case when l.github_user_id is null then k.last_seen_at else ${at}::timestamptz end
            as last_seen_at
        from listed l full join kept k on k.github_user_id = l.github_user_id
      ), ranked as (
        select *, (
          select case
            when bool_or(value = 'admin') then 'admin'
            when bool_or(value = 'write') then 'write'
            when bool_or(value = 'read') then 'read'
          end
          from jsonb_each_text(repo_permissions)
        ) as permission
        from merged
      ), written as (
        insert into workspace_people (
          workspace_id, github_user_id, github_login, name, avatar_url, github_access,
          permission, repo_permissions, last_seen_at
        )
        select fresh.id, r.github_user_id, r.github_login, r.name, r.avatar_url,
          r.github_access, r.permission, r.repo_permissions, r.last_seen_at
        from ranked r cross join fresh
        where r.permission is not null
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
        where workspace_id in (select id from fresh)
          and github_user_id in (select github_user_id from ranked where permission is null)
        returning 1
      ), asked as (
        update repos set people_read_at = ${at}::timestamptz
        where workspace_id in (select id from fresh)
          and github_repo_id::text in (select json_array_elements_text(${asked}::json))
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
      ), unread as (
        update repos set people_read_at = null where workspace_id = ${workspaceId} returning 1
      ), marked as (
        update workspaces set people_synced_at = null, people_complete = false
        where id = ${workspaceId}
        returning 1
      )
      select json_build_object('gone', (select count(*) from gone)) as result`,
  );
}

/**
 * Everyone who can reach workspace `w` (an expression): the people GitHub said
 * (`workspace_people`) and everyone who has joined it in Ponzu, once each, matched by GitHub id.
 * Their login, name and avatar are the App's read where there is one, which is newer than what
 * a person's sign-in wrote; how they reach it is their own sync's answer once they have joined.
 */
const everyoneIn = (w: SQL) => sql`
  select
    coalesce(p.github_user_id, j.github_user_id) as github_user_id,
    coalesce(p.github_login, j.github_login) as github_login,
    coalesce(p.name, j.name) as name,
    coalesce(p.avatar_url, j.avatar_url) as avatar_url,
    coalesce(j.github_access, p.github_access) as github_access,
    j.user_id,
    j.role,
    p.repo_permissions
  from (
    select u.id as user_id, u.github_user_id, u.github_login, u.name, u.avatar_url,
      m.role, m.github_access
    from memberships m join users u on u.id = m.user_id
    where m.workspace_id = ${w}
  ) as j
  full join (select * from workspace_people where workspace_id = ${w}) as p
    on p.github_user_id = j.github_user_id`;

/** How `viewer` reaches workspace `w`: null when they have not joined it. */
const viewerAccess = (w: SQL, viewer: string) => sql`(
  select github_access from memberships where workspace_id = ${w} and user_id = ${viewer}
)`;

/**
 * Whether `viewer` is shown person `e` (a row of `everyoneIn(w)`), as GitHub would show them:
 * see the top of this file.
 */
const shownTo = (w: SQL, viewer: string) => sql`(
  case ${viewerAccess(w, viewer)}
    when 'owner' then true
    when 'member' then
      e.user_id is not distinct from ${viewer}
      or e.github_access in ('owner', 'member')
      or exists (
        select 1 from repos r
        join repo_access va on va.repo_id = r.id
        where r.workspace_id = ${w}
          and r.removed_at is null
          and va.user_id = ${viewer}
          and va.permission in ('admin', 'write')
          and (
            (e.repo_permissions ->> r.github_repo_id::text) is not null
            or exists (
              select 1 from repo_access xa
              where xa.user_id = e.user_id and xa.repo_id = r.id and xa.permission <> 'none'
            )
          )
      )
    else e.user_id is not distinct from ${viewer}
  end
)`;

/**
 * How many people `viewerUserId` is shown can reach each of these workspaces: as many as
 * `listWorkspacePeople` lists them. Null for a workspace that was never read: how many is not
 * known.
 */
export async function countWorkspacePeople(
  db: Db,
  { viewerUserId, workspaceIds }: { viewerUserId: string; workspaceIds: string[] },
): Promise<{ workspaceId: string; people: number | null }[]> {
  if (workspaceIds.length === 0) return [];
  const result = await queryJson<{ workspaceId: string; people: number | null }[]>(
    db,
    sql`
      select coalesce(json_agg(json_build_object(
        'workspaceId', w.id,
        'people', case when w.people_synced_at is null then null else (
          select count(*)::int from (${everyoneIn(sql`w.id`)}) as e
          where ${shownTo(sql`w.id`, viewerUserId)}
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

const PERSON_JSON = sql`json_build_object(
  'githubUserId', github_user_id, 'githubLogin', github_login, 'name', name,
  'avatarUrl', avatar_url, 'githubAccess', github_access, 'userId', user_id, 'role', role
)`;

/** Joined admins, joined members, then those who have not opened Ponzu; each by name. */
const PERSON_ORDER = sql`
  user_id is null, role = 'admin' desc, lower(coalesce(name, github_login)), github_user_id`;

/** Everyone who can reach a workspace that `viewerUserId` is shown. */
export async function listWorkspacePeople(
  db: Db,
  { workspaceId, viewerUserId }: { workspaceId: string; viewerUserId: string },
): Promise<WorkspacePerson[]> {
  const w = sql`${workspaceId}`;
  const result = await queryJson<WorkspacePerson[]>(
    db,
    sql`
      select coalesce(json_agg(${PERSON_JSON} order by ${PERSON_ORDER}), '[]'::json) as result
      from (${everyoneIn(w)}) as e
      where ${shownTo(w, viewerUserId)}`,
  );
  return (result ?? []).map(asPerson);
}

/** Someone with access to one repo, and the most GitHub lets them do there. */
export interface RepoPerson extends WorkspacePerson {
  permission: Exclude<RepoPermission, "none">;
}

/**
 * Everyone with access to one repo that `viewerUserId` is shown. What each may do there is
 * their own answer (`repo_access`) once they have joined and have one, and otherwise the App's
 * read of the repo. Shown as GitHub shows a repo's people: an owner of the account sees
 * everyone; a member sees its owners and members, and the repo's outside collaborators only if
 * they can push to it; an outside collaborator sees only themselves.
 */
export async function listRepoPeople(
  db: Db,
  {
    workspaceId,
    repoId,
    viewerUserId,
  }: { workspaceId: string; repoId: string; viewerUserId: string },
): Promise<RepoPerson[]> {
  const w = sql`${workspaceId}`;
  const result = await queryJson<RepoPerson[]>(
    db,
    sql`
      with repo as (
        select id, github_repo_id::text as key from repos
        where id = ${repoId} and workspace_id = ${workspaceId}
      ), viewer as (
        select ${viewerAccess(w, viewerUserId)} as access, (
          select permission from repo_access
          where user_id = ${viewerUserId} and repo_id = (select id from repo)
        ) as permission
      ), everyone as (
        select e.*,
          e.repo_permissions ->> (select key from repo) as listed,
          (select permission from repo_access ra
            where ra.user_id = e.user_id and ra.repo_id = (select id from repo)) as answered
        from (${everyoneIn(w)}) as e
      ), ranked as (
        select *, case
          when user_id is not null and answered is not null then answered
          else listed
        end as permission
        from everyone
      )
      select coalesce(json_agg(
        ${PERSON_JSON}::jsonb || jsonb_build_object('permission', permission)
        order by ${PERSON_ORDER}
      ), '[]'::json) as result
      from ranked
      where permission in ('admin', 'write', 'read')
        and exists (select 1 from repo)
        and case (select access from viewer)
          when 'owner' then true
          when 'member' then
            user_id is not distinct from ${viewerUserId}
            or github_access in ('owner', 'member')
            or (select permission from viewer) in ('admin', 'write')
          else user_id is not distinct from ${viewerUserId}
        end`,
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
