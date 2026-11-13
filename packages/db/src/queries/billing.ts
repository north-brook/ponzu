import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type BillingGateValue,
  billingPeriods,
  type CardSetupOutcome,
  canvases,
  type PastDueReason,
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
    ifPaymentMethodId,
  }: {
    workspaceId: string;
    paymentMethodId: string;
    brand: CardBrand;
    last4: string | null;
    /** Who added it, or null when it came from Stripe's portal or a webhook. */
    addedByUserId: string | null;
    at: Date;
    /**
     * Only while the stored card is still this one (null: none): what the caller read before it
     * asked Stripe, so a late answer about an older card never replaces a card added meanwhile.
     */
    ifPaymentMethodId?: string | null;
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
      .where(
        and(
          eq(workspaces.id, workspaceId),
          ifPaymentMethodId === undefined
            ? undefined
            : ifPaymentMethodId === null
              ? isNull(workspaces.stripePaymentMethodId)
              : eq(workspaces.stripePaymentMethodId, ifPaymentMethodId),
        ),
      )
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

/**
 * The workspace a Stripe object is about: the one whose customer it names or, failing that, the
 * one whose stored card it is. This is how a webhook about a customer or a payment method (which
 * carry no marks of ours) is matched to a workspace of this deployment. Null when neither is
 * ours.
 */
export async function workspaceForStripe(
  db: Db,
  { customerId, paymentMethodId }: { customerId: string | null; paymentMethodId: string | null },
): Promise<string | null> {
  const matches = [
    customerId === null ? undefined : eq(workspaces.stripeCustomerId, customerId),
    paymentMethodId === null ? undefined : eq(workspaces.stripePaymentMethodId, paymentMethodId),
  ].filter((match) => match !== undefined);
  if (matches.length === 0) return null;
  const [row] = await run(
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(or(...matches))
      // The customer's match first: a stored card can be stale, a customer cannot.
      .orderBy(
        sql`case when ${workspaces.stripeCustomerId} is not distinct from ${customerId} then 0 else 1 end`,
        asc(workspaces.id),
      )
      .limit(1),
  );
  return row?.id ?? null;
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
 * credits grow, within a minute. Given `pastDueBefore`, also every workspace still `ok` that has
 * been past due since before then: its grace ran out, so it closes within a minute even with
 * nothing awake.
 */
export async function listWorkspacesToGate(
  db: Db,
  { since, limit, pastDueBefore }: { since: Date; limit: number; pastDueBefore?: Date },
): Promise<string[]> {
  const graceOver = pastDueBefore
    ? sql`or (w.billing_gate = 'ok' and w.past_due_at <= ${timeParam(pastDueBefore)}::timestamptz)`
    : sql``;
  const result = await queryJson<{ ids: string[] }>(
    db,
    sql`
      select json_build_object('ids', coalesce(json_agg(id), '[]'::json)) as result
        from (
          select w.id from workspaces w
           where w.billing_gate <> 'ok'
              ${graceOver}
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

/**
 * The active canvases of the workspace that billing may have held back without a blocker on their
 * head: something for the agent waits in the feed (`now` or `next`), nothing says what the agent
 * waits on, and no sandbox is up to take it. A runner's claim holds a message back without
 * marking the canvas, and a push's wake lifts a billing blocker while what was held stays in the
 * feed, so once the sandbox sleeps nothing would wake it when the gate opens. At most `limit`,
 * most recently active first.
 */
export async function listHeldCanvases(
  db: Db,
  { workspaceId, limit }: { workspaceId: string; limit: number },
): Promise<string[]> {
  const result = await queryJson<{ ids: string[] }>(
    db,
    sql`
      select json_build_object('ids', coalesce(json_agg(id), '[]'::json)) as result
        from (
          select d.id from canvases d
           where d.workspace_id = ${workspaceId}
             and d.status = 'active'
             and d.agent_blocker is null
             and exists (select 1 from events e
                          where e.canvas_id = d.id and e.delivered_at is null
                            and e.priority in ('now', 'next'))
             and not exists (select 1 from sandboxes s
                              where s.canvas_id = d.id and s.state in ('waking', 'awake'))
           order by d.last_activity_at desc, d.id
           limit ${limit}
        ) held
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
  /** Where the admin started it: the wall on a send, or Settings. Absent when not said. */
  source?: "wall" | "settings";
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
    source,
    now,
    expiresAt,
  }: {
    userId: string;
    workspaceId: string;
    capCents: number;
    scheme: CardSetupPayload["scheme"];
    source?: CardSetupPayload["source"];
    now: Date;
    expiresAt: Date;
  },
): Promise<{ id: string; replaced: string[] } | null> {
  const payload: CardSetupPayload = {
    workspaceId,
    capCents,
    scheme,
    ...(source ? { source } : {}),
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
 * Record the Checkout session Stripe made for a card setup not yet settled, once. A setup a newer
 * one replaced in the meantime still records it: its page is open in the admin's browser, and the
 * return page and the poll read that page through this. False when it was settled, or already
 * has a session.
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
         where id = ${id} and kind = 'card_setup'
           and payload ->> 'outcome' is null and payload ->> 'checkoutSessionId' is null
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
 * the first left it. The one exception is `added` over `cancelled`, `expired` or `failed`: Stripe
 * can finish a page after its setup was marked otherwise (the admin went back to it after
 * Cancel), and a card Stripe has wins. Null when there is no such setup.
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
         where a.id = locked.id
           and (locked.payload ->> 'outcome' is null
                -- A card Stripe finished after the setup was marked cancelled or expired.
                or (${outcome}::text = 'added' and locked.payload ->> 'outcome' <> 'added'))
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

/**
 * When the workspace's running period is next to be closed. Given `ifAt`, only while the next
 * close is still that (null: not yet worked out), so a close that runs twice moves it on once.
 * False when there is no workspace, or it had moved.
 */
export async function setNextClose(
  db: Db,
  { workspaceId, at, ifAt }: { workspaceId: string; at: Date; ifAt?: Date | null },
): Promise<boolean> {
  const rows = await run(
    db
      .update(workspaces)
      .set({ billingNextCloseAt: at })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          ifAt === undefined
            ? undefined
            : ifAt === null
              ? isNull(workspaces.billingNextCloseAt)
              : eq(workspaces.billingNextCloseAt, ifAt),
        ),
      )
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

/**
 * Workspaces whose next close is not worked out yet (billing was just turned on, or the
 * workspace is new), at most `limit`, with their anchors so the caller can work it out.
 */
export async function listUnscheduledClosings(
  db: Db,
  { limit }: { limit: number },
): Promise<{ workspaceId: string; billingPeriodAnchor: Date }[]> {
  return run(
    db
      .select({ workspaceId: workspaces.id, billingPeriodAnchor: workspaces.billingPeriodAnchor })
      .from(workspaces)
      .where(isNull(workspaces.billingNextCloseAt))
      .orderBy(asc(workspaces.id))
      .limit(limit),
  );
}

/**
 * Set the next close of each workspace given that has none yet, in one statement. Answers how
 * many were set.
 */
export async function scheduleClosings(
  db: Db,
  closings: readonly { workspaceId: string; at: Date }[],
): Promise<number> {
  if (closings.length === 0) return 0;
  const rows = closings.map((closing) => ({ id: closing.workspaceId, at: timeParam(closing.at) }));
  const result = await queryJson<{ set: number }>(
    db,
    sql`
      with set as (
        update workspaces w set billing_next_close_at = c.at::timestamptz
          from json_to_recordset(${JSON.stringify(rows)}::json) as c(id text, at text)
         where w.id = c.id and w.billing_next_close_at is null
        returning w.id
      )
      select json_build_object('set', (select count(*) from set)) as result
    `,
  );
  return result?.set ?? 0;
}

/**
 * Whether the period [start, end) of the workspace has anything a close could charge or record:
 * a usage event dated in it, a sandbox awake since before its end, or a card on file. A period
 * with none is moved past with no row written.
 */
export async function periodHasActivity(
  db: Db,
  { workspaceId, start, end }: { workspaceId: string; start: Date; end: Date },
): Promise<boolean> {
  const from = sql`${timeParam(start)}::timestamptz`;
  const until = sql`${timeParam(end)}::timestamptz`;
  const result = await queryJson<{ active: boolean }>(
    db,
    sql`
      select json_build_object('active',
        exists (select 1 from usage_events e
                 where e.workspace_id = ${workspaceId}
                   and e.occurred_at >= ${from} and e.occurred_at < ${until})
        or exists (select 1 from sandboxes s join canvases d on d.id = s.canvas_id
                    where d.workspace_id = ${workspaceId} and s.state = 'awake'
                      and s.awake_since < ${until})
        or exists (select 1 from workspaces w
                    where w.id = ${workspaceId} and w.stripe_payment_method_id is not null)
      ) as result
    `,
  );
  return result?.active ?? false;
}

/**
 * Workspaces whose period is due to be closed by `before`, the longest due first. Given
 * `jobKind`, a workspace is left out while a job of that kind keyed `<workspace>:…` waits or is
 * running, or ran out of attempts since `failedSince`: a close already under way, or one that
 * failed for good and waits a while before it is tried again, never holds the others back.
 */
export async function dueClosings(
  db: Db,
  {
    before,
    limit,
    jobKind,
    failedSince,
  }: { before: Date; limit: number; jobKind?: string; failedSince?: Date },
): Promise<{ workspaceId: string; nextCloseAt: Date; billingPeriodAnchor: Date }[]> {
  const busy = jobKind
    ? sql`not exists (
        select 1 from jobs j
         where j.kind = ${jobKind} and starts_with(j.key, ${workspaces.id} || ':')
           and ((j.completed_at is null and j.failed_at is null)
                ${failedSince ? sql`or j.failed_at >= ${timeParam(failedSince)}::timestamptz` : sql``}))`
    : undefined;
  const rows = await run(
    db
      .select({
        workspaceId: workspaces.id,
        nextCloseAt: workspaces.billingNextCloseAt,
        billingPeriodAnchor: workspaces.billingPeriodAnchor,
      })
      .from(workspaces)
      .where(and(lte(workspaces.billingNextCloseAt, before), busy))
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

/**
 * Settle a period that is charged nothing: `unbilled` (billing was not on, or the close came
 * days late) or `waived` (under the minimum, or no card). Only from `closing` with no invoice,
 * so a period that has an invoice at Stripe is never marked as charged nothing. Answers the
 * period as it is now, settled or not; null when there is no such period.
 */
export async function settleUncharged(
  db: Db,
  {
    workspaceId,
    periodStart,
    status,
    at,
  }: { workspaceId: string; periodStart: Date; status: "unbilled" | "waived"; at: Date },
): Promise<BillingPeriod | null> {
  const key = and(
    eq(billingPeriods.workspaceId, workspaceId),
    eq(billingPeriods.periodStart, periodStart),
  );
  const [settled] = await run(
    db
      .update(billingPeriods)
      .set({ status, updatedAt: at })
      .where(and(key, eq(billingPeriods.status, "closing"), isNull(billingPeriods.stripeInvoiceId)))
      .returning(),
  );
  if (settled) return settled;
  const [existing] = await run(db.select().from(billingPeriods).where(key));
  return existing ?? null;
}

/** What a period's invoice says now, as `applyInvoiceState` stores it. */
export interface InvoiceStateUpdate {
  workspaceId: string;
  stripeInvoiceId: string;
  /** The status Stripe's invoice gives the period (a draft gives none, and is not stored). */
  status: "invoiced" | "paid" | "payment_failed" | "uncollectible" | "void";
  attempts: number;
  nextAttemptAt: Date | null;
  invoiceNumber: string | null;
  hostedInvoiceUrl: string | null;
  taxCents: number;
  totalCents: number;
  at: Date;
}

/** What `applyInvoiceState` did. */
export interface AppliedInvoiceState {
  periodStart: Date;
  periodEnd: Date;
  before: BillingPeriod["status"];
  after: BillingPeriod["status"];
  attemptsBefore: number;
  attempts: number;
  chargedCents: number;
  totalCents: number | null;
  /** This is the first time a payment of the period's invoice was seen to fail. */
  firstFailure: boolean;
}

/**
 * Store what the period's invoice says now, read fresh from Stripe. A status never goes back:
 * `paid` and `void` are final, `uncollectible` moves only to `paid` or `void`, and a failed
 * payment is never taken back to `invoiced`, so two reads applied in the wrong order (a webhook
 * job that read the invoice before another did) end where the later read left it. The attempt
 * count only grows. Null when no period of the workspace names the invoice.
 */
export async function applyInvoiceState(
  db: Db,
  update: InvoiceStateUpdate,
): Promise<AppliedInvoiceState | null> {
  const at = sql`${timeParam(update.at)}::timestamptz`;
  const next = update.nextAttemptAt
    ? sql`${timeParam(update.nextAttemptAt)}::timestamptz`
    : sql`null::timestamptz`;
  const status = sql`${update.status}::text`;
  // Locked first: of two applies at once, the second reads the row as the first left it.
  const row = await queryJson<
    Omit<AppliedInvoiceState, "periodStart" | "periodEnd"> & {
      periodStart: string;
      periodEnd: string;
    }
  >(
    db,
    sql`
      with locked as (
        select * from billing_periods
         where stripe_invoice_id = ${update.stripeInvoiceId}
           and workspace_id = ${update.workspaceId}
           for update
      ),
      next as (
        select l.workspace_id, l.period_start, l.status as before, l.attempts as attempts_before,
               l.failed_at is null as never_failed,
               case
                 when l.status in ('paid', 'void') then l.status
                 when l.status = 'uncollectible' and ${status} not in ('paid', 'void') then l.status
                 when l.status = 'payment_failed' and ${status} = 'invoiced' then l.status
                 else ${status}
               end as after
          from locked l
      ),
      updated as (
        update billing_periods p
           set status = n.after,
               attempts = greatest(p.attempts, ${update.attempts}),
               next_attempt_at = case when n.after in ('paid', 'void') then null else ${next} end,
               invoice_number = coalesce(${update.invoiceNumber}::text, p.invoice_number),
               hosted_invoice_url = coalesce(${update.hostedInvoiceUrl}::text, p.hosted_invoice_url),
               tax_cents = ${update.taxCents},
               total_cents = ${update.totalCents},
               invoiced_at = coalesce(p.invoiced_at, ${at}),
               paid_at = case when n.after = 'paid' then coalesce(p.paid_at, ${at})
                              else p.paid_at end,
               failed_at = case when n.after = 'payment_failed' then coalesce(p.failed_at, ${at})
                                else p.failed_at end,
               updated_at = ${at}
          from next n
         where p.workspace_id = n.workspace_id and p.period_start = n.period_start
        returning p.*, n.before, n.attempts_before, n.never_failed
      )
      select json_build_object(
        'periodStart', period_start, 'periodEnd', period_end,
        'before', before, 'after', status,
        'attemptsBefore', attempts_before, 'attempts', attempts,
        'chargedCents', charged_cents, 'totalCents', total_cents,
        'firstFailure', never_failed and status = 'payment_failed'
      ) as result from updated
    `,
  );
  return row
    ? { ...row, periodStart: new Date(row.periodStart), periodEnd: new Date(row.periodEnd) }
    : null;
}

/**
 * Mark the workspace past due: since the first time (kept), why now, and the page where the
 * invoice can be paid. False when there is no workspace.
 */
export async function setPastDue(
  db: Db,
  {
    workspaceId,
    reason,
    invoiceUrl,
    at,
  }: { workspaceId: string; reason: PastDueReason; invoiceUrl: string | null; at: Date },
): Promise<boolean> {
  const rows = await run(
    db
      .update(workspaces)
      .set({
        pastDueAt: sql`coalesce(${workspaces.pastDueAt}, ${timeParam(at)}::timestamptz)`,
        pastDueReason: reason,
        pastDueInvoiceUrl: sql`coalesce(${invoiceUrl}::text, ${workspaces.pastDueInvoiceUrl})`,
      })
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id }),
  );
  return rows.length > 0;
}

/**
 * The workspace is no longer past due once none of its periods has a failed or uncollectible
 * invoice: clear what says it is. While one still has, the page to pay points at the oldest of
 * them. Answers whether it is past due no more (true also when it never was).
 */
export async function clearPastDueIfSettled(
  db: Db,
  { workspaceId }: { workspaceId: string },
): Promise<boolean> {
  const result = await queryJson<{ cleared: boolean }>(
    db,
    sql`
      with unpaid as (
        select hosted_invoice_url from billing_periods
         where workspace_id = ${workspaceId} and status in ('payment_failed', 'uncollectible')
         order by period_start
         limit 1
      ),
      updated as (
        update workspaces w
           set past_due_at = case when exists (select 1 from unpaid) then w.past_due_at end,
               past_due_reason = case when exists (select 1 from unpaid) then w.past_due_reason end,
               past_due_invoice_url = case when exists (select 1 from unpaid)
                 then coalesce((select hosted_invoice_url from unpaid), w.past_due_invoice_url) end
         where w.id = ${workspaceId} and w.past_due_at is not null
        returning w.id
      )
      select json_build_object('cleared', not exists (select 1 from unpaid)) as result
    `,
  );
  return result?.cleared ?? true;
}
