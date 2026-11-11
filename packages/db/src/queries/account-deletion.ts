import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { users } from "../schema/index.ts";
import { queryJson } from "./json.ts";
import { run } from "./run.ts";

/*
 * Deleting a person's account (docs/cloud.md, "Deleting an account"). The API goes step by
 * step, each step safe to repeat, and deletes the person's row last: until then the person can
 * ask again, and once it is gone everything that hangs off it goes with it (sessions, GitHub
 * token, memberships, repo access, Claude account, devices, sign-ins), and what other people's
 * work points at forgets them (a design's owner, who wrote a thread item, who answered a
 * question, whom usage is put down to).
 */

/** How a person's deletion stands: what blocks it, and what happens to their designs. */
export interface AccountDeletionPlan {
  /**
   * Organizations the person is the only admin of while others are in them. Someone else must
   * be made an admin first, or the workspace would be left with none.
   */
  soleAdminOf: { id: string; name: string }[];
  /** Designs the person owns that are theirs alone: Scratch, and those in their own account. */
  deleted: string[];
  /** Designs the person owns in an organization's workspace, which stay with the team. */
  kept: string[];
}

/** The person's deletion as it would go now. */
export async function planAccountDeletion(db: Db, userId: string): Promise<AccountDeletionPlan> {
  const result = await queryJson<AccountDeletionPlan>(
    db,
    sql`
      with me as (select id, github_user_id from users where id = ${userId}),
      owned as (
        select d.id,
               (d.repo_id is null or w.github_account_id = (select github_user_id from me))
                 as theirs
          from designs d join workspaces w on w.id = d.workspace_id
         where d.owner_id = ${userId}
      )
      select json_build_object(
        'soleAdminOf', coalesce((
          select json_agg(json_build_object('id', w.id, 'name', w.name) order by w.name)
            from memberships m join workspaces w on w.id = m.workspace_id
           where m.user_id = ${userId} and m.role = 'admin' and w.kind = 'org'
             and not exists (select 1 from memberships o
                              where o.workspace_id = w.id and o.user_id <> ${userId}
                                and o.role = 'admin')
             and exists (select 1 from memberships o
                          where o.workspace_id = w.id and o.user_id <> ${userId})
        ), '[]'::json),
        'deleted', coalesce((select json_agg(id order by id) from owned where theirs), '[]'::json),
        'kept', coalesce((select json_agg(id order by id) from owned where not theirs), '[]'::json)
      ) as result
    `,
  );
  return result ?? { soleAdminOf: [], deleted: [], kept: [] };
}

/** How a deleted person is named in what stays: GitHub's own name for a deleted account. */
export const DELETED_PERSON = { name: "Deleted user", login: "ghost" } as const;

/**
 * Take the person's name, login and picture out of what other people still see: the thread
 * items they wrote or stopped a run in, and the actor of their ops in the design's history, in
 * every design of a workspace they are in or that they own. Their words stay, under
 * `DELETED_PERSON`. Safe to repeat. Answers how many rows it wrote.
 */
export async function anonymiseUser(db: Db, userId: string): Promise<number> {
  const ghost = JSON.stringify({ id: userId, ...DELETED_PERSON });
  const result = await queryJson<{ changed: number }>(
    db,
    sql`
      with theirs as (
        select d.id from designs d
         where d.owner_id = ${userId}
            or d.workspace_id in (select workspace_id from memberships where user_id = ${userId})
      ),
      items as (
        update thread_items t set payload = case
            when t.payload -> 'from' ->> 'id' = ${userId}
              then jsonb_set(t.payload, '{from}', ${ghost}::jsonb)
            else jsonb_set(t.payload, '{by}', ${ghost}::jsonb)
          end
         where t.design_id in (select id from theirs)
           and (t.payload -> 'from' ->> 'id' = ${userId} or t.payload -> 'by' ->> 'id' = ${userId})
        returning 1
      ),
      ops as (
        update design_ops o set actor_name = ${DELETED_PERSON.name}, actor_avatar_url = null
         where o.design_id in (select id from theirs)
           and o.actor_kind = 'user' and o.actor_id = ${userId}
        returning 1
      )
      select json_build_object(
        'changed', (select count(*) from items) + (select count(*) from ops)
      ) as result
    `,
  );
  return result?.changed ?? 0;
}

/**
 * Delete the person's row, and with it everything that is only theirs. Answers their WorkOS
 * user id, or null when they were already gone.
 */
export async function deleteUser(db: Db, userId: string): Promise<string | null> {
  const [deleted] = await run(
    db.delete(users).where(eq(users.id, userId)).returning({ workosUserId: users.workosUserId }),
  );
  return deleted?.workosUserId ?? null;
}
