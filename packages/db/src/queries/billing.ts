import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type BillingGateValue,
  billingPeriods,
  type CardSetupOutcome,
  canvases,
  workspaces,
} from "../schema/index.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * The rows billing writes (docs/cloud.md, "Billing"): a workspace's Stripe customer, card and
 * cached gate, the card setups that go through Stripe's Checkout page, and the closed periods.
 * Each is one statement: Neon's HTTP driver has no transactions. Nothing here calls Stripe, and
 * nothing calls these while PONZU_BILLING is off.
 */

// --- the customer and the card --------------------------------------------------------------------

/**
 * Store the workspace's Stripe customer, unless it already has one. Two first card setups at once
 * each make a customer at Stripe; the first to store its id wins and the other is told the winner's
 * (`stored: false`), so a workspace never has two. Null when there is no workspace.
 */
export async function setCustomer(
  db: Db,
  { workspaceId, customerId }: { workspaceId: string; customerId: string },
): Promise<{ customerId: string; stored: boolean } | null> {
  // Locked first, so a store that waited on another reads the id that one stored (a plain read in
  // this statement would see the row as it was when the statement began, with no id).
  return queryJson<{ customerId: string; stored: boolean }>(
    db,
    sql`
      with locked as (
        select id, stripe_customer_id from workspaces where id = ${workspaceId} for update
      ),
      stored as (
        update workspaces w set stripe_customer_id = ${customerId}, updated_at = now()
          from locked where w.id = locked.id and locked.stripe_customer_id is null
        returning w.stripe_customer_id
      )
      select case
        when exists (select 1 from stored)
          then json_build_object('customerId', (select stripe_customer_id from stored), 'stored', true)
        when exists (select 1 from locked)
          then json_build_object('customerId', (select stripe_customer_id from locked), 'stored', false)
      end as result
    `,
  );
}

export type CardBrand = "visa" | "mastercard" | "amex" | "other";

