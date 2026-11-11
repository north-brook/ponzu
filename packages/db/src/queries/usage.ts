import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { creditLedger, usageEvents } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

export type NewUsageEvent = {
  /** Chosen by whoever reports it, so reporting it again changes nothing. */
  id: string;
  workspaceId: string;
  designId: string | null;
  /** Who the usage is put down to. */
  userId: string | null;
  /** What it costs the workspace. Zero for a model turn on the person's own plan. */
  credits: number;
  /** What it cost us, or would have had Ponzu paid for the model. */
  costMicrousd: number;
  payer: "ponzu" | "own_plan";
  rateCardVersion: number;
  occurredAt: Date;
  /** The start of the workspace's billing period that `occurredAt` falls in. */
  periodStart: Date;
} & (
  | { kind: "sandbox"; seconds: number }
  | {
      kind: "model";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
);

/**
 * Record a usage event and, when it costs credits, take them from the workspace's ledger, in
 * one statement. False when the event was recorded before; then nothing is taken again.
 */
export async function recordUsage(
  db: Db,
  { periodStart, ...event }: NewUsageEvent,
): Promise<boolean> {
  const recorded = db
    .insert(usageEvents)
    .values(event)
    .onConflictDoNothing({ target: usageEvents.id })
    .returning();
  const result = await queryJson<{ recorded: boolean }>(
    db,
    sql`
      with recorded as (${recorded.getSQL()}),
      spent as (
        insert into credit_ledger (
          id, workspace_id, delta, reason, period_start, user_id, usage_event_id
        )
        select ${newId("led")}, r.workspace_id, -r.credits, 'use',
               ${timeParam(periodStart)}::timestamptz, r.user_id, r.id
          from recorded r
         where r.credits > 0
      )
      select json_build_object('recorded', exists (select 1 from recorded)) as result
    `,
  );
  return result?.recorded ?? false;
}

/** What one of a runner's turns used of one model. */
export interface TurnModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicrousd: number;
}

/** One turn of a design's agent, as its runner reports it. */
export interface TurnUsage {
  /** Claude Code's id for the turn's result: what makes reporting it again change nothing. */
  id: string;
  at: Date;
  models: TurnModelUsage[];
}

/**
 * Record what a design's agent used, a usage event per turn and model, put down to the
 * design's workspace and owner, paid from the owner's own Claude plan (no credits), priced by
 * the rate card in effect. One statement. A turn recorded before changes nothing, and its id
 * is the design's own: another design's turn of the same id is another event. Answers how many
 * of the turns were new.
 */
export async function recordTurnUsage(
  db: Db,
  { designId, turns }: { designId: string; turns: TurnUsage[] },
): Promise<number> {
  const rows = turns.flatMap((turn) =>
    turn.models.map((usage) => ({
      ...usage,
      // A turn id is Claude Code's uuid and a design id has no slash, so the turn is the
      // second part of this, which is how the statement counts what was new.
      id: `${designId}/${turn.id}/${usage.model}`,
      at: timeParam(turn.at),
    })),
  );
  if (rows.length === 0) return 0;
  const result = await queryJson<{ turns: string[] }>(
    db,
    sql`
      with recorded as (
        insert into usage_events (
          id, workspace_id, design_id, user_id, kind, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_microusd, credits, payer,
          rate_card_version, occurred_at
        )
        select u.id, d.workspace_id, d.id, d.owner_id, 'model', u.model, u."inputTokens",
               u."outputTokens", u."cacheReadTokens", u."cacheWriteTokens", u."costMicrousd", 0,
               'own_plan',
               -- The card in effect when it happened; the first one for a time before any.
               coalesce(
                 (select max(version) from rate_cards where effective_from <= u.at),
                 (select min(version) from rate_cards)
               ),
               u.at
          from json_to_recordset(${JSON.stringify(rows)}::json) as u(
                 id text, at timestamptz, model text, "inputTokens" bigint,
                 "outputTokens" bigint, "cacheReadTokens" bigint, "cacheWriteTokens" bigint,
                 "costMicrousd" bigint
               )
          join designs d on d.id = ${designId}
        on conflict (id) do nothing
        returning id
      )
      select json_build_object(
        'turns', coalesce((select json_agg(distinct split_part(id, '/', 2)) from recorded), '[]'::json)
      ) as result
    `,
  );
  return result?.turns.length ?? 0;
}

export interface NewLedgerEntry {
  workspaceId: string;
  /** Credits. Positive for everything but an adjustment, which may take credits away. */
  delta: number;
  reason: "grant" | "topup" | "refund" | "adjustment";
  periodStart: Date;
  /** For a grant, the member whose monthly allowance it is. */
  userId?: string | null;
  note?: string | null;
}

/**
 * Add credits to a workspace's ledger (use goes through `recordUsage`). False when it is a
 * grant that member already has for that period: the allowance is given once.
 */
export async function addLedgerEntry(db: Db, entry: NewLedgerEntry): Promise<boolean> {
  const added = await run(
    db
      .insert(creditLedger)
      .values({ ...entry, id: newId("led") })
      .onConflictDoNothing()
      .returning({ id: creditLedger.id }),
  );
  return added.length > 0;
}

export interface LedgerBalance {
  /** Free credits granted for the period. */
  granted: number;
  /** Credits used in the period. */
  used: number;
  /** Everything in the period added up: what is left when positive, what is owed when negative. */
  balance: number;
}

/** Where a workspace's credits stand for one billing period. Read it before every wake. */
export async function ledgerBalance(
  db: Db,
  { workspaceId, periodStart }: { workspaceId: string; periodStart: Date },
): Promise<LedgerBalance> {
  const { delta, reason } = creditLedger;
  const [row] = await run(
    db
      .select({
        granted: sql`coalesce(sum(${delta}) filter (where ${reason} = 'grant'), 0)`.mapWith(Number),
        used: sql`coalesce(-sum(${delta}) filter (where ${reason} = 'use'), 0)`.mapWith(Number),
        balance: sql`coalesce(sum(${delta}), 0)`.mapWith(Number),
      })
      .from(creditLedger)
      .where(
        and(eq(creditLedger.workspaceId, workspaceId), eq(creditLedger.periodStart, periodStart)),
      ),
  );
  return row!;
}
