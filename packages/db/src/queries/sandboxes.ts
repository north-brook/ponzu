import { and, eq, getTableColumns, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type AgentBlocker,
  type AgentState,
  authStates,
  type CanvasStatus,
  type ClaudeAccountKind,
  type ClaudeAccountStatus,
  canvases,
  type SandboxState,
  sandboxes,
} from "../schema/index.ts";
import { TURN_KINDS } from "./events.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A canvas's sandbox as the API drives it (docs/cloud.md, "The sandbox"). The database decides
 * every move: a canvas has at most one row (its primary key), and each move between states holds
 * to the states it moves from, and to the job holding a `waking` or `stopping` row, so of two
 * function instances racing on one sandbox only one moves it. Leaving `awake` meters the stretch
 * it was awake for, in the statement that moves it, so awake time is never lost and never
 * counted twice. While billing is on, the meter also cuts a long stretch into pieces as it goes
 * (`cutAwake`), each piece metered the same way.
 */

export type SandboxRow = typeof sandboxes.$inferSelect;

/**
 * How long a job holds a `waking` or `stopping` row without moving it before another may take
 * it over: longer than one attempt of a wake (an `up()`, a stop exec and a start) or a stop can
 * take, so a job still at it is never taken for one that died. The minute's sweep repairs a row
 * left this long.
 */
export const WAKING_LEASE_MS = 6 * 60_000;

/** How many sandboxes may be waking or awake at once, in one workspace and for one owner. */
export interface SandboxLimits {
  perWorkspace: number;
  perOwner: number;
}

/**
 * What a wake's claim on a sandbox came to: the row, now `waking` and held by the wake; `full`
 * when its workspace or its owner has as many sandboxes up as `SandboxLimits` allow; or null
 * when another job holds it, or it is in no state a wake takes it from.
 */
export type SandboxClaim = { sandbox: SandboxRow } | { full: true } | null;

/** The canvas's sandbox row, if it has one. */
export async function getSandbox(db: Db, canvasId: string): Promise<SandboxRow | null> {
  const [row] = await run(db.select().from(sandboxes).where(eq(sandboxes.canvasId, canvasId)));
  return row ?? null;
}

/** Where the API reaches the runner of a canvas whose sandbox is awake, its port token sealed. */
export async function getAwakeSandboxAddress(
  db: Db,
  canvasId: string,
): Promise<{ canvasId: string; address: string; encryptedPortToken: string | null } | null> {
  const [row] = await run(
    db
      .select({
        canvasId: sandboxes.canvasId,
        address: sandboxes.address,
        encryptedPortToken: sandboxes.encryptedPortToken,
      })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.canvasId, canvasId),
          eq(sandboxes.state, "awake"),
          isNotNull(sandboxes.address),
        ),
      ),
  );
  return row ? { ...row, address: row.address! } : null;
}

/**
 * The canvas's first sandbox row, `waking` and held by the wake `by`, under the limits. Null
 * when the canvas already has one: whoever holds that one decides.
 */
export async function beginSandbox(
  db: Db,
  { canvasId, now, by, limits }: { canvasId: string; now: Date; by: string; limits: SandboxLimits },
): Promise<SandboxClaim> {
  const at = timeParam(now);
  const result = await queryJson<MoveResult>(
    db,
    sql`
      with made as (
        insert into sandboxes (canvas_id, state, state_at, waking_by, last_activity_at,
                               awake_user_id, created_at, updated_at)
        select d.id, 'waking', ${at}::timestamptz, ${by}, ${at}::timestamptz,
               (${newestPerson(canvasId)}), ${at}::timestamptz, ${at}::timestamptz
          from canvases d
         where d.id = ${canvasId} and ${roomFor(sql`d.id`, limits)}
        on conflict (canvas_id) do nothing
        returning *
      )
      select json_build_object(
        'row', (select row_to_json(made) from made),
        'full', not ${roomFor(sql`${canvasId}`, limits)}
          and not exists (select 1 from sandboxes where canvas_id = ${canvasId})
      ) as result
    `,
  );
  return claimFrom(result);
}

/**
 * Take the canvas's sandbox for the wake `by`, moving it into `waking` from one of `from`. A
 * row that is `waking` is taken only by the wake that holds it, or once it was left unmoved for
 * a lease. Counted against `limits` in the same statement.
 */
export async function claimSandbox(
  db: Db,
  {
    canvasId,
    from,
    now,
    by,
    limits,
  }: {
    canvasId: string;
    from: readonly SandboxState[];
    now: Date;
    by: string;
    limits: SandboxLimits;
  },
): Promise<SandboxClaim> {
  return claimFrom(await move(db, { canvasId, from, to: "waking", now, by, limits }));
}

type MoveResult = {
  row: Record<string, unknown> | null;
  full: boolean;
  /** The row's `awake_since` as the move read it (a move statement's own answer only). */
  seen?: string | null;
};

