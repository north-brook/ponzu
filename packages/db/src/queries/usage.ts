import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { creditLedger, usageEvents } from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";

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
  const added = await db
    .insert(creditLedger)
    .values({ ...entry, id: newId("led") })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
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
  const [row] = await db
    .select({
      granted: sql`coalesce(sum(${delta}) filter (where ${reason} = 'grant'), 0)`.mapWith(Number),
      used: sql`coalesce(-sum(${delta}) filter (where ${reason} = 'use'), 0)`.mapWith(Number),
      balance: sql`coalesce(sum(${delta}), 0)`.mapWith(Number),
    })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.workspaceId, workspaceId), eq(creditLedger.periodStart, periodStart)),
    );
  return row!;
}
