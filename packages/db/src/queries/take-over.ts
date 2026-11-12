import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type Json, threadItems } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { scrubbed } from "./text.ts";

/*
 * Taking over a canvas whose owner is gone (docs/cloud.md, "Deleting an account" and "Whose
 * Claude runs it"). A canvas runs on its owner's Claude alone, and never switches accounts while
 * its owner is there. Once its owner has left the workspace, or deleted their account, nobody's
 * Claude runs it; a teammate who can change it and has Claude connected may then make it theirs.
 */

/** What a take-over came to. */
export type TakeOver =
  /** The canvas is the caller's now, on their Claude. `pending`: its feed holds work owed. */
  | { outcome: "taken"; pending: boolean }
  /**
   * Its owner is a member of its workspace, so it is not anyone else's to take. `lifted`: its
   * head still said the owner had left (they came back), and no longer does; `pending` is then
   * whether its feed holds work owed, for a wake on the owner's Claude.
   */
  | { outcome: "not_ownerless"; lifted: boolean; pending: boolean }
  /** The caller has no Claude that could run it: none connected, or its sign-in ran out. */
  | { outcome: "claude_not_connected" };

/**
 * Make the canvas the caller's, in one statement, when its owner is gone: `owner_id` and
 * `claude_account_id` become the caller's and their connected account's, a blocker about Claude
 * on its head is lifted, and the thread gets `notice` (under `noticeId`) saying so. It holds on
 * the owner still being gone and the caller's account still connected as the statement runs, so
 * a take-over racing the owner's return, or the caller disconnecting Claude, either happens
 * whole or not at all. Of two teammates taking it at once, the second finds the first its owner
 * by then, and is refused.
 */
export async function takeOverCanvas(
  db: Db,
  {
    canvasId,
    userId,
    noticeId,
    notice,
    now,
  }: { canvasId: string; userId: string; noticeId: string; notice: Json; now: Date },
): Promise<TakeOver | null> {
  // Whether the canvas `d`'s owner is still a member of its workspace: an owner who left, or
  // whose account was deleted (`owner_id` null), is not.
  const ownerMember = sql`exists (
    select 1 from memberships m where m.user_id = d.owner_id and m.workspace_id = d.workspace_id)`;
  // Something in the feed its agent must take up, which no runner has.
  const pending = sql`exists (
    select 1 from events e
     where e.canvas_id = d.id and e.delivered_at is null and e.priority in ('now', 'next'))`;
  const result = await queryJson<{
    found: boolean;
    owner_member: boolean;
    account: boolean;
    taken: boolean;
    lifted: boolean;
    pending: boolean;
  }>(
    db,
    sql`
      with canvas as (
        select d.id, d.owner_id, ${ownerMember} as owner_member, ${pending} as pending
          from canvases d where d.id = ${canvasId}
      ),
      account as (
        select a.id from claude_accounts a
         where a.user_id = ${userId} and a.status = 'connected'
           and a.encrypted_credential is not null
           and (a.expires_at is null or a.expires_at > ${timeParam(now)}::timestamptz)
      ),
      taken as (
        update canvases d
           set owner_id = ${userId},
               claude_account_id = (select id from account),
               -- What waited on the last owner's Claude; a wait on anything else stays.
               agent_blocker = case when left(d.agent_blocker, 7) = 'claude_' then null
                                    else d.agent_blocker end,
               agent_blocked_until = case when left(d.agent_blocker, 7) = 'claude_' then null
                                          else d.agent_blocked_until end,
               updated_at = now()
         where d.id = ${canvasId}
           and not (select owner_member from canvas)
           -- Still the owner it was read with. A take-over that commits while this one waits
           -- on the row changes it, and the row as it is then is checked again here. (Asked of
           -- the row itself: Postgres checks a waiting update's join to memberships against
           -- the row it found at the start, so that alone would let both take it.)
           and d.owner_id is not distinct from (select owner_id from canvas)
           and exists (select 1 from account)
        returning d.id
      ),
      noticed as (
        insert into ${threadItems} (id, canvas_id, kind, payload)
        select ${noticeId}, taken.id, 'notice', ${JSON.stringify(scrubbed(notice))}::jsonb
          from taken
        on conflict (canvas_id, id) do nothing
      ),
      -- The owner came back while the head still said they had left: it runs on their Claude.
      lifted as (
        update canvases d
           set agent_blocker = null, agent_blocked_until = null, updated_at = now()
         where d.id = ${canvasId} and d.agent_blocker = 'claude_owner_left'
           and (select owner_member from canvas)
        returning d.id
      )
      select json_build_object(
        'found', exists (select 1 from canvas),
        'owner_member', coalesce((select owner_member from canvas), false),
        'account', exists (select 1 from account),
        'taken', exists (select 1 from taken),
        'lifted', exists (select 1 from lifted),
        'pending', coalesce((select pending from canvas), false)
      ) as result
    `,
  );
  if (!result?.found) return null;
  if (result.taken) return { outcome: "taken", pending: result.pending };
  // Not taken, though the owner was gone and the account there as the statement began: a
  // teammate took it first, and the update found them its owner when it waited on the row.
  if (result.owner_member || result.account) {
    return { outcome: "not_ownerless", lifted: result.lifted, pending: result.pending };
  }
  return { outcome: "claude_not_connected" };
}