/** Whether the row's `awake_since` is no longer `seen`, the value a failed move read. */
async function awakeSinceMoved(db: Db, canvasId: string, seen: string | null): Promise<boolean> {
  const [row] = await run(
    db
      .select({ awakeSince: sandboxes.awakeSince })
      .from(sandboxes)
      .where(eq(sandboxes.canvasId, canvasId)),
  );
  const now = row?.awakeSince?.getTime() ?? null;
  return now !== (seen === null ? null : new Date(seen).getTime());
}

function claimFrom(result: MoveResult | null): SandboxClaim {
  if (result?.row) return { sandbox: toSandbox(result.row) };
  return result?.full ? { full: true } : null;
}

/**
 * Whether the canvas `canvas` may have one more sandbox up: fewer than the limits are waking or
 * awake in its workspace, and for its owner, leaving its own aside.
 */
function roomFor(canvas: SQL, limits: SandboxLimits) {
  const up = (match: SQL) => sql`(
    select count(*) from sandboxes o join canvases od on od.id = o.canvas_id
     where o.state in ('waking', 'awake') and od.id <> r.id and ${match})`;
  return sql`coalesce((
    select ${up(sql`od.workspace_id = r.workspace_id`)} < ${limits.perWorkspace}
       and (r.owner_id is null or ${up(sql`od.owner_id = r.owner_id`)} < ${limits.perOwner})
      from canvases r where r.id = ${canvas}), false)`;
}

/** What a move can set beside the state. */
export interface SandboxChanges {
  sessionId?: string | null;
  sessionStartedAt?: Date | null;
  address?: string | null;
  encryptedPortToken?: string | null;
  expiresAt?: Date | null;
  image?: string | null;
  runnerTokenId?: string | null;
  claudeCredential?: string | null;
  /** Why the wake gave up: only on a move to `asleep`. */
  failure?: string | null;
}

/** A move of a sandbox, and what it holds to beside the states it moves from. */
export interface Move {
  canvasId: string;
  from: readonly SandboxState[];
  to: SandboxState;
  now: Date;
  /**
   * The job making the move. A row that is `waking` or `stopping` moves only for the job that
   * holds it (`waking_by`), or once it has sat unmoved for a lease. Without it, nothing is held to
   * (a retire takes the row whoever has it).
   */
  by?: string;
  /** Who holds the row once it is `waking` or `stopping`: `by` unless said. */
  hold?: string;
  /** Only if it has been in its state since before then: a repair of a move left halfway. */
  stateBefore?: Date;
  /** Only if nobody has kept it awake since then, so a stop never wins over a fresh message. */
  idleBefore?: Date;
  /** Only if the row holds this session. */
  sessionId?: string;
  /** Only while the canvas is settled: a retire never takes the row of a canvas reopened. */
  whileSettled?: boolean;
  /** Not from another retire still inside its lease: two retires of one canvas never overlap. */
  unlessRetiring?: boolean;
  changes?: SandboxChanges;
}

/**
 * Move a sandbox from one of `from` to `to` as of `now`, with `changes`, and answer the row as it
 * is now; null when it was in none of `from` (someone else moved it first) or a condition of the
 * move did not hold. Moving into `awake` starts its meter; moving out of it records the stretch as
 * a usage event, put down to the person who woke it or last kept it awake, in the same statement.
 * A move to `asleep` forgets the session's address and port token: nothing of it runs.
 */
export async function moveSandbox(db: Db, request: Move): Promise<SandboxRow | null> {
  const result = await move(db, request);
  return result?.row ? toSandbox(result.row) : null;
}

/**
 * Attempts of a move out of `awake`. It holds to the stretch it read (see `moveOnce`), so a
 * meter's cut, or a wake, that landed while it waited on the row makes it do nothing; it then
 * goes again from what is there now, and either moves the row and meters what is left of the
 * stretch, or finds what a lost race always finds. The meter cuts one sandbox at most three times
 * in a run, one after another, so a move can lose to each of them in turn and still move on its
 * fourth. A move that failed for any other reason (another state, a lease, fresh activity) finds
 * `awake_since` where it read it, and is not tried again.
 */
const MOVE_ATTEMPTS = 4;

const CHANGE_COLUMNS = {
  sessionId: "session_id",
  address: "address",
  encryptedPortToken: "encrypted_port_token",
  image: "image",
  runnerTokenId: "runner_token_id",
  claudeCredential: "claude_credential",
} as const;
const TIME_COLUMNS = { sessionStartedAt: "session_started_at", expiresAt: "expires_at" } as const;

/** `moveOnce`, again while it moved nothing out of `awake` (see `MOVE_ATTEMPTS`). */
async function move(
  db: Db,
  request: Move & { limits?: SandboxLimits },
): Promise<MoveResult | null> {
  let result = await moveOnce(db, request);
  if (!request.from.includes("awake")) return result;
  for (let attempt = 1; attempt < MOVE_ATTEMPTS && !result?.row && !result?.full; attempt++) {
    if (!(await awakeSinceMoved(db, request.canvasId, result?.seen ?? null))) break;
    result = await moveOnce(db, request);
  }
  return result;
}

