import { and, eq, getTableColumns, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type AgentBlocker,
  type AgentState,
  authStates,
  type ClaudeAccountKind,
  type ClaudeAccountStatus,
  type DesignStatus,
  designs,
  type SandboxState,
  sandboxes,
} from "../schema/index.ts";
import { TURN_KINDS } from "./events.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A design's sandbox as the API drives it (docs/cloud.md, "The sandbox"). The database decides
 * every move: a design has at most one row (its primary key), and each move between states holds
 * to the states it moves from, and to the job holding a `waking` or `stopping` row, so of two
 * function instances racing on one sandbox only one moves it. Leaving `awake` meters the stretch
 * it was awake for, in the statement that moves it, so awake time is never lost and never
 * counted twice.
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

/** The design's sandbox row, if it has one. */
export async function getSandbox(db: Db, designId: string): Promise<SandboxRow | null> {
  const [row] = await run(db.select().from(sandboxes).where(eq(sandboxes.designId, designId)));
  return row ?? null;
}

/** Where the API reaches the runner of a design whose sandbox is awake, its port token sealed. */
export async function getAwakeSandboxAddress(
  db: Db,
  designId: string,
): Promise<{ designId: string; address: string; encryptedPortToken: string | null } | null> {
  const [row] = await run(
    db
      .select({
        designId: sandboxes.designId,
        address: sandboxes.address,
        encryptedPortToken: sandboxes.encryptedPortToken,
      })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.designId, designId),
          eq(sandboxes.state, "awake"),
          isNotNull(sandboxes.address),
        ),
      ),
  );
  return row ? { ...row, address: row.address! } : null;
}

/**
 * The design's first sandbox row, `waking` and held by the wake `by`, under the limits. Null
 * when the design already has one: whoever holds that one decides.
 */
export async function beginSandbox(
  db: Db,
  { designId, now, by, limits }: { designId: string; now: Date; by: string; limits: SandboxLimits },
): Promise<SandboxClaim> {
  const at = timeParam(now);
  const result = await queryJson<MoveResult>(
    db,
    sql`
      with made as (
        insert into sandboxes (design_id, state, state_at, waking_by, last_activity_at,
                               awake_user_id, created_at, updated_at)
        select d.id, 'waking', ${at}::timestamptz, ${by}, ${at}::timestamptz,
               (${newestPerson(designId)}), ${at}::timestamptz, ${at}::timestamptz
          from designs d
         where d.id = ${designId} and ${roomFor(sql`d.id`, limits)}
        on conflict (design_id) do nothing
        returning *
      )
      select json_build_object(
        'row', (select row_to_json(made) from made),
        'full', not ${roomFor(sql`${designId}`, limits)}
          and not exists (select 1 from sandboxes where design_id = ${designId})
      ) as result
    `,
  );
  return claimFrom(result);
}

/**
 * Take the design's sandbox for the wake `by`, moving it into `waking` from one of `from`. A
 * row that is `waking` is taken only by the wake that holds it, or once it was left unmoved for
 * a lease. Counted against `limits` in the same statement.
 */
export async function claimSandbox(
  db: Db,
  {
    designId,
    from,
    now,
    by,
    limits,
  }: {
    designId: string;
    from: readonly SandboxState[];
    now: Date;
    by: string;
    limits: SandboxLimits;
  },
): Promise<SandboxClaim> {
  return claimFrom(await move(db, { designId, from, to: "waking", now, by, limits }));
}

type MoveResult = { row: Record<string, unknown> | null; full: boolean };

function claimFrom(result: MoveResult | null): SandboxClaim {
  if (result?.row) return { sandbox: toSandbox(result.row) };
  return result?.full ? { full: true } : null;
}

/**
 * Whether the design `design` may have one more sandbox up: fewer than the limits are waking or
 * awake in its workspace, and for its owner, leaving its own aside.
 */
