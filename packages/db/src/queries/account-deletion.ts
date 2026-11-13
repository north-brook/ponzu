import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { jobs } from "../schema/index.ts";
import type { HeldJob, RecordedJob } from "./canvas-files.ts";
import { queryJson, timeParam } from "./json.ts";

/*
 * Deleting a person's account (docs/cloud.md, "Deleting an account"). The API goes step by
 * step, each step safe to repeat, and deletes the person's row last: until then the person can
 * ask again, and once it is gone everything that hangs off it goes with it (sessions, GitHub
 * token, memberships, repo access, Claude account, devices, sign-ins), and what other people's
 * work points at forgets them (a canvas's owner, who wrote a thread item, who answered a
 * question, whom usage is put down to).
 */

/** How a person's deletion stands: what blocks it, and what happens to their canvases. */
export interface AccountDeletionPlan {
  /**
   * Workspaces, an organization's or their own account's, that the person is the only admin of
   * while others are in them. Someone else must be made an admin first, or the workspace would
   * be left with none.
   */
  soleAdminOf: { id: string; name: string }[];
  /**
   * Canvases the person owns that are theirs alone: Scratch, and those in a workspace nobody
   * else is in.
   */
  deleted: string[];
  /** Canvases the person owns in a workspace others are in, which stay with them. */
  kept: string[];
}

/**
 * The workspaces `userId` is an admin of where nobody else is, while somebody else is a member:
 * a statement's `sole_admin_of (workspace_id)`. `admins` is where it reads who is an admin:
 * `memberships` to look, or rows locked `for update` to act on what it finds.
 */
function soleAdminOf(userId: string, admins: SQL) {
  return sql`
    sole_admin_of as (
      select m.workspace_id from memberships m
       where m.user_id = ${userId} and m.role = 'admin'
         and not exists (select 1 from ${admins} a
                          where a.workspace_id = m.workspace_id and a.user_id <> ${userId}
                            and a.role = 'admin')
         and exists (select 1 from memberships o
                      where o.workspace_id = m.workspace_id and o.user_id <> ${userId})
    )`;
}