async function moveOnce(
  db: Db,
  {
    canvasId,
    from,
    to,
    now,
    by,
    hold,
    stateBefore,
    idleBefore,
    sessionId,
    whileSettled,
    unlessRetiring,
    changes = {},
    limits,
  }: Move & { limits?: SandboxLimits },
): Promise<MoveResult | null> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const held = to === "waking" || to === "stopping";
  const set = [
    sql`state = ${to}`,
    sql`state_at = ${at}`,
    sql`updated_at = ${at}`,
    sql`waking_by = ${held ? (hold ?? by ?? null) : null}`,
    to === "awake"
      ? sql`awake_since = case when s.state = 'awake' then s.awake_since else ${at} end`
      : sql`awake_since = null`,
    // A wake is activity: the idle clock starts again from it.
    ...(to === "awake" || to === "waking" ? [sql`last_activity_at = ${at}`] : []),
    sql`failure = ${to === "asleep" ? (changes.failure ?? null) : null}`,
  ];
  const given = { ...changes };
  if (to === "asleep") {
    given.address ??= null;
    given.encryptedPortToken ??= null;
    given.expiresAt ??= null;
  }
  for (const [key, name] of Object.entries(CHANGE_COLUMNS) as [
    keyof typeof CHANGE_COLUMNS,
    string,
  ][]) {
    if (given[key] !== undefined) set.push(sql`${sql.raw(name)} = ${given[key]}`);
  }
  for (const [key, name] of Object.entries(TIME_COLUMNS) as [keyof typeof TIME_COLUMNS, string][]) {
    const value = given[key];
    if (value !== undefined) {
      set.push(sql`${sql.raw(name)} = ${value ? timeParam(value) : null}::timestamptz`);
    }
  }
  const conditions = [
    sql`s.state in (${sql.join(
      from.map((state) => sql`${state}`),
      sql`, `,
    )})`,
    // An awake row moves only from the stretch it read, which is the one it meters. A cut
    // (`cutAwake`) that commits while this waits on the row moves `awake_since` on, and metering
    // from the old start would collide with the cut's event and lose what came after it; a wake
    // that commits meanwhile starts a stretch this read as not awake, and would go unmetered. So
    // it moves nothing then, and `move` tries again. A row in any other state is as before.
    sql`(s.state <> 'awake'
         or s.awake_since is not distinct from (select b.awake_since from before b))`,
  ];
  if (by !== undefined) {
    const leaseOver = timeParam(new Date(now.getTime() - WAKING_LEASE_MS));
    conditions.push(
      sql`(s.state not in ('waking', 'stopping') or s.waking_by = ${by}
           or s.state_at < ${leaseOver}::timestamptz)`,
    );
  }
  if (stateBefore) conditions.push(sql`s.state_at < ${timeParam(stateBefore)}::timestamptz`);
  if (idleBefore) {
    conditions.push(sql`s.last_activity_at < ${timeParam(idleBefore)}::timestamptz`);
  }
  if (sessionId !== undefined) conditions.push(sql`s.session_id = ${sessionId}`);
  if (whileSettled) {
    conditions.push(
      sql`exists (select 1 from canvases d where d.id = s.canvas_id and d.status = 'settled')`,
    );
  }
  if (unlessRetiring) {
    const leaseOver = timeParam(new Date(now.getTime() - WAKING_LEASE_MS));
    conditions.push(
      sql`not (s.state = 'stopping' and s.waking_by like 'retire:%'
               and s.state_at >= ${leaseOver}::timestamptz)`,
    );
  }
  if (limits) conditions.push(roomFor(sql`s.canvas_id`, limits));
  return queryJson<MoveResult>(
    db,
    sql`
      with before as (
        select canvas_id, state, awake_since from sandboxes where canvas_id = ${canvasId}
      ),
      moved as (
        update sandboxes s
           set ${sql.join(set, sql`, `)}
         where s.canvas_id = ${canvasId} and ${sql.join(conditions, sql` and `)}
        returning s.*
      ),
      metered as (
        insert into usage_events (id, workspace_id, canvas_id, user_id, kind, seconds, payer,
                                  rate_card_version, occurred_at)
        select b.canvas_id || '/' || floor(extract(epoch from b.awake_since) * 1000)::bigint,
               d.workspace_id, d.id, m.awake_user_id, 'sandbox',
               greatest(0, round(extract(epoch from (${at} - b.awake_since))))::int,
               'ponzu',
               coalesce(
                 (select max(version) from rate_cards where effective_from <= b.awake_since),
                 (select min(version) from rate_cards)
               ),
               b.awake_since
          from moved m
          join before b on b.canvas_id = m.canvas_id
          join canvases d on d.id = m.canvas_id
         where b.state = 'awake' and m.state <> 'awake'
        on conflict (id) do nothing
      )
      select json_build_object(
        'row', (select row_to_json(moved) from moved),
        'full', ${limits ? sql`not ${roomFor(sql`${canvasId}`, limits)}` : sql`false`},
        'seen', (select b.awake_since from before b)
      ) as result
    `,
  );
}

