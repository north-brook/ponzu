import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { type MemberRole, workspaces } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * What a workspace used in a billing period, read for Settings › Plan and usage (docs/cloud.md,
 * "Billing"). The arithmetic is the API's (`billing/credits.ts`): this reads the seconds and
 * credits it works on, by person, canvas and rate card, and the people and canvases they name.
 */

/** A rate card's numbers, as working out a period's usage needs them. */
export interface RateCardNumbers {
  version: number;
  /** What one credit sells for, in millionths of a dollar. */
  creditMicrousd: number;
  sandboxCreditsPerAwakeHour: number;
  freeCreditsPerMember: number;
  defaultCapCents: number;
  /** The share of the cap at which admins are warned (0.8 on rate card v1). */
  capWarningFraction: number;
}

/** What one person used in one canvas under one rate card, in a period. */
export interface UsageRow {
  /** Null for usage put down to nobody: a deleted account, or nobody behind the canvas's feed. */
  userId: string | null;
  /** Null once its canvas was deleted. */
  canvasId: string | null;
  rateCardVersion: number;
  /** Awake sandbox seconds, the stretch awake right now included. */
  seconds: number;
  /** Credits model turns cost; zero while every canvas runs on its owner's own plan. */
  modelCredits: number;
}

/** Someone a period's usage names: a member now, or someone whose use is in the period. */
export interface UsagePerson {
  id: string;
  name: string | null;
  githubLogin: string;
  avatarUrl: string | null;
  /** Their role, while they are a member. */
  role: MemberRole | null;
}

/** A canvas a period's usage names, and whether the viewer may know it exists. */
export interface UsageCanvas {
  id: string;
  name: string;
  /** In a repo GitHub lets the viewer read, as `repo_access` last said, or their own Scratch. */
  readable: boolean;
}

export interface WorkspaceUsageRead {
  /** The card in effect at `now`. */
  current: RateCardNumbers;
  /** Every card the period's usage was priced by, and the current one. */
  cards: RateCardNumbers[];
  /** The cap the workspace set, or null for the card's default. */
  monthlyCapCents: number | null;
  rows: UsageRow[];
  /** Everyone who is a member now, and everyone else whose use is counted in the period. */
  people: UsagePerson[];
  canvases: UsageCanvas[];
  /**
   * The period's free allowances granted so far (`credit_ledger`, `grant`): to whom, and how
   * many went to people whose account has since been deleted. A grant is never taken back, so
   * someone who leaves mid-period is still counted.
   */
  granted: { userIds: string[]; departed: number };
  /**
   * The period's `adjustment` rows added up, in whole credits: support's credits (positive) and
   * corrections (negative). They add to, or take from, the free credits. Zero without any.
   */
  adjustedCredits: number;
}

/** One rate card row `alias` as `RateCardNumbers`. */
const card = (alias: string) =>
  sql.raw(`json_build_object(
    'version', ${alias}.version,
    'creditMicrousd', ${alias}.credit_microusd,
    'sandboxCreditsPerAwakeHour', ${alias}.sandbox_credits_per_awake_hour,
    'freeCreditsPerMember', ${alias}.free_credits_per_member,
    'defaultCapCents', ${alias}.default_cap_cents,
    'capWarningFraction', ${alias}.cap_warning_fraction::float8)`);

/**
 * A workspace's usage in the period [`start`, `end`), as of `now`, in one read: awake time and
 * model turns by person, canvas and rate card, with the stretch awake right now counted up to
 * `now` under the card in effect, and the people and canvases that names. A stretch counts in
 * the period it began in, as its usage event is dated; the live one is counted no further than
 * `end`, so a past period read after its end never takes in time after it (a current period
 * ends after `now`, so this changes nothing there). With `membersBefore` (the close passes the
 * period's end), only members whose membership began before then are named, beside anyone whose
 * use is in the period. Null when there is no such workspace.
 */