function roomFor(design: SQL, limits: SandboxLimits) {
  const up = (match: SQL) => sql`(
    select count(*) from sandboxes o join designs od on od.id = o.design_id
     where o.state in ('waking', 'awake') and od.id <> r.id and ${match})`;
  return sql`coalesce((
    select ${up(sql`od.workspace_id = r.workspace_id`)} < ${limits.perWorkspace}
       and (r.owner_id is null or ${up(sql`od.owner_id = r.owner_id`)} < ${limits.perOwner})
      from designs r where r.id = ${design}), false)`;
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
  designId: string;
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

const CHANGE_COLUMNS = {
  sessionId: "session_id",
  address: "address",
  encryptedPortToken: "encrypted_port_token",
  image: "image",
  runnerTokenId: "runner_token_id",
  claudeCredential: "claude_credential",
} as const;
const TIME_COLUMNS = { sessionStartedAt: "session_started_at", expiresAt: "expires_at" } as const;

async function move(
  db: Db,
  {
    designId,
    from,
    to,
    now,
    by,
    hold,
    stateBefore,
    idleBefore,
    sessionId,
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
  if (limits) conditions.push(roomFor(sql`s.design_id`, limits));
  return queryJson<MoveResult>(
    db,
    sql`
      with before as (
        select design_id, state, awake_since from sandboxes where design_id = ${designId}
      ),
      moved as (
        update sandboxes s
           set ${sql.join(set, sql`, `)}
         where s.design_id = ${designId} and ${sql.join(conditions, sql` and `)}
        returning s.*
      ),
      metered as (
        insert into usage_events (id, workspace_id, design_id, user_id, kind, seconds, payer,
                                  rate_card_version, occurred_at)
        select b.design_id || '/' || floor(extract(epoch from b.awake_since) * 1000)::bigint,
               d.workspace_id, d.id, m.awake_user_id, 'sandbox',
               greatest(0, round(extract(epoch from (${at} - b.awake_since))))::int,
               'ponzu',
               coalesce(
                 (select max(version) from rate_cards where effective_from <= b.awake_since),
                 (select min(version) from rate_cards)
               ),
               b.awake_since
          from moved m
          join before b on b.design_id = m.design_id
          join designs d on d.id = m.design_id
         where b.state = 'awake' and m.state <> 'awake'
        on conflict (id) do nothing
      )
      select json_build_object(
        'row', (select row_to_json(moved) from moved),
        'full', ${limits ? sql`not ${roomFor(sql`${designId}`, limits)}` : sql`false`}
      ) as result
    `,
  );
}

/**
 * Delete the design's row once the retire `by` that holds it has removed its sandbox. False when
 * it no longer holds it.
 */
export async function deleteSandboxRow(
  db: Db,
  { designId, by }: { designId: string; by: string },
): Promise<boolean> {
  const rows = await run(
    db
      .delete(sandboxes)
      .where(
        and(
          eq(sandboxes.designId, designId),
          eq(sandboxes.state, "stopping"),
          eq(sandboxes.wakingBy, by),
        ),
      )
      .returning({ designId: sandboxes.designId }),
  );
  return rows.length > 0;
}

/**
 * Something kept the design's sandbox awake as of `now`: a person did something, or its agent
 * reported working. Its awake time is put down to the person behind the newest event in the
 * design's feed. Answers the sandbox's state, or null when it has none.
 */
export async function touchSandbox(
  db: Db,
  { designId, now }: { designId: string; now: Date },
): Promise<SandboxState | null> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({
        lastActivityAt: sql`greatest(${sandboxes.lastActivityAt}, ${timeParam(now)}::timestamptz)`,
        awakeUserId: sql`coalesce((${newestPerson(designId)}), ${sandboxes.awakeUserId})`,
      })
      .where(eq(sandboxes.designId, designId))
      .returning({ state: sandboxes.state }),
  );
  return row?.state ?? null;
}

