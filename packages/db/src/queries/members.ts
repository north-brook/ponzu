import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type MemberRole, memberships, users } from "../schema/index.ts";
import { queryJson } from "./json.ts";
import { run } from "./run.ts";

/** A member of a workspace as Settings lists them. */
export interface WorkspaceMember {
  userId: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  role: MemberRole;
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

export type SetRoleResult = "updated" | "not_member" | "last_admin";

/**
 * Give a member a role, as an admin does in Settings. A sync never changes it afterwards.
 * Demoting the workspace's last admin is refused (`last_admin`) and changes nothing.
 *
 * The admins are locked first, so two admins demoting each other at once cannot both succeed:
 * the second waits for the first, then sees it is the only admin left.
 */
export async function setMemberRole(
  db: Db,
  { workspaceId, userId, role }: { workspaceId: string; userId: string; role: MemberRole },
): Promise<SetRoleResult> {
  const result = await queryJson<{ member: boolean; changed: boolean }>(
    db,
    sql`
      with admins as (
        select user_id from ${memberships}
        where workspace_id = ${workspaceId} and role = 'admin'
        for update
      ), changed as (
        update ${memberships} set role = ${role}
        where workspace_id = ${workspaceId} and user_id = ${userId}
          and (${role}::text = 'admin' or (select count(*) from admins where user_id <> ${userId}) > 0)
        returning 1
      )
      select json_build_object(
        'member', exists (
          select 1 from ${memberships} where workspace_id = ${workspaceId} and user_id = ${userId}
        ),
        'changed', exists (select 1 from changed)
      ) as result`,
  );
  if (!result?.member) return "not_member";
  return result.changed ? "updated" : "last_admin";
}