/**
 * Meter the stretch an awake sandbox has been awake for up to `at`, and go on metering from
 * `at`, in one statement (docs/cloud.md, "Billing"): the usage event for [`observedSince`, `at`)
 * under the same id, attribution and rate card a sleep would have given it, and `awake_since`
 * moved to `at`. Only while the row is awake on the stretch that began at `observedSince`, and
 * `at` is after it: of two cuts, or a cut and a sleep, racing on one stretch, one wins and the
 * other does nothing. The sandbox's state and `state_at` (when it woke) are left as they are.
 * Answers whether it cut.
 */
export async function cutAwake(
  db: Db,
  { canvasId, at, observedSince }: { canvasId: string; at: Date; observedSince: Date },
): Promise<boolean> {
  const cutAt = sql`${timeParam(at)}::timestamptz`;
  const since = sql`${timeParam(observedSince)}::timestamptz`;
  const result = await queryJson<{ cut: boolean }>(
    db,
    sql`
      with cut as (
        update sandboxes s
           set awake_since = ${cutAt}
         where s.canvas_id = ${canvasId} and s.state = 'awake'
           and s.awake_since = ${since} and ${cutAt} > ${since}
        returning s.canvas_id, s.awake_user_id
      ),
      metered as (
        insert into usage_events (id, workspace_id, canvas_id, user_id, kind, seconds, payer,
                                  rate_card_version, occurred_at)
        select c.canvas_id || '/' || floor(extract(epoch from ${since}) * 1000)::bigint,
               d.workspace_id, d.id, c.awake_user_id, 'sandbox',
               greatest(0, round(extract(epoch from (${cutAt} - ${since}))))::int,
               'ponzu',
               coalesce(
                 (select max(version) from rate_cards where effective_from <= ${since}),
                 (select min(version) from rate_cards)
               ),
               ${since}
          from cut c
          join canvases d on d.id = c.canvas_id
        on conflict (id) do nothing
      )
      select json_build_object('cut', exists (select 1 from cut)) as result
    `,
  );
  return result?.cut ?? false;
}

/** An awake sandbox, as the meter weighs where to cut it. */
export interface AwakeToMeter {
  canvasId: string;
  awakeSince: Date;
  /** Its workspace's billing period anchor (`billing_period_anchor`). */
  periodAnchor: Date;
}

/** Every awake sandbox, with what the meter needs to cut it. */
export async function listAwakeToMeter(db: Db): Promise<AwakeToMeter[]> {
  const result = await queryJson<{
    rows: { canvas_id: string; awake_since: string; anchor: string }[];
  }>(
    db,
    sql`
      select json_build_object('rows', coalesce(json_agg(json_build_object(
        'canvas_id', s.canvas_id, 'awake_since', s.awake_since,
        'anchor', w.billing_period_anchor
      )), '[]'::json)) as result
        from sandboxes s
        join canvases d on d.id = s.canvas_id
        join workspaces w on w.id = d.workspace_id
       where s.state = 'awake'
    `,
  );
  return (result?.rows ?? []).map((row) => ({
    canvasId: row.canvas_id,
    awakeSince: new Date(row.awake_since),
    periodAnchor: new Date(row.anchor),
  }));
}

/**
 * Delete the canvas's row once the retire `by` that holds it has removed its sandbox. False when
 * it no longer holds it.
 */
export async function deleteSandboxRow(
  db: Db,
  { canvasId, by }: { canvasId: string; by: string },
): Promise<boolean> {
  const rows = await run(
    db
      .delete(sandboxes)
      .where(
        and(
          eq(sandboxes.canvasId, canvasId),
          eq(sandboxes.state, "stopping"),
          eq(sandboxes.wakingBy, by),
        ),
      )
      .returning({ canvasId: sandboxes.canvasId }),
  );
  return rows.length > 0;
}

/**
 * Something kept the canvas's sandbox awake as of `now`: a person did something, or its agent
 * reported working. Its awake time is put down to the person behind the newest event in the
 * canvas's feed. Answers the sandbox's state, or null when it has none.
 */
export async function touchSandbox(
  db: Db,
  { canvasId, now }: { canvasId: string; now: Date },
): Promise<SandboxState | null> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({
        lastActivityAt: sql`greatest(${sandboxes.lastActivityAt}, ${timeParam(now)}::timestamptz)`,
        awakeUserId: sql`coalesce((${newestPerson(canvasId)}), ${sandboxes.awakeUserId})`,
      })
      .where(eq(sandboxes.canvasId, canvasId))
      .returning({ state: sandboxes.state }),
  );
  return row?.state ?? null;
}