/** Record the session's new deadline after extending it, while the row still holds that session. */
export async function setSandboxExpiry(
  db: Db,
  { designId, sessionId, expiresAt }: { designId: string; sessionId: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await run(
    db
      .update(sandboxes)
      .set({ expiresAt: sql`${timeParam(expiresAt)}::timestamptz` })
      .where(
        and(
          eq(sandboxes.designId, designId),
          eq(sandboxes.state, "awake"),
          eq(sandboxes.sessionId, sessionId),
        ),
      )
      .returning({ designId: sandboxes.designId }),
  );
  return rows.length > 0;
}

/** Count a restart of a runner that was found dead. Answers how many there have been in a row. */
export async function countSandboxRestart(db: Db, designId: string): Promise<number> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({ restarts: sql`${sandboxes.restarts} + 1` })
      .where(eq(sandboxes.designId, designId))
      .returning({ restarts: sandboxes.restarts }),
  );
  return row?.restarts ?? 0;
}

/**
 * Show on the design's head why its agent is waiting, and whether a wake is under way. `waking`
 * turns an idle agent to `waking`; without it, a `waking` agent goes back to idle, and so does a
 * `working` one when there is a blocker: nothing runs then, whatever its runner last said. The
 * row clients watch is written only when this changes what it shows.
 */
export async function showAgentWaiting(
  db: Db,
  {
    designId,
    waking,
    blocker,
  }: { designId: string; waking: boolean; blocker: AgentBlocker | null },
): Promise<void> {
  const stopped = blocker ? sql`('waking', 'working')` : sql`('waking')`;
  const state = waking
    ? sql`case when ${designs.agentState} in ('idle', 'limited') then 'waking' else ${designs.agentState} end`
    : sql`case when ${designs.agentState} in ${stopped} then 'idle' else ${designs.agentState} end`;
  await run(
    db
      .update(designs)
      .set({ agentBlocker: blocker, agentState: state })
      .where(
        and(
          eq(designs.id, designId),
          sql`(${designs.agentBlocker}, ${designs.agentState}) is distinct from (${blocker}::text, ${state})`,
        ),
      ),
  );
}

/** What waking a design takes: the design, whose Claude it runs on, and its sandbox now. */
export interface WakeContext {
  designId: string;
  workspaceId: string;
  status: DesignStatus;
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
  } | null;
  sandbox: SandboxRow | null;
  /**
   * Whether the owner, whose Claude it runs on, is still a member of its workspace. Someone who
   * has left lends their Claude to nothing there.
   */
  ownerMember: boolean;
}

/** Whether the design `d`'s owner is still a member of its workspace. */
const ownerMember = sql`exists (
  select 1 from memberships m where m.user_id = d.owner_id and m.workspace_id = d.workspace_id)`;

/** Whether the Claude account `a` is the one the design `d` runs on. */
const runsOn = sql`(a.id = d.claude_account_id
                    or (d.claude_account_id is null and a.user_id = d.owner_id))`;

/** Everything a wake decides on, in one read. Null when there is no such design. */
export async function getWakeContext(db: Db, designId: string): Promise<WakeContext | null> {
  const result = await queryJson<{
    design: { id: string; workspace_id: string; status: DesignStatus; owner_id: string | null };
    claude: {
      id: string;
      user_id: string;
      kind: ClaudeAccountKind;
      status: ClaudeAccountStatus;
      connected_at: string;
      expires_at: string | null;
      encrypted_credential: string | null;
    } | null;
    sandbox: Record<string, unknown> | null;
    owner_member: boolean;
  }>(
    db,
    sql`
      select json_build_object(
        'design', json_build_object('id', d.id, 'workspace_id', d.workspace_id,
                                    'status', d.status, 'owner_id', d.owner_id),
        'claude', (select row_to_json(a) from claude_accounts a
                    where a.id = d.claude_account_id
                       or (d.claude_account_id is null and a.user_id = d.owner_id)
                    order by (a.id = d.claude_account_id) desc limit 1),
        'sandbox', (select row_to_json(s) from sandboxes s where s.design_id = d.id),
        'owner_member', ${ownerMember}
      ) as result
        from designs d
       where d.id = ${designId}
    `,
  );
  if (!result) return null;
  const { design, claude } = result;
  return {
    designId: design.id,
    workspaceId: design.workspace_id,
    status: design.status,
    ownerId: design.owner_id,
    claude: claude && {
      id: claude.id,
      userId: claude.user_id,
      kind: claude.kind,
      status: claude.status,
      connectedAt: new Date(claude.connected_at),
      expiresAt: claude.expires_at ? new Date(claude.expires_at) : null,
      encryptedCredential: claude.encrypted_credential,
    },
    sandbox: result.sandbox ? toSandbox(result.sandbox) : null,
    ownerMember: result.owner_member,
  };
}