/** Record the card Stripe now charges the workspace. False when there is no workspace. */
export async function setCard(
  db: Db,
  {
    workspaceId,
    paymentMethodId,
    brand,
    last4,
    addedByUserId,
    at,
  }: {
    workspaceId: string;
    paymentMethodId: string;
    brand: CardBrand;
    last4: string | null;
    /** Who added it, or null when it came from Stripe's portal or a webhook. */
    addedByUserId: string | null;
    at: Date;
  },
): Promise<boolean> {
  const rows = await run(
    db
      .update(workspaces)
      .set({
        stripePaymentMethodId: paymentMethodId,
        cardBrand: brand,
        cardLast4: last4,
        // The first time this card is recorded counts as when it was added.
        cardAddedAt: sql`case when ${workspaces.stripePaymentMethodId} is not distinct from ${paymentMethodId} then coalesce(${workspaces.cardAddedAt}, ${timeParam(at)}::timestamptz) else ${timeParam(at)}::timestamptz end`,
        cardAddedByUserId: sql`case when ${workspaces.stripePaymentMethodId} is not distinct from ${paymentMethodId} then coalesce(${workspaces.cardAddedByUserId}, ${addedByUserId}::text) else ${addedByUserId}::text end`,
      })
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

/**
 * Forget the workspace's card: Stripe says the customer has no default payment method any more.
 * Given `paymentMethodId`, only that card is forgotten, so a late word about an old card leaves a
 * newer one alone. Answers whether a card was forgotten.
 */
export async function clearCard(
  db: Db,
  { workspaceId, paymentMethodId }: { workspaceId: string; paymentMethodId?: string },
): Promise<boolean> {
  const rows = await run(
    db
      .update(workspaces)
      .set({
        stripePaymentMethodId: null,
        cardBrand: null,
        cardLast4: null,
        cardAddedAt: null,
        cardAddedByUserId: null,
      })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          paymentMethodId === undefined
            ? or(isNotNull(workspaces.stripePaymentMethodId), isNotNull(workspaces.cardLast4))
            : eq(workspaces.stripePaymentMethodId, paymentMethodId),
        ),
      )
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

// --- the cached gate ------------------------------------------------------------------------------

/**
 * Store the workspace's billing gate as just worked out, and answer what it was before, so the
 * caller can tell a change (and ping about it) from a gate that stayed. Null when there is no
 * workspace.
 */
export async function setBillingGate(
  db: Db,
  { workspaceId, gate, at }: { workspaceId: string; gate: BillingGateValue; at: Date },
): Promise<{ before: BillingGateValue; after: BillingGateValue } | null> {
  // `before` reads the row as it was, locked, so two refreshes at once each see the other's write.
  return queryJson<{ before: BillingGateValue; after: BillingGateValue }>(
    db,
    sql`
      with was as (
        select id, billing_gate from workspaces where id = ${workspaceId} for update
      ),
      now_is as (
        update workspaces w set billing_gate = ${gate}, billing_gate_at = ${timeParam(at)}::timestamptz
          from was where w.id = was.id
        returning was.billing_gate as gate_before, w.billing_gate as gate_after
      )
      select json_build_object('before', gate_before, 'after', gate_after) as result from now_is
    `,
  );
}

/**
 * The workspaces whose gate the minute's sweep works out again, at most `limit`, those worked out
 * longest ago (or never) first: every workspace with a sandbox waking or awake, or one that moved
 * since `since` (a sleep just metered its stretch), and every workspace whose gate is not `ok`,
 * so that one held back with nothing awake is let go once its period turns over or its free
 * credits grow, within a minute.
 */
export async function listWorkspacesToGate(
  db: Db,
  { since, limit }: { since: Date; limit: number },
): Promise<string[]> {
  const result = await queryJson<{ ids: string[] }>(
    db,
    sql`
      select json_build_object('ids', coalesce(json_agg(id), '[]'::json)) as result
        from (
          select w.id from workspaces w
           where w.billing_gate <> 'ok'
              or exists (
                select 1 from sandboxes s join canvases d on d.id = s.canvas_id
                 where d.workspace_id = w.id
                   and (s.state in ('waking', 'awake')
                        or s.state_at >= ${timeParam(since)}::timestamptz))
           order by w.billing_gate_at asc nulls first, w.id
           limit ${limit}
        ) due
    `,
  );
  return result?.ids ?? [];
}

/** The cached billing gate of the canvas's workspace; null when there is no such canvas. */
export async function canvasBillingGate(
  db: Db,
  canvasId: string,
): Promise<BillingGateValue | null> {
  const [row] = await run(
    db
      .select({ gate: workspaces.billingGate })
      .from(canvases)
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .where(eq(canvases.id, canvasId))
      .limit(1),
  );
  return row?.gate ?? null;
}

/** The cached billing gates of these workspaces, by id. */
export async function billingGatesOf(
  db: Db,
  workspaceIds: readonly string[],
): Promise<Map<string, BillingGateValue>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = await run(
    db
      .select({ id: workspaces.id, gate: workspaces.billingGate })
      .from(workspaces)
      .where(inArray(workspaces.id, [...workspaceIds])),
  );
  return new Map(rows.map((row) => [row.id, row.gate]));
}

// --- card setups ----------------------------------------------------------------------------------

/**
 * What a card setup's auth state keeps (`auth_states.payload`, kind `card_setup`): the workspace,
 * the cap the admin chose with the card, which app scheme the return page opens, the Checkout
 * session once Stripe made it, and how it ended.
 */
export interface CardSetupPayload {
  workspaceId: string;
  capCents: number;
  scheme: "ponzu" | "ponzu-dev" | "ponzu-preview" | "none";
  checkoutSessionId: string | null;
  outcome: CardSetupOutcome | null;
  settledAt: string | null;
}

export interface CardSetup {
  id: string;
  userId: string;
  payload: CardSetupPayload;
  expiresAt: Date;
  /** When it stopped being the workspace's open setup: settled, or replaced by a newer one. */
  consumedAt: Date | null;
  createdAt: Date;
}

/**
 * Open a card setup for the workspace in place of any it had open (one at a time, by a unique
 * index). Answers its id and the ids of the setups it replaced. Null when another start for the
 * same workspace won at the same moment.
 */
export async function beginCardSetup(
  db: Db,
  {
    userId,
    workspaceId,
    capCents,
    scheme,
    now,
    expiresAt,
  }: {
    userId: string;
    workspaceId: string;
    capCents: number;
    scheme: CardSetupPayload["scheme"];
    now: Date;
    expiresAt: Date;
  },
): Promise<{ id: string; replaced: string[] } | null> {
  const payload: CardSetupPayload = {
    workspaceId,
    capCents,
    scheme,
    checkoutSessionId: null,
    outcome: null,
    settledAt: null,
  };
  const at = sql`${timeParam(now)}::timestamptz`;
  const result = await queryJson<{ id: string | null; replaced: string[] }>(
    db,
    sql`
      with replaced as (
        update auth_states set consumed_at = ${at}
         where kind = 'card_setup' and payload ->> 'workspaceId' = ${workspaceId}
           and consumed_at is null
        returning id
      ),
      made as (
        insert into auth_states (id, kind, user_id, payload, expires_at, created_at)
        select ${newId("auth")}, 'card_setup', ${userId}, ${JSON.stringify(payload)}::jsonb,
               ${timeParam(expiresAt)}::timestamptz, ${at}
         -- Reading what it replaced first frees the one open setup the index allows.
         where (select count(*) from replaced) >= 0
        on conflict do nothing
        returning id
      )
      select json_build_object(
        'id', (select id from made),
        'replaced', coalesce((select json_agg(id) from replaced), '[]'::json)
      ) as result
    `,
  );
  return result?.id ? { id: result.id, replaced: result.replaced } : null;
}

/**
 * Record the Checkout session Stripe made for an open card setup. False when it is no longer
 * open (a newer setup replaced it, or it was settled).
 */
export async function setCardSetupSession(
  db: Db,
  { id, sessionId }: { id: string; sessionId: string },
): Promise<boolean> {
  const result = await queryJson<{ updated: number }>(
    db,
    sql`
      with updated as (
        update auth_states
           set payload = jsonb_set(payload, '{checkoutSessionId}', to_jsonb(${sessionId}::text))
         where id = ${id} and kind = 'card_setup' and consumed_at is null
        returning id
      )
      select json_build_object('updated', (select count(*) from updated)) as result
    `,
  );
  return (result?.updated ?? 0) > 0;
}

const cardSetupJson = sql.raw(`json_build_object(
  'id', id, 'userId', user_id, 'payload', payload, 'expiresAt', expires_at,
  'consumedAt', consumed_at, 'createdAt', created_at)`);

interface CardSetupJson {
  id: string;
  userId: string;
  payload: CardSetupPayload;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

const toCardSetup = (row: CardSetupJson): CardSetup => ({
  ...row,
  expiresAt: new Date(row.expiresAt),
  consumedAt: row.consumedAt === null ? null : new Date(row.consumedAt),
  createdAt: new Date(row.createdAt),
});

/** A card setup, whatever has become of it; given `userId`, only one that person started. */
export async function readCardSetup(
  db: Db,
  { id, userId }: { id: string; userId?: string },
): Promise<CardSetup | null> {
  const row = await queryJson<CardSetupJson>(
    db,
    sql`
      select ${cardSetupJson} as result from auth_states
       where id = ${id} and kind = 'card_setup'
         ${userId === undefined ? sql`` : sql`and user_id = ${userId}`}
    `,
  );
  return row ? toCardSetup(row) : null;
}

/**
 * Say how a card setup ended, once. Whichever comes first (the return page, the app's poll or
 * Stripe's webhook) settles it, and every later call answers `settled: false` with the setup as
 * the first left it. Null when there is no such setup.
 */
export async function settleCardSetup(
  db: Db,
  { id, outcome, at }: { id: string; outcome: CardSetupOutcome; at: Date },
): Promise<{ settled: boolean; setup: CardSetup } | null> {
  const answer = await queryJson<{ settled: boolean; setup: CardSetupJson }>(
    db,
    sql`
      -- Locked first: a settle that waited on another reads the row as that one left it (a plain
      -- read in this statement would see it as it was when the statement began).
      with locked as (
        select * from auth_states where id = ${id} and kind = 'card_setup' for update
      ),
      settled as (
        update auth_states a
           set consumed_at = coalesce(a.consumed_at, ${timeParam(at)}::timestamptz),
               payload = a.payload || jsonb_build_object('outcome', ${outcome}::text,
                                                         'settledAt', ${timeParam(at)}::text)
          from locked
         where a.id = locked.id and locked.payload ->> 'outcome' is null
        returning a.*
      )
      select json_build_object('settled', true, 'setup', ${cardSetupJson}) as result from settled
      union all
      select json_build_object('settled', false, 'setup', ${cardSetupJson}) as result
        from locked
       where not exists (select 1 from settled)
    `,
  );
  return answer ? { settled: answer.settled, setup: toCardSetup(answer.setup) } : null;
}

// --- the period close -----------------------------------------------------------------------------

/** When the workspace's running period is next to be closed. False when there is no workspace. */
export async function setNextClose(
  db: Db,
  { workspaceId, at }: { workspaceId: string; at: Date },
): Promise<boolean> {
  const rows = await run(
    db
      .update(workspaces)
      .set({ billingNextCloseAt: at })
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

/** Workspaces whose period is due to be closed by `before`, the longest due first. */
export async function dueClosings(
  db: Db,
  { before, limit }: { before: Date; limit: number },
): Promise<{ workspaceId: string; nextCloseAt: Date; billingPeriodAnchor: Date }[]> {
  const rows = await run(
    db
      .select({
        workspaceId: workspaces.id,
        nextCloseAt: workspaces.billingNextCloseAt,
        billingPeriodAnchor: workspaces.billingPeriodAnchor,
      })
      .from(workspaces)
      .where(lte(workspaces.billingNextCloseAt, before))
      .orderBy(asc(workspaces.billingNextCloseAt), asc(workspaces.id))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, nextCloseAt: row.nextCloseAt! }));
}

export type BillingPeriod = typeof billingPeriods.$inferSelect;

/** A closed period's frozen numbers, as the close works them out. */
export interface PeriodNumbers {
  workspaceId: string;
  periodStart: Date;
  periodEnd: Date;
  usedCredits: number;
  freeCredits: number;
  billedCredits: number;
  chargedCredits: number;
  chargedCents: number;
  capCents: number;
  people: number;
  rateCardVersion: number;
}

/**
 * Freeze a period's numbers, once. A close that runs again (a retry, or two at once) gets the row
 * the first wrote, numbers and status as they are now, and never writes new ones: what is charged
 * is decided once.
 */
export async function beginPeriodClose(
  db: Db,
  numbers: PeriodNumbers & { at: Date },
): Promise<{ period: BillingPeriod; created: boolean }> {
  const { at, ...values } = numbers;
  const [created] = await run(
    db
      .insert(billingPeriods)
      .values({ ...values, status: "closing", closedAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning(),
  );
  if (created) return { period: created, created: true };
  const [existing] = await run(
    db
      .select()
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.workspaceId, numbers.workspaceId),
          eq(billingPeriods.periodStart, numbers.periodStart),
        ),
      ),
  );
  return { period: existing!, created: false };
}

/**
 * Store the Stripe invoice made for a period. It is stored as soon as Stripe answers with it,
 * before its line or its finalizing, so a close that runs again finds it and never makes a second.
 * A period that already names another invoice keeps it: answers false.
 */
export async function setPeriodInvoice(
  db: Db,
  {
    workspaceId,
    periodStart,
    stripeInvoiceId,
    at,
  }: { workspaceId: string; periodStart: Date; stripeInvoiceId: string; at: Date },
): Promise<boolean> {
  const rows = await run(
    db
      .update(billingPeriods)
      .set({ stripeInvoiceId, updatedAt: at })
      .where(
        and(
          eq(billingPeriods.workspaceId, workspaceId),
          eq(billingPeriods.periodStart, periodStart),
          or(
            isNull(billingPeriods.stripeInvoiceId),
            eq(billingPeriods.stripeInvoiceId, stripeInvoiceId),
          ),
        ),
      )
      .returning({ workspaceId: billingPeriods.workspaceId }),
  );
  return rows.length > 0;
}