/** Record the session's new deadline after extending it, while the row still holds that session. */
export async function setSandboxExpiry(
  db: Db,
  { canvasId, sessionId, expiresAt }: { canvasId: string; sessionId: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await run(
    db
      .update(sandboxes)
      .set({ expiresAt: sql`${timeParam(expiresAt)}::timestamptz` })
      .where(
        and(
          eq(sandboxes.canvasId, canvasId),
          eq(sandboxes.state, "awake"),
          eq(sandboxes.sessionId, sessionId),
        ),
      )
      .returning({ canvasId: sandboxes.canvasId }),
  );
  return rows.length > 0;
}

/** Count a restart of a runner that was found dead. Answers how many there have been in a row. */
export async function countSandboxRestart(db: Db, canvasId: string): Promise<number> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({ restarts: sql`${sandboxes.restarts} + 1` })
      .where(eq(sandboxes.canvasId, canvasId))
      .returning({ restarts: sandboxes.restarts }),
  );
  return row?.restarts ?? 0;
}

/**
 * Show on the canvas's head why its agent is waiting, and whether a wake is under way. `waking`
 * turns an idle agent to `waking`; without it, a `waking` agent goes back to idle, and so does a
 * `working` one when there is a blocker: nothing runs then, whatever its runner last said.
 * `turnRuns` says otherwise for a blocker that lets a running turn finish (a wake gate's, such
 * as billing's or a Claude plan's limit): a `working` agent stays `working`.
 * `blockedUntil` is until when the blocker holds, when that is known; any other call clears it.
 * The row clients watch is written only when this changes what it shows.
 */
export async function showAgentWaiting(
  db: Db,
  {
    canvasId,
    waking,
    blocker,
    blockedUntil = null,
    turnRuns = false,
  }: {
    canvasId: string;
    waking: boolean;
    blocker: AgentBlocker | null;
    blockedUntil?: Date | null;
    turnRuns?: boolean;
  },
): Promise<void> {
  const stopped = blocker && !turnRuns ? sql`('waking', 'working')` : sql`('waking')`;
  const state = waking
    ? sql`case when ${canvases.agentState} in ('idle', 'limited') then 'waking' else ${canvases.agentState} end`
    : sql`case when ${canvases.agentState} in ${stopped} then 'idle' else ${canvases.agentState} end`;
  const until = blocker && blockedUntil ? blockedUntil : null;
  const untilParam = until ? sql`${timeParam(until)}::timestamptz` : sql`null::timestamptz`;
  await run(
    db
      .update(canvases)
      .set({ agentBlocker: blocker, agentBlockedUntil: until, agentState: state })
      .where(
        and(
          eq(canvases.id, canvasId),
          sql`(${canvases.agentBlocker}, ${canvases.agentBlockedUntil}, ${canvases.agentState})
              is distinct from (${blocker}::text, ${untilParam}, ${state})`,
        ),
      ),
  );
}

/**
 * Lift `blockers` from the active canvases they hold: one canvas, the canvases of a workspace,
 * those on a Claude account (that run on it, and its owner's that have not run on one yet), or
 * every canvas when none of these is given. What a gate does once what it waited for has
 * changed; the rest of the head is left as it is. Answers each canvas whose head changed, most
 * recently active first, and whether it has something in its feed its agent must take up.
 */