/**
 * The awake sandboxes whose runner may hold this Claude account's credential: those of the
 * designs that run on it, and its owner's that have not run yet. The credential lives only in
 * the running runner's memory, so an asleep one holds nothing.
 */
export async function listDesignsWithSandboxOn(
  db: Db,
  { claudeAccountId, userId }: { claudeAccountId: string; userId: string },
): Promise<SandboxRow[]> {
  const rows = await run(
    db
      .select({ sandbox: sandboxes })
      .from(sandboxes)
      .innerJoin(designs, eq(designs.id, sandboxes.designId))
      .where(
        and(
          eq(sandboxes.state, "awake"),
          sql`(${designs.claudeAccountId} = ${claudeAccountId}
               or (${designs.claudeAccountId} is null and ${designs.ownerId} = ${userId}))`,
        ),
      ),
  );
  return rows.map((row) => row.sandbox);
}

/** Record the Claude account a design runs on, if it records none yet. */
export async function recordDesignClaudeAccount(
  db: Db,
  { designId, claudeAccountId }: { designId: string; claudeAccountId: string },
): Promise<void> {
  await run(
    db
      .update(designs)
      .set({ claudeAccountId })
      .where(and(eq(designs.id, designId), sql`${designs.claudeAccountId} is null`)),
  );
}

/** A sandbox as the minute's sweep weighs it. */
export interface SweptSandbox {
  sandbox: SandboxRow;
  designStatus: DesignStatus;
  /** When the design's runner last took the lease or reported its state. */
  heardAt: Date | null;
  /** When the design's current runner took the lease. */
  runnerStartedAt: Date | null;
  /** The runner that holds the lease. */
  runnerId: string | null;
  /** When a runner last wrote something of a turn to the thread. */
  saidAt: Date | null;
  /** What the design's head says its agent is doing. */
  agentState: AgentState;
  /** Whether the design's feed has something its agent must take up (`now` or `next`). */
  pending: boolean;
  /**
   * The events that are owed a turn (docs/cloud.md, "A turn that never came"): the ones that begin
   * one (`TURN_KINDS`, `now` or `next`), delivered after the runner last wrote anything of a turn,
   * that the API has not given up on, oldest first, with when each was delivered.
   */
  owed: { id: string; deliveredAt: Date }[];
  /** Whether the Claude account it runs on can run it now. */
  claudeUsable: boolean;
  /** Whether the design's owner is still a member of its workspace. */
  ownerMember: boolean;
}

/**
 * What the minute's sweep acts on: every sandbox that is moving or awake, and every sandbox of a
 * settled design. Asleep sandboxes of active designs cost almost nothing and are left out.
 */
