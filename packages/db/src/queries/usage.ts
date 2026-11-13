import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { creditLedger } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * Use is recorded in `usage_events` alone (docs/cloud.md, "Billing"): awake time by the
 * sandbox's moves and the meter's cuts (`queries/sandboxes.ts`), model turns as runners report
 * them. The ledger holds what is not use: the members' free grants, support's adjustments and,
 * later, top-ups. Nothing writes a `use` row.
 */

/** What one of a runner's turns used of one model. */
export interface TurnModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicrousd: number;
}

/** One turn of a canvas's agent, as its runner reports it. */
export interface TurnUsage {
  /** Claude Code's id for the turn's result: what makes reporting it again change nothing. */
  id: string;
  at: Date;
  models: TurnModelUsage[];
}

/**
 * Record what a canvas's agent used, a usage event per turn and model, put down to the
 * canvas's workspace and owner, paid from the owner's own Claude plan (no credits), priced by
 * the rate card in effect. One statement. A turn recorded before changes nothing, and its id
 * is the canvas's own: another canvas's turn of the same id is another event. Answers how many
 * of the turns were new.
 */
export async function recordTurnUsage(
  db: Db,
  { canvasId, turns }: { canvasId: string; turns: TurnUsage[] },
): Promise<number> {
  const rows = turns.flatMap((turn) =>
    turn.models.map((usage) => ({
      ...usage,
      // A turn id is Claude Code's uuid and a canvas id has no slash, so the turn is the
      // second part of this, which is how the statement counts what was new.
      id: `${canvasId}/${turn.id}/${usage.model}`,
      at: timeParam(turn.at),
    })),
  );
  if (rows.length === 0) return 0;
  const result = await queryJson<{ turns: string[] }>(
    db,
    sql`
      with recorded as (
        insert into usage_events (
          id, workspace_id, canvas_id, user_id, kind, model, input_tokens, output_tokens,
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
          join canvases d on d.id = ${canvasId}
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
 * Add credits to a workspace's ledger. False when it is a grant that member already has for that
 * period: the allowance is given once.
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

/**
 * Adjust a workspace's free credits for the period that starts at `periodStart` by a whole
 * number of credits, with a note saying why: support's credit for an outage (positive), or a
 * correction (negative). It adds to, or takes from, the period's free credits, never below zero
 * (`billing/credits.ts`). Answers the ledger row's id.
 */
export async function adjustCredits(
  db: Db,
  {
    workspaceId,
    periodStart,
    credits,
    note,
  }: { workspaceId: string; periodStart: Date; credits: number; note: string },
): Promise<string> {
  if (!Number.isInteger(credits) || credits === 0) {
    throw new Error("An adjustment is a whole number of credits, and not zero.");
  }
  if (note.trim() === "") throw new Error("An adjustment says why, in its note.");
  const id = newId("led");
  await run(
    db.insert(creditLedger).values({
      id,
      workspaceId,
      delta: credits,
      reason: "adjustment",
      periodStart,
      note: note.trim(),
    }),
  );
  return id;
}