/** The person's deletion as it would go now. */
export async function planAccountDeletion(db: Db, userId: string): Promise<AccountDeletionPlan> {
  const result = await queryJson<AccountDeletionPlan>(
    db,
    sql`
      with ${soleAdminOf(userId, sql`memberships`)},
      owned as (
        select d.id,
               (d.repo_id is null or not exists (
                  select 1 from memberships o
                   where o.workspace_id = d.workspace_id and o.user_id <> ${userId})) as theirs
          from canvases d
         where d.owner_id = ${userId}
      )
      select json_build_object(
        'soleAdminOf', coalesce((
          select json_agg(json_build_object('id', w.id, 'name', w.name) order by w.name)
            from workspaces w where w.id in (select workspace_id from sole_admin_of)
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
 * items they wrote or stopped a run in, the actor of their ops in the canvas's history, and the
 * author of their search entries, in every canvas of a workspace they are in or that they own.
 * Their words stay, under
 * `DELETED_PERSON`. Safe to repeat. Answers how many rows it wrote.
 */
export async function anonymiseUser(db: Db, userId: string): Promise<number> {
  const ghost = JSON.stringify({ id: userId, ...DELETED_PERSON });
  const result = await queryJson<{ changed: number }>(
    db,
    sql`
      with theirs as (
        select d.id from canvases d
         where d.owner_id = ${userId}
            or d.workspace_id in (select workspace_id from memberships where user_id = ${userId})
      ),
      items as (
        update thread_items t set payload = case
            when t.payload -> 'from' ->> 'id' = ${userId}
              then jsonb_set(t.payload, '{from}', ${ghost}::jsonb)
            else jsonb_set(t.payload, '{by}', ${ghost}::jsonb)
          end
         where t.canvas_id in (select id from theirs)
           and (t.payload -> 'from' ->> 'id' = ${userId} or t.payload -> 'by' ->> 'id' = ${userId})
        returning 1
      ),
      ops as (
        update canvas_ops o set actor_name = ${DELETED_PERSON.name}, actor_avatar_url = null
         where o.canvas_id in (select id from theirs)
           and o.actor_kind = 'user' and o.actor_id = ${userId}
        returning 1
      ),
      -- Search keeps its own copy of the name each entry was written with (search_entries).
      entries as (
        update search_entries s set author_name = ${DELETED_PERSON.name}
         where s.canvas_id in (select id from theirs)
           and s.author_kind = 'user' and s.author_id = ${userId}
           and s.author_name is distinct from ${DELETED_PERSON.name}
        returning 1
      )
      select json_build_object(
        'changed', (select count(*) from items) + (select count(*) from ops)
          + (select count(*) from entries)
      ) as result
    `,
  );
  return result?.changed ?? 0;
}

export type DeleteUserResult =
  /** `job` is the forget job recorded with the deletion, or null if one was already waiting. */
  | { status: "deleted"; workosUserId: string; job: RecordedJob | null }
  | { status: "gone" }
  /** They are now the only admin of a workspace others are in: nothing was deleted. */
  | { status: "sole_admin" };

/**
 * Delete the person's row, and with it everything that is only theirs, unless that would leave
 * a workspace others are in without an admin. The check is in the same statement, on the
 * admins' rows locked: two admins deleting themselves at once cannot each see the other stay.
 *
 * In that same statement, record `job`, keyed by the user id, with `{ userId, workosUserId }`
 * as its payload: the job that forgets them outside Ponzu. Their WorkOS id goes with the row,
 * so the row is never gone without the job that still knows it. Nothing is recorded when
 * nothing is deleted.
 */
export async function deleteUser(db: Db, userId: string, job: HeldJob): Promise<DeleteUserResult> {
  const locked = job.lockedBy !== undefined;
  const result = await queryJson<{
    workosUserId: string | null;
    blocked: boolean;
    job: (Omit<RecordedJob, "maxAttempts"> & { max_attempts: number }) | null;
  }>(
    db,
    sql`
      with admins as (
        select workspace_id, user_id, role from memberships
         where role = 'admin'
           and workspace_id in (select workspace_id from memberships
                                 where user_id = ${userId} and role = 'admin')
           for update
      ),
      ${soleAdminOf(userId, sql`admins`)},
      deleted as (
        delete from users
         where id = ${userId} and not exists (select 1 from sole_admin_of)
        returning workos_user_id
      ),
      recorded as (
        insert into ${jobs} (id, kind, key, payload, run_at, max_attempts, locked_by, locked_at,
                             attempts)
        select ${newId("job")}, ${job.kind}, ${userId}::text,
               jsonb_build_object('userId', ${userId}::text, 'workosUserId', deleted.workos_user_id),
               ${timeParam(job.runAt)}::timestamptz, ${job.maxAttempts}::int,
               ${job.lockedBy ?? null}::text,
               ${locked ? sql`now()` : sql`null::timestamptz`},
               ${locked ? 1 : 0}::int
          from deleted
        on conflict (kind, key) where completed_at is null and failed_at is null do nothing
        returning id, kind, payload, attempts, max_attempts
      )
      select json_build_object(
        'workosUserId', (select workos_user_id from deleted),
        'blocked', exists (select 1 from sole_admin_of),
        'job', (select row_to_json(r) from recorded r)
      ) as result
    `,
  );
  if (result?.blocked) return { status: "sole_admin" };
  if (!result?.workosUserId) return { status: "gone" };
  const recorded = result.job;
  return {
    status: "deleted",
    workosUserId: result.workosUserId,
    job: recorded
      ? {
          id: recorded.id,
          kind: recorded.kind,
          payload: recorded.payload,
          attempts: recorded.attempts,
          maxAttempts: recorded.max_attempts,
        }
      : null,
  };
}