export async function readWorkspaceUsage(
  db: Db,
  {
    workspaceId,
    viewerId,
    start,
    end,
    now,
    membersBefore,
  }: {
    workspaceId: string;
    viewerId: string;
    start: Date;
    end: Date;
    now: Date;
    membersBefore?: Date;
  },
): Promise<WorkspaceUsageRead | null> {
  const from = sql`${timeParam(start)}::timestamptz`;
  const until = sql`${timeParam(end)}::timestamptz`;
  const at = sql`${timeParam(now)}::timestamptz`;
  const joinedBefore = membersBefore
    ? sql`and m.created_at < ${timeParam(membersBefore)}::timestamptz`
    : sql``;
  return queryJson<WorkspaceUsageRead>(
    db,
    sql`
      with current_card as (
        select * from rate_cards
         where version = coalesce(
           (select max(version) from rate_cards where effective_from <= ${at}),
           (select min(version) from rate_cards))
      ),
      metered as (
        select e.user_id, e.canvas_id, e.rate_card_version,
               coalesce(e.seconds, 0)::bigint as seconds,
               case when e.kind = 'model' then e.credits else 0 end as model_credits
          from usage_events e
         where e.workspace_id = ${workspaceId}
           and e.occurred_at >= ${from} and e.occurred_at < ${until}
        union all
        select s.awake_user_id, d.id, (select version from current_card),
               greatest(0, round(extract(epoch from (least(${at}, ${until}) - s.awake_since))))::bigint,
               0
          from sandboxes s join canvases d on d.id = s.canvas_id
         where d.workspace_id = ${workspaceId} and s.state = 'awake'
           and s.awake_since >= ${from} and s.awake_since < ${until}
      ),
      grouped as (
        select user_id, canvas_id, rate_card_version,
               sum(seconds)::bigint as seconds, sum(model_credits) as model_credits
          from metered group by user_id, canvas_id, rate_card_version
      ),
      named as (
        select m.user_id, m.role from memberships m
         where m.workspace_id = ${workspaceId} ${joinedBefore}
        union
        select distinct g.user_id, null from grouped g
         where g.user_id is not null
           and not exists (select 1 from memberships m
                            where m.workspace_id = ${workspaceId} and m.user_id = g.user_id
                              ${joinedBefore})
      )
      select json_build_object(
        'current', (select ${card("c")} from current_card c),
        'cards', coalesce((select json_agg(${card("r")} order by r.version) from rate_cards r
                            where r.version in (select rate_card_version from grouped)
                               or r.version = (select version from current_card)), '[]'::json),
        'monthlyCapCents', w.monthly_cap_cents,
        'rows', coalesce((select json_agg(json_build_object(
                    'userId', g.user_id, 'canvasId', g.canvas_id,
                    'rateCardVersion', g.rate_card_version, 'seconds', g.seconds,
                    'modelCredits', g.model_credits)) from grouped g), '[]'::json),
        'people', coalesce((select json_agg(json_build_object(
                    'id', u.id, 'name', u.name, 'githubLogin', u.github_login,
                    'avatarUrl', u.avatar_url, 'role', n.role) order by u.id)
                    from named n join users u on u.id = n.user_id), '[]'::json),
        'canvases', coalesce((select json_agg(json_build_object(
                    'id', d.id, 'name', d.name,
                    'readable', case when d.repo_id is null then d.owner_id = ${viewerId}
                                     else exists (
                                       select 1 from repo_access a
                                        where a.repo_id = d.repo_id and a.user_id = ${viewerId}
                                          and a.permission in ('admin', 'write', 'read')) end))
                    from canvases d
                   where d.id in (select canvas_id from grouped)), '[]'::json),
        'granted', (select json_build_object(
                      'userIds', coalesce(json_agg(l.user_id order by l.user_id)
                                            filter (where l.user_id is not null), '[]'::json),
                      'departed', count(*) filter (where l.user_id is null))
                      from credit_ledger l
                     where l.workspace_id = w.id and l.reason = 'grant'
                       and l.period_start = ${from}),
        'adjustedCredits', (select coalesce(floor(sum(l.delta)), 0)::bigint
                              from credit_ledger l
                             where l.workspace_id = w.id and l.reason = 'adjustment'
                               and l.period_start = ${from})
      ) as result
        from workspaces w
       where w.id = ${workspaceId}
    `,
  );
}

/**
 * Grant each person their free allowance for the period that starts at `periodStart`, at the
 * rate card in effect at `now`, once: a grant they already have is left as it is
 * (`credit_ledger_grant_key`). Answers how many were granted now. A card that gives no free
 * credits grants nothing.
 */
export async function grantAllowances(
  db: Db,
  {
    workspaceId,
    periodStart,
    now,
    userIds,
  }: { workspaceId: string; periodStart: Date; now: Date; userIds: string[] },
): Promise<number> {
  if (userIds.length === 0) return 0;
  const grants = userIds.map((userId) => ({ id: newId("led"), user_id: userId }));
  const result = await queryJson<{ granted: number }>(
    db,
    sql`
      with card as (
        select free_credits_per_member as credits from rate_cards
         where version = coalesce(
           (select max(version) from rate_cards where effective_from <= ${timeParam(now)}::timestamptz),
           (select min(version) from rate_cards))
      ),
      granted as (
        insert into credit_ledger (id, workspace_id, delta, reason, period_start, user_id)
        select g.id, ${workspaceId}, card.credits, 'grant', ${timeParam(periodStart)}::timestamptz,
               g.user_id
          from json_to_recordset(${JSON.stringify(grants)}::json) as g(id text, user_id text)
               cross join card
         where card.credits > 0
        on conflict do nothing
        returning 1
      )
      select json_build_object('granted', (select count(*) from granted)) as result
    `,
  );
  return result?.granted ?? 0;
}

/** Set a workspace's monthly cap on what is billed, in cents. False when there is no workspace. */
export async function setMonthlyCap(
  db: Db,
  { workspaceId, capCents }: { workspaceId: string; capCents: number },
): Promise<boolean> {
  const set = await run(
    db
      .update(workspaces)
      .set({ monthlyCapCents: capCents })
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id }),
  );
  return set.length > 0;
}
