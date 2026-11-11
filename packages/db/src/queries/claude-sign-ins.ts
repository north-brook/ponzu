import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { authStates } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A Claude subscription sign-in is an auth state (`claude_sign_in`) with a utility sandbox of
 * its own, which Ponzu pays for. A person has one open at a time (a unique index), and starts
 * only so many an hour.
 */

/**
 * Open a sign-in for the person in place of any they had open, unless they have started
 * `perHour` in the hour before `now`. Answers its id, and the sandboxes of the sign-ins it
 * replaced, which are the caller's to destroy; null when they are at the limit, or another
 * start of theirs won at the same moment.
 */
export async function openClaudeSignIn(
  db: Db,
  {
    userId,
    now,
    expiresAt,
    perHour,
  }: { userId: string; now: Date; expiresAt: Date; perHour: number },
): Promise<{ id: string; replaced: string[] } | null> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const result = await queryJson<{ id: string | null; replaced: string[] }>(
    db,
    sql`
      with replaced as (
        update auth_states set consumed_at = ${at}
         where kind = 'claude_sign_in' and user_id = ${userId} and consumed_at is null
        returning payload ->> 'sandboxId' as sandbox_id
      ),
      made as (
        insert into auth_states (id, kind, user_id, payload, expires_at, created_at)
        select ${newId("auth")}, 'claude_sign_in', ${userId}, '{}'::jsonb,
               ${timeParam(expiresAt)}::timestamptz, ${at}
         -- Reading what it replaced first frees the one open sign-in the index allows.
         where (select count(*) from replaced) >= 0
           and (select count(*) from auth_states
                 where kind = 'claude_sign_in' and user_id = ${userId}
                   and created_at > ${at} - interval '1 hour') < ${perHour}
        on conflict do nothing
        returning id
      )
      select json_build_object(
        'id', (select id from made),
        'replaced', coalesce(
          (select json_agg(sandbox_id) from replaced where sandbox_id is not null), '[]'::json)
      ) as result
    `,
  );
  return result?.id ? { id: result.id, replaced: result.replaced } : null;
}

/**
 * Record the sandbox an open sign-in runs in. False when it is no longer open (a newer start
 * replaced it), and the sandbox is the caller's to destroy.
 */
export async function setClaudeSignInSandbox(
  db: Db,
  { id, sandboxId }: { id: string; sandboxId: string },
): Promise<boolean> {
  const rows = await run(
    db
      .update(authStates)
      .set({ payload: { sandboxId } })
      .where(
        and(
          eq(authStates.id, id),
          eq(authStates.kind, "claude_sign_in"),
          isNull(authStates.consumedAt),
        ),
      )
      .returning({ id: authStates.id }),
  );
  return rows.length > 0;
}