export async function liftAgentBlockers(
  db: Db,
  {
    blockers,
    canvasId,
    workspaceId,
    claudeAccountId,
  }: {
    blockers: readonly AgentBlocker[];
    canvasId?: string;
    workspaceId?: string;
    claudeAccountId?: string;
  },
): Promise<{ id: string; pending: boolean }[]> {
  if (blockers.length === 0) return [];
  const onAccount = sql`(${canvases.claudeAccountId} = ${claudeAccountId ?? null}
    or (${canvases.claudeAccountId} is null and ${canvases.ownerId} =
        (select a.user_id from claude_accounts a where a.id = ${claudeAccountId ?? null})))`;
  const rows = await run(
    db
      .update(canvases)
      .set({ agentBlocker: null, agentBlockedUntil: null })
      .where(
        and(
          eq(canvases.status, "active"),
          inArray(canvases.agentBlocker, [...blockers]),
          canvasId === undefined ? undefined : eq(canvases.id, canvasId),
          workspaceId === undefined ? undefined : eq(canvases.workspaceId, workspaceId),
          claudeAccountId === undefined ? undefined : onAccount,
        ),
      )
      .returning({
        id: canvases.id,
        lastActivityAt: canvases.lastActivityAt,
        // Named in full: inside a `returning`, Drizzle writes a column without its table.
        pending: sql<boolean>`exists (
          select 1 from events e
           where e.canvas_id = "canvases"."id" and e.delivered_at is null
             and e.priority in ('now', 'next'))`.mapWith(Boolean),
      }),
  );
  return rows
    .toSorted((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .map(({ id, pending }) => ({ id, pending }));
}

/** What waking a canvas takes: the canvas, whose Claude it runs on, and its sandbox now. */
export interface WakeContext {
  canvasId: string;
  workspaceId: string;
  status: CanvasStatus;
  ownerId: string | null;
  /** The Claude account it runs on: the one it was started on, else its owner's now. */
  claude: {
    id: string;
    userId: string;
    kind: ClaudeAccountKind;
    status: ClaudeAccountStatus;
    connectedAt: Date;
    expiresAt: Date | null;
    encryptedCredential: string | null;
    /** Until when its plan is at a limit, as a runner on its credential last said; else null. */
    limitedUntil: Date | null;
  } | null;
  sandbox: SandboxRow | null;
  /**
   * Whether the owner, whose Claude it runs on, is still a member of its workspace. Someone who
   * has left lends their Claude to nothing there.
   */
  ownerMember: boolean;
  /** What the canvas's head says its agent waits on now, and until when. */
  agentBlocker: AgentBlocker | null;
  agentBlockedUntil: Date | null;
}

/** Whether the canvas `d`'s owner is still a member of its workspace. */
const ownerMember = sql`exists (
  select 1 from memberships m where m.user_id = d.owner_id and m.workspace_id = d.workspace_id)`;

/** Whether the Claude account `a` is the one the canvas `d` runs on. */
const runsOn = sql`(a.id = d.claude_account_id
                    or (d.claude_account_id is null and a.user_id = d.owner_id))`;

/** Everything a wake decides on, in one read. Null when there is no such canvas. */
export async function getWakeContext(db: Db, canvasId: string): Promise<WakeContext | null> {
  const result = await queryJson<{
    canvas: {
      id: string;
      workspace_id: string;
      status: CanvasStatus;
      owner_id: string | null;
      agent_blocker: AgentBlocker | null;
      agent_blocked_until: string | null;
    };
    claude: {
      id: string;
      user_id: string;
      kind: ClaudeAccountKind;
      status: ClaudeAccountStatus;
      connected_at: string;
      expires_at: string | null;
      encrypted_credential: string | null;
      limited_until: string | null;
    } | null;
    sandbox: Record<string, unknown> | null;
    owner_member: boolean;
  }>(
    db,
    sql`
      select json_build_object(
        'canvas', json_build_object('id', d.id, 'workspace_id', d.workspace_id,
                                    'status', d.status, 'owner_id', d.owner_id,
                                    'agent_blocker', d.agent_blocker,
                                    'agent_blocked_until', d.agent_blocked_until),
        'claude', (select row_to_json(a) from claude_accounts a
                    where a.id = d.claude_account_id
                       or (d.claude_account_id is null and a.user_id = d.owner_id)
                    order by (a.id = d.claude_account_id) desc limit 1),
        'sandbox', (select row_to_json(s) from sandboxes s where s.canvas_id = d.id),
        'owner_member', ${ownerMember}
      ) as result
        from canvases d
       where d.id = ${canvasId}
    `,
  );
  if (!result) return null;
  const { canvas, claude } = result;
  return {
    canvasId: canvas.id,
    workspaceId: canvas.workspace_id,
    status: canvas.status,
    ownerId: canvas.owner_id,
    claude: claude && {
      id: claude.id,
      userId: claude.user_id,
      kind: claude.kind,
      status: claude.status,
      connectedAt: new Date(claude.connected_at),
      expiresAt: claude.expires_at ? new Date(claude.expires_at) : null,
      encryptedCredential: claude.encrypted_credential,
      limitedUntil: claude.limited_until ? new Date(claude.limited_until) : null,
    },
    sandbox: result.sandbox ? toSandbox(result.sandbox) : null,
    ownerMember: result.owner_member,
    agentBlocker: canvas.agent_blocker,
    agentBlockedUntil: canvas.agent_blocked_until ? new Date(canvas.agent_blocked_until) : null,
  };
}

/**
 * The awake sandboxes whose runner may hold this Claude account's credential: those of the
 * canvases that run on it, and its owner's that have not run yet. The credential lives only in
 * the running runner's memory, so an asleep one holds nothing.
 */
export async function listCanvasesWithSandboxOn(
  db: Db,
  { claudeAccountId, userId }: { claudeAccountId: string; userId: string },
): Promise<SandboxRow[]> {
  const rows = await run(
    db
      .select({ sandbox: sandboxes })
      .from(sandboxes)
      .innerJoin(canvases, eq(canvases.id, sandboxes.canvasId))
      .where(
        and(
          eq(sandboxes.state, "awake"),
          sql`(${canvases.claudeAccountId} = ${claudeAccountId}
               or (${canvases.claudeAccountId} is null and ${canvases.ownerId} = ${userId}))`,
        ),
      ),
  );
  return rows.map((row) => row.sandbox);
}

/** Record the Claude account a canvas runs on, if it records none yet. */
export async function recordCanvasClaudeAccount(
  db: Db,
  { canvasId, claudeAccountId }: { canvasId: string; claudeAccountId: string },
): Promise<void> {
  await run(
    db
      .update(canvases)
      .set({ claudeAccountId })
      .where(and(eq(canvases.id, canvasId), sql`${canvases.claudeAccountId} is null`)),
  );
}

/** A sandbox as the minute's sweep weighs it. */
export interface SweptSandbox {
  sandbox: SandboxRow;
  canvasStatus: CanvasStatus;
  /** When the canvas's runner last took the lease or reported its state. */
  heardAt: Date | null;
  /** When the canvas's current runner took the lease. */
  runnerStartedAt: Date | null;
  /** The runner that holds the lease. */
  runnerId: string | null;
  /** When a runner last wrote something of a turn to the thread. */
  saidAt: Date | null;
  /** What the canvas's head says its agent is doing. */
  agentState: AgentState;
  /** Whether the canvas's feed has something its agent must take up (`now` or `next`). */
  pending: boolean;
  /**
   * The events that are owed a turn (docs/cloud.md, "A turn that never came"): the ones that begin
   * one (`TURN_KINDS`, `now` or `next`), delivered after the runner last wrote anything of a turn,
   * that the API has not given up on, oldest first, with when each was delivered.
   */
  owed: { id: string; deliveredAt: Date }[];
  /** Whether the Claude account it runs on can run it now. */
  claudeUsable: boolean;
  /** Whether the canvas's owner is still a member of its workspace. */
  ownerMember: boolean;
}

/**
 * What the minute's sweep acts on: every sandbox that is moving or awake, and every sandbox of a
 * settled canvas. Asleep sandboxes of active canvases cost almost nothing and are left out.
 */
export async function listSandboxesToSweep(
  db: Db,
  { now }: { now: Date },
): Promise<SweptSandbox[]> {
  const result = await queryJson<{
    rows: {
      sandbox: Record<string, unknown>;
      canvas_status: CanvasStatus;
      heard_at: string | null;
      runner_started_at: string | null;
      runner_id: string | null;
      said_at: string | null;
      agent_state: AgentState;
      pending: boolean;
      owed: { id: string; delivered_at: string }[] | null;
      claude_usable: boolean;
      owner_member: boolean;
    }[];
  }>(
    db,
    sql`
      select json_build_object('rows', coalesce(json_agg(json_build_object(
        'sandbox', row_to_json(s),
        'canvas_status', d.status,
        'heard_at', r.heard_at,
        'runner_started_at', r.started_at,
        'runner_id', r.runner_id,
        'said_at', r.said_at,
        'agent_state', d.agent_state,
        'pending', exists (
          select 1 from events e
           where e.canvas_id = d.id and e.delivered_at is null and e.priority in ('now', 'next')
        ),
        'owed', case when s.state = 'awake' then (
          select json_agg(json_build_object('id', e.id, 'delivered_at', e.delivered_at)
                          order by e.seq)
            from events e
           where e.canvas_id = d.id and e.delivered_at is not null and e.lapsed_at is null
             and (r.said_at is null or e.delivered_at > r.said_at)
             and e.priority in ('now', 'next')
             and e.kind in (${sql.join(
               TURN_KINDS.map((kind) => sql`${kind}`),
               sql`, `,
             )})
             -- A person's stop after it says not to answer it: never sent again.
             and not exists (
               select 1 from events s
                where s.canvas_id = e.canvas_id and s.kind = 'stop' and s.seq > e.seq
             )
        ) end,
        'claude_usable', exists (
          select 1 from claude_accounts a
           where ${runsOn}
             and a.status = 'connected'
             and (a.expires_at is null or a.expires_at > ${timeParam(now)}::timestamptz)
        ),
        'owner_member', ${ownerMember}
      )), '[]'::json)) as result
        from sandboxes s
        join canvases d on d.id = s.canvas_id
        left join canvas_runners r on r.canvas_id = s.canvas_id
       where s.state in ('waking', 'awake', 'stopping') or d.status = 'settled'
    `,
  );
  return (result?.rows ?? []).map((row) => ({
    sandbox: toSandbox(row.sandbox),
    canvasStatus: row.canvas_status,
    heardAt: row.heard_at ? new Date(row.heard_at) : null,
    runnerStartedAt: row.runner_started_at ? new Date(row.runner_started_at) : null,
    runnerId: row.runner_id,
    saidAt: row.said_at ? new Date(row.said_at) : null,
    agentState: row.agent_state,
    pending: row.pending,
    owed: (row.owed ?? []).map((e) => ({ id: e.id, deliveredAt: new Date(e.delivered_at) })),
    claudeUsable: row.claude_usable,
    ownerMember: row.owner_member,
  }));
}

/** What reconcile knows of a canvas a sandbox at Vercel is named for. */
export interface ReconciledCanvas {
  /** False when the canvas was deleted: its id never comes back. */
  exists: boolean;
  status: CanvasStatus | null;
  sandbox: SandboxRow | null;
}

/** What reconcile knows of a sign-in a sandbox at Vercel is named for. */
export interface ReconciledSignIn {
  /** False when there is no such auth state (deleted with its person). */
  exists: boolean;
  consumedAt: Date | null;
  createdAt: Date | null;
}

/**
 * For reconcile: the canvases and the sign-ins the sandboxes at Vercel are named for, as the
 * database has them. Every id asked for is in the answer.
 */
export async function getSandboxOwners(
  db: Db,
  { canvasIds, signInIds }: { canvasIds: string[]; signInIds: string[] },
): Promise<{
  canvases: Map<string, ReconciledCanvas>;
  signIns: Map<string, ReconciledSignIn>;
}> {
  const [found, rows, states] = await Promise.all([
    canvasIds.length
      ? run(
          db
            .select({ id: canvases.id, status: canvases.status })
            .from(canvases)
            .where(inArray(canvases.id, canvasIds)),
        )
      : [],
    canvasIds.length
      ? run(db.select().from(sandboxes).where(inArray(sandboxes.canvasId, canvasIds)))
      : [],
    signInIds.length
      ? run(
          db
            .select({
              id: authStates.id,
              consumedAt: authStates.consumedAt,
              createdAt: authStates.createdAt,
            })
            .from(authStates)
            .where(and(inArray(authStates.id, signInIds), eq(authStates.kind, "claude_sign_in"))),
        )
      : [],
  ]);
  const statuses = new Map(found.map((canvas) => [canvas.id, canvas.status]));
  const byCanvas = new Map(rows.map((row) => [row.canvasId, row]));
  const byState = new Map(states.map((state) => [state.id, state]));
  return {
    canvases: new Map(
      canvasIds.map((id) => [
        id,
        {
          exists: statuses.has(id),
          status: statuses.get(id) ?? null,
          sandbox: byCanvas.get(id) ?? null,
        },
      ]),
    ),
    signIns: new Map(
      signInIds.map((id) => {
        const state = byState.get(id);
        return [
          id,
          {
            exists: state !== undefined,
            consumedAt: state?.consumedAt ?? null,
            createdAt: state?.createdAt ?? null,
          },
        ];
      }),
    ),
  };
}

/**
 * Whether the canvas's last checkpoint holds everything its sandbox has done (docs/cloud.md,
 * "How images roll out"): `covered` when no event went into its session after the checkpoint
 * was recorded, `behind` when one did, `none` when its runner has saved none though events went
 * in.
 */
export type CheckpointCover = "covered" | "behind" | "none";

export async function getCheckpointCover(db: Db, canvasId: string): Promise<CheckpointCover> {
  const result = await queryJson<{
    saved_turn: number | null;
    through: number | null;
    last: number | null;
  }>(
    db,
    sql`
      select json_build_object(
        'saved_turn', (select saved_turn from canvas_runners where canvas_id = ${canvasId}),
        'through', (select saved_through from canvas_runners where canvas_id = ${canvasId}),
        -- A stop and a push are acknowledged without going into the session, and a push after
        -- the turn's checkpoint changes nothing the sleep's would save: neither is work a
        -- checkpoint must hold.
        'last', (select max(seq) from events
                  where canvas_id = ${canvasId} and delivered_at is not null
                    and kind not in ('stop', 'push'))
      ) as result
    `,
  );
  const last = result?.last === null || result?.last === undefined ? null : Number(result.last);
  if (last === null) return "covered";
  if (result?.saved_turn === null || result?.saved_turn === undefined) return "none";
  const through = result.through === null ? null : Number(result.through);
  return through !== null && through >= last ? "covered" : "behind";
}

/** A canvas's sandbox with what says which image it runs, for a report on a rollout. */
export interface SandboxImage {
  sandbox: SandboxRow;
  canvasStatus: CanvasStatus;
  /** What its runner said it is when it last started (`canvas_runners.client`). */
  client: string | null;
}

/** Every sandbox row, oldest first, with what says which image it runs. */
export async function listSandboxImages(db: Db): Promise<SandboxImage[]> {
  const result = await queryJson<{
    rows: {
      sandbox: Record<string, unknown>;
      canvas_status: CanvasStatus;
      client: string | null;
    }[];
  }>(
    db,
    sql`
      select json_build_object('rows', coalesce(json_agg(json_build_object(
        'sandbox', row_to_json(s), 'canvas_status', d.status, 'client', r.client
      ) order by s.created_at), '[]'::json)) as result
        from sandboxes s
        join canvases d on d.id = s.canvas_id
        left join canvas_runners r on r.canvas_id = s.canvas_id
    `,
  );
  return (result?.rows ?? []).map((row) => ({
    sandbox: toSandbox(row.sandbox),
    canvasStatus: row.canvas_status,
    client: row.client,
  }));
}

/** The person behind the newest event in a canvas's feed that a person is behind. */
function newestPerson(canvasId: string) {
  return sql`select e.user_id from events e
              where e.canvas_id = ${canvasId} and e.user_id is not null
              order by e.seq desc limit 1`;
}

const COLUMNS = Object.entries(getTableColumns(sandboxes));

/** A row as `row_to_json` writes it, back to what Drizzle would have read. */
function toSandbox(json: Record<string, unknown>): SandboxRow {
  const row: Record<string, unknown> = {};
  for (const [key, column] of COLUMNS) {
    const value = json[column.name] ?? null;
    row[key] =
      value !== null && column.columnType === "PgTimestamp" ? new Date(String(value)) : value;
  }
  return row as SandboxRow;
}