export async function listSandboxesToSweep(
  db: Db,
  { now }: { now: Date },
): Promise<SweptSandbox[]> {
  const result = await queryJson<{
    rows: {
      sandbox: Record<string, unknown>;
      design_status: DesignStatus;
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
        'design_status', d.status,
        'heard_at', r.heard_at,
        'runner_started_at', r.started_at,
        'runner_id', r.runner_id,
        'said_at', r.said_at,
        'agent_state', d.agent_state,
        'pending', exists (
          select 1 from events e
           where e.design_id = d.id and e.delivered_at is null and e.priority in ('now', 'next')
        ),
        'owed', case when s.state = 'awake' then (
          select json_agg(json_build_object('id', e.id, 'delivered_at', e.delivered_at)
                          order by e.seq)
            from events e
           where e.design_id = d.id and e.delivered_at is not null and e.lapsed_at is null
             and (r.said_at is null or e.delivered_at > r.said_at)
             and e.priority in ('now', 'next')
             and e.kind in (${sql.join(
               TURN_KINDS.map((kind) => sql`${kind}`),
               sql`, `,
             )})
             -- A person's stop after it says not to answer it: never sent again.
             and not exists (
               select 1 from events s
                where s.design_id = e.design_id and s.kind = 'stop' and s.seq > e.seq
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
        join designs d on d.id = s.design_id
        left join design_runners r on r.design_id = s.design_id
       where s.state in ('waking', 'awake', 'stopping') or d.status = 'settled'
    `,
  );
  return (result?.rows ?? []).map((row) => ({
    sandbox: toSandbox(row.sandbox),
    designStatus: row.design_status,
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

/** What reconcile knows of a design a sandbox at Vercel is named for. */
export interface ReconciledDesign {
  /** False when the design was deleted: its id never comes back. */
  exists: boolean;
  status: DesignStatus | null;
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
 * For reconcile: the designs and the sign-ins the sandboxes at Vercel are named for, as the
 * database has them. Every id asked for is in the answer.
 */
export async function getSandboxOwners(
  db: Db,
  { designIds, signInIds }: { designIds: string[]; signInIds: string[] },
): Promise<{
  designs: Map<string, ReconciledDesign>;
  signIns: Map<string, ReconciledSignIn>;
}> {
  const [found, rows, states] = await Promise.all([
    designIds.length
      ? run(
          db
            .select({ id: designs.id, status: designs.status })
            .from(designs)
            .where(inArray(designs.id, designIds)),
        )
      : [],
    designIds.length
      ? run(db.select().from(sandboxes).where(inArray(sandboxes.designId, designIds)))
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
  const statuses = new Map(found.map((design) => [design.id, design.status]));
  const byDesign = new Map(rows.map((row) => [row.designId, row]));
  const byState = new Map(states.map((state) => [state.id, state]));
  return {
    designs: new Map(
      designIds.map((id) => [
        id,
        {
          exists: statuses.has(id),
          status: statuses.get(id) ?? null,
          sandbox: byDesign.get(id) ?? null,
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
 * Whether the design's last checkpoint holds everything its sandbox has done (docs/cloud.md,
 * "How images roll out"): `covered` when no event went into its session after the checkpoint
 * was recorded, `behind` when one did, `none` when its runner has saved none though events went
 * in.
 */
export type CheckpointCover = "covered" | "behind" | "none";

export async function getCheckpointCover(db: Db, designId: string): Promise<CheckpointCover> {
  const result = await queryJson<{
    saved_turn: number | null;
    through: number | null;
    last: number | null;
  }>(
    db,
    sql`
      select json_build_object(
        'saved_turn', (select saved_turn from design_runners where design_id = ${designId}),
        'through', (select saved_through from design_runners where design_id = ${designId}),
        -- A stop and a push are acknowledged without going into the session, and a push after
        -- the turn's checkpoint changes nothing the sleep's would save: neither is work a
        -- checkpoint must hold.
        'last', (select max(seq) from events
                  where design_id = ${designId} and delivered_at is not null
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

/** A design's sandbox with what says which image it runs, for a report on a rollout. */
export interface SandboxImage {
  sandbox: SandboxRow;
  designStatus: DesignStatus;
  /** What its runner said it is when it last started (`design_runners.client`). */
  client: string | null;
}

/** Every sandbox row, oldest first, with what says which image it runs. */
export async function listSandboxImages(db: Db): Promise<SandboxImage[]> {
  const result = await queryJson<{
    rows: {
      sandbox: Record<string, unknown>;
      design_status: DesignStatus;
      client: string | null;
    }[];
  }>(
    db,
    sql`
      select json_build_object('rows', coalesce(json_agg(json_build_object(
        'sandbox', row_to_json(s), 'design_status', d.status, 'client', r.client
      ) order by s.created_at), '[]'::json)) as result
        from sandboxes s
        join designs d on d.id = s.design_id
        left join design_runners r on r.design_id = s.design_id
    `,
  );
  return (result?.rows ?? []).map((row) => ({
    sandbox: toSandbox(row.sandbox),
    designStatus: row.design_status,
    client: row.client,
  }));
}

/** The person behind the newest event in a design's feed that a person is behind. */
function newestPerson(designId: string) {
  return sql`select e.user_id from events e
              where e.design_id = ${designId} and e.user_id is not null
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
