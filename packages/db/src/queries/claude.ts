import { and, eq, getTableColumns, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type AgentBlocker,
  type ClaudeAccountKind,
  type ClaudeModelReport,
  canvases,
  canvasRunners,
  claudeAccounts,
  users,
} from "../schema/index.ts";
import type { ClaudeAccount } from "./accounts.ts";
import { timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A person's own Claude (docs/cloud.md, "Credentials"): one row each, which keeps its id for
 * good. Connecting again replaces the credential on the same row, and disconnecting destroys
 * the credential and keeps the row, so the canvases that record the account keep pointing at it.
 */

/**
 * The id a person's Claude account has, or will have once connected: the credential is sealed
 * to the row it is stored in, so it must be known first.
 */
export async function claudeAccountIdFor(db: Db, userId: string): Promise<string> {
  const [row] = await run(
    db
      .select({ id: claudeAccounts.id })
      .from(claudeAccounts)
      .where(eq(claudeAccounts.userId, userId)),
  );
  return row?.id ?? newId("cla");
}

export interface ConnectedClaude {
  /** From `claudeAccountIdFor`: the row the credential was sealed to. */
  id: string;
  userId: string;
  kind: ClaudeAccountKind;
  encryptedCredential: string;
  keyHint: string | null;
  expiresAt: Date | null;
  now: Date;
}

/**
 * Store a person's credential, replacing whatever they had, as connected at `now`. Null when
 * their account turned out to have another id than the one it was sealed to (someone connected
 * at the same moment): seal it again for the id `claudeAccountIdFor` answers now.
 */
export async function connectClaudeAccount(
  db: Db,
  account: ConnectedClaude,
): Promise<ClaudeAccount | null> {
  const { now, ...values } = account;
  const fresh = {
    kind: values.kind,
    status: "connected" as const,
    encryptedCredential: values.encryptedCredential,
    keyHint: values.keyHint,
    expiresAt: values.expiresAt,
    connectedAt: sql`${timeParam(now)}::timestamptz`,
    // What was learned about the last credential is not this one's.
    planLabel: null,
    email: null,
    limits: null,
    limitsObservedAt: null,
    limitedUntil: null,
    models: null,
    modelsReportedAt: null,
    modelsClaudeCode: null,
  };
  const { encryptedCredential: _sealed, ...returned } = getTableColumns(claudeAccounts);
  const [row] = await run(
    db
      .insert(claudeAccounts)
      .values({ id: values.id, userId: values.userId, ...fresh })
      .onConflictDoUpdate({
        target: claudeAccounts.userId,
        set: fresh,
        setWhere: eq(claudeAccounts.id, values.id),
      })
      .returning(returned),
  );
  return row ?? null;
}

/** A Claude account by its id, without its credential. */
export async function getClaudeAccountById(db: Db, id: string): Promise<ClaudeAccount | null> {
  const { encryptedCredential: _sealed, ...columns } = getTableColumns(claudeAccounts);
  const [row] = await run(db.select(columns).from(claudeAccounts).where(eq(claudeAccounts.id, id)));
  return row ?? null;
}

/**
 * Keep what Claude Code offers an account, as a runner on its credential reported at `now`. Kept
 * only while the credential is still the one connected at `connectedAt`: a report from a runner
 * on a credential since replaced or destroyed says nothing about the one there now. Answers
 * whether it was kept.
 *
 * With `throttle`, a report is also not kept when the account's last one was kept after `since`
 * and after the reporting runner took its lease: each runner's first report goes through, and
 * then at most one in each window, in one statement, so reports racing each other keep one.
 */
export async function recordClaudeModels(
  db: Db,
  report: {
    claudeAccountId: string;
    connectedAt: Date;
    claudeCode: string;
    models: ClaudeModelReport[];
    now: Date;
    throttle?: { canvasId: string; runnerId: string; since: Date };
  },
): Promise<boolean> {
  const { throttle } = report;
  const due = throttle
    ? sql`(${claudeAccounts.modelsReportedAt} is null
        or ${claudeAccounts.modelsReportedAt} <= ${timeParam(throttle.since)}::timestamptz
        or ${claudeAccounts.modelsReportedAt} < (
          select ${canvasRunners.startedAt} from ${canvasRunners}
          where ${canvasRunners.canvasId} = ${throttle.canvasId}
            and ${canvasRunners.runnerId} = ${throttle.runnerId}
        ))`
    : undefined;
  const rows = await run(
    db
      .update(claudeAccounts)
      .set({
        models: report.models,
        modelsReportedAt: sql`${timeParam(report.now)}::timestamptz`,
        modelsClaudeCode: report.claudeCode,
      })
      .where(
        and(
          eq(claudeAccounts.id, report.claudeAccountId),
          sql`${claudeAccounts.connectedAt} = ${timeParam(report.connectedAt)}::timestamptz`,
          ne(claudeAccounts.status, "revoked"),
          due,
        ),
      )
      .returning({ id: claudeAccounts.id }),
  );
  return rows.length > 0;
}

/** What a runner said of one of a Claude plan's limits (the runner protocol's `claudeLimit`). */
export interface ClaudeLimitSeen {
  status: "allowed" | "allowed_warning" | "rejected";
  window: string | null;
  resetsAt: Date | null;
  utilization: number | null;
}

/**
 * Keep what a runner on a subscription's credential said of the plan's limits at `now`: the
 * window's share and reset, replacing what was kept of that window, and until when the plan
 * holds canvases back. A `rejected` window holds them until its reset (one with no reset leaves
 * `limited_until` as it was, since nobody can say when to try again); any other status says
 * requests go through, so nothing holds them. Kept only while the credential is still the one
 * connected at `connectedAt`, and never for an API key, which has no plan. Answers whether it
 * was kept, and the account's `limited_until` after it.
 */
export async function recordClaudeLimit(
  db: Db,
  report: { claudeAccountId: string; connectedAt: Date; seen: ClaudeLimitSeen; now: Date },
): Promise<{ kept: boolean; limitedUntil: Date | null }> {
  const { seen, now } = report;
  const entry = seen.window && {
    window: seen.window,
    utilization: seen.utilization,
    resetsAt: seen.resetsAt?.toISOString() ?? null,
    at: now.toISOString(),
  };
  const limits = entry
    ? sql`(select coalesce(jsonb_agg(e), '[]'::jsonb)
             from jsonb_array_elements(coalesce(${claudeAccounts.limits}, '[]'::jsonb)) e
            where e->>'window' is distinct from ${entry.window})
          || jsonb_build_array(${JSON.stringify(entry)}::jsonb)`
    : sql`${claudeAccounts.limits}`;
  const limitedUntil =
    seen.status !== "rejected"
      ? null
      : seen.resetsAt
        ? sql`${timeParam(seen.resetsAt)}::timestamptz`
        : sql`${claudeAccounts.limitedUntil}`;
  const [row] = await run(
    db
      .update(claudeAccounts)
      .set({
        limits: limits as never,
        limitsObservedAt: sql`${timeParam(now)}::timestamptz`,
        limitedUntil: limitedUntil as never,
      })
      .where(
        and(
          eq(claudeAccounts.id, report.claudeAccountId),
          sql`${claudeAccounts.connectedAt} = ${timeParam(report.connectedAt)}::timestamptz`,
          ne(claudeAccounts.status, "revoked"),
          eq(claudeAccounts.kind, "subscription"),
        ),
      )
      .returning({ limitedUntil: claudeAccounts.limitedUntil }),
  );
  return row ? { kept: true, limitedUntil: row.limitedUntil } : { kept: false, limitedUntil: null };
}

/**
 * Until when the Claude plan the canvas runs on is at its limit, if it is at `now`: the account
 * it was started on, else its owner's. Null when it is not, or there is no such canvas.
 */
export async function claudeLimitedUntil(
  db: Db,
  { canvasId, now }: { canvasId: string; now: Date },
): Promise<Date | null> {
  const [row] = await run(
    db
      .select({ until: claudeAccounts.limitedUntil })
      .from(canvases)
      .innerJoin(
        claudeAccounts,
        sql`(${claudeAccounts.id} = ${canvases.claudeAccountId}
             or (${canvases.claudeAccountId} is null and ${claudeAccounts.userId} = ${canvases.ownerId}))`,
      )
      .where(
        and(
          eq(canvases.id, canvasId),
          sql`${claudeAccounts.limitedUntil} > ${timeParam(now)}::timestamptz`,
        ),
      )
      .limit(1),
  );
  return row?.until ?? null;
}

/** Destroy a person's credential. Answers their account's id, or null if they had none connected. */
export async function disconnectClaudeAccount(db: Db, userId: string): Promise<string | null> {
  const [row] = await run(
    db
      .update(claudeAccounts)
      .set({ status: "revoked", encryptedCredential: null })
      .where(and(eq(claudeAccounts.userId, userId), isNotNull(claudeAccounts.encryptedCredential)))
      .returning({ id: claudeAccounts.id }),
  );
  return row?.id ?? null;
}

/**
 * Say on the active canvases that run on this account why their agent waits, or (with null)
 * that it no longer waits for Claude. Answers the canvases whose head changed, and whether each
 * has something in its feed its agent must take up.
 */
export async function setClaudeBlocker(
  db: Db,
  {
    claudeAccountId,
    userId,
    blocker,
  }: { claudeAccountId: string; userId: string; blocker: AgentBlocker | null },
): Promise<{ id: string; pending: boolean }[]> {
  const claude = ["claude_not_connected", "claude_expired"];
  const rows = await run(
    db
      .update(canvases)
      .set({
        agentBlocker: blocker,
        agentBlockedUntil: null,
        // With a blocker nothing runs, whatever its runner last said.
        agentState: sql`case when ${canvases.agentState} in ${blocker ? sql`('waking', 'working')` : sql`('waking')`}
                             then 'idle' else ${canvases.agentState} end`,
      })
      .where(
        and(
          eq(canvases.status, "active"),
          sql`(${canvases.claudeAccountId} = ${claudeAccountId}
               or (${canvases.claudeAccountId} is null and ${canvases.ownerId} = ${userId}))`,
          blocker === null
            ? inArray(canvases.agentBlocker, claude as AgentBlocker[])
            : sql`${canvases.agentBlocker} is distinct from ${blocker}`,
        ),
      )
      .returning({
        id: canvases.id,
        // Named in full: inside a `returning`, Drizzle writes a column without its table.
        pending: sql<boolean>`exists (
          select 1 from events e
           where e.canvas_id = "canvases"."id" and e.delivered_at is null
             and e.priority in ('now', 'next'))`.mapWith(Boolean),
      }),
  );
  return rows;
}

/** A person's defaults for new canvases. */
export async function setAgentDefaults(
  db: Db,
  { userId, model, effort }: { userId: string; model?: string | null; effort?: string | null },
): Promise<{ model: string | null; effort: string | null }> {
  const [row] = await run(
    db
      .update(users)
      .set({
        ...(model === undefined ? {} : { defaultModel: model }),
        ...(effort === undefined ? {} : { defaultEffort: effort }),
      })
      .where(eq(users.id, userId))
      .returning({ model: users.defaultModel, effort: users.defaultEffort }),
  );
  return row ?? { model: null, effort: null };
}
