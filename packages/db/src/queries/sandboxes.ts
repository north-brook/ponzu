import { and, eq, getTableColumns, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type AgentBlocker,
  type AgentState,
  type ClaudeAccountKind,
  type ClaudeAccountStatus,
  type DesignStatus,
  designs,
  type SandboxStatus,
  sandboxes,
} from "../schema/index.ts";
import { TURN_KINDS } from "./events.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A design's sandbox as the API drives it (docs/cloud.md, "The sandbox"). The database decides
 * every move: a design has at most one sandbox that is not `gone` (a unique index), and each
 * move between states holds to the states it moves from, so of two function instances racing
 * on one sandbox only one moves it. Leaving `awake` meters the stretch it was awake for, in the
 * statement that moves it, so awake time is never lost and never counted twice.
 */

export type Sandbox = typeof sandboxes.$inferSelect;

/** Where the API reaches the runner of a design whose sandbox is awake, its token sealed. */
export async function getAwakeSandboxAddress(
  db: Db,
  designId: string,
): Promise<{ sandboxId: string; address: string; encryptedAddressToken: string | null } | null> {
  const [row] = await run(
    db
      .select({
        sandboxId: sandboxes.id,
        address: sandboxes.address,
        encryptedAddressToken: sandboxes.encryptedAddressToken,
      })
      .from(designs)
      .innerJoin(sandboxes, eq(sandboxes.id, designs.sandboxId))
      .where(
        and(eq(designs.id, designId), eq(sandboxes.state, "awake"), isNotNull(sandboxes.address)),
      ),
  );
  return row ? { ...row, address: row.address! } : null;
}

/** The design's sandbox that is not gone, if it has one. */
export async function getLiveSandbox(db: Db, designId: string): Promise<Sandbox | null> {
  const [row] = await run(
    db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.designId, designId), ne(sandboxes.state, "gone"))),
  );
  return row ?? null;
}

/** The design's sandboxes that are not gone. At most one, unless something is badly wrong. */
export function listLiveSandboxes(db: Db, designId: string): Promise<Sandbox[]> {
  return run(
    db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.designId, designId), ne(sandboxes.state, "gone"))),
  );
}

/**
 * How long a wake holds a `waking` sandbox without moving it before another may take it over:
 * longer than one attempt of a wake can take, so a wake still trying is never taken for one
 * that died. The minute's sweep repairs a row left this long.
 */
export const WAKING_LEASE_MS = 6 * 60_000;

/** How many sandboxes may be waking or awake at once, in one workspace and for one owner. */
export interface SandboxLimits {
  perWorkspace: number;
  perOwner: number;
}

/**
 * What a wake's claim on a sandbox came to: the sandbox, now `waking` and held by the wake;
 * `full` when its workspace or its owner has as many sandboxes up as `SandboxLimits` allow; or
 * null when another wake holds it, or it is in no state a wake takes it from.
 */
export type SandboxClaim = { sandbox: Sandbox } | { full: true } | null;

/**
 * Begin the design's next sandbox for the wake `by`: a row of the next generation, `waking`,
 * with no provider sandbox yet, which the design now points at. Null when the design already
 * has one that is not gone: whoever made that one makes the sandbox.
 */
export async function beginSandbox(
  db: Db,
  {
    designId,
    provider,
    now,
    by,
    limits,
  }: {
    designId: string;
    provider: Sandbox["provider"];
    now: Date;
    by: string;
    limits: SandboxLimits;
  },
): Promise<SandboxClaim> {
  const at = timeParam(now);
  const result = await queryJson<MoveResult>(
    db,
    sql`
      with made as (
        insert into sandboxes (id, design_id, generation, provider, state, state_at, waking_by,
                               last_activity_at, awake_user_id)
        select ${newId("sbx")}, d.id,
               coalesce((select max(generation) from sandboxes where design_id = d.id), 0) + 1,
               ${provider}, 'waking', ${at}::timestamptz, ${by}, ${at}::timestamptz,
               (${newestPerson(designId)})
          from designs d
         where d.id = ${designId} and ${roomFor(sql`d.id`, limits)}
        on conflict (design_id) where state <> 'gone' do nothing
        returning *
      ),
      pointed as (
        update designs set sandbox_id = made.id from made where designs.id = made.design_id
      )
      select json_build_object(
        'row', (select row_to_json(made) from made),
        'full', not ${roomFor(sql`${designId}`, limits)}
      ) as result
    `,
  );
  return claimFrom(result);
}

/**
 * Take the sandbox for the wake `by`, moving it into `waking` from one of `from`. A wake takes
 * one that is `waking` only if it holds it already, or it was left unmoved for a lease. Counted
 * against `limits` in the same statement, beside every other sandbox up in the design's
 * workspace and for its owner.
 */
export async function claimSandbox(
  db: Db,
  {
    id,
    from,
    now,
    by,
    limits,
  }: {
    id: string;
    from: readonly SandboxStatus[];
    now: Date;
    by: string;
    limits: SandboxLimits;
  },
): Promise<SandboxClaim> {
  return claimFrom(await move(db, { id, from, to: "waking", now, by, limits }));
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

/** What a move can set beside the state, for the states that carry it. */
export interface SandboxChanges {
  providerId?: string;
  address?: string | null;
  encryptedAddressToken?: string | null;
  runnerTokenId?: string | null;
  claudeCredential?: string | null;
  autoStopAt?: Date | null;
  failure?: string | null;
}

/** A move of a sandbox, and what it holds to beside the states it moves from. */
interface Move {
  id: string;
  from: readonly SandboxStatus[];
  to: SandboxStatus;
  now: Date;
  /**
   * The wake making the move. One that is `waking` moves only for the wake that holds it, or
   * once it has sat unmoved for a lease.
   */
  by?: string;
  /** Only if it has been in its state since before then: a repair of a move left halfway. */
  stateBefore?: Date;
  /** Only if nobody has kept it awake since then, so a stop never wins over a fresh message. */
  idleBefore?: Date;
  changes?: SandboxChanges;
  /** Only if there is room for one more sandbox up (`claimSandbox`). */
  limits?: SandboxLimits;
}

/**
 * Move a sandbox from one of `from` to `to` as of `now`, with `changes`, and answer the row as
 * it is now; null when it was in none of `from` (someone else moved it first) or a condition of
 * the move did not hold. A wake moves into `waking` with `claimSandbox`, which says why it
 * could not. Moving into `awake` starts its meter; moving out of it records the stretch as a
 * usage event, put down to the person who woke it or last kept it awake, in the same statement.
 */
export async function moveSandbox(db: Db, request: Omit<Move, "limits">): Promise<Sandbox | null> {
  const result = await move(db, request);
  return result?.row ? toSandbox(result.row) : null;
}

async function move(
  db: Db,
  { id, from, to, now, by, stateBefore, idleBefore, changes = {}, limits }: Move,
): Promise<MoveResult | null> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const set = [
    sql`state = ${to}`,
    sql`state_at = ${at}`,
    sql`updated_at = ${at}`,
    sql`waking_by = ${to === "waking" ? (by ?? null) : null}`,
    to === "awake"
      ? sql`awake_since = case when s.state = 'awake' then s.awake_since else ${at} end`
      : sql`awake_since = null`,
    // A wake is activity: the idle clock starts again from it.
    ...(to === "awake" || to === "waking" ? [sql`last_activity_at = ${at}`] : []),
    to === "failed" || to === "gone"
      ? sql`failure = ${changes.failure ?? null}`
      : sql`failure = null`,
  ];
  const column = {
    providerId: "provider_id",
    address: "address",
    encryptedAddressToken: "encrypted_address_token",
    runnerTokenId: "runner_token_id",
    claudeCredential: "claude_credential",
  } as const;
  for (const [key, name] of Object.entries(column) as [keyof typeof column, string][]) {
    if (changes[key] !== undefined) set.push(sql`${sql.raw(name)} = ${changes[key]}`);
  }
  if (changes.autoStopAt !== undefined) {
    set.push(
      sql`auto_stop_at = ${changes.autoStopAt ? timeParam(changes.autoStopAt) : null}::timestamptz`,
    );
  } else if (to !== "awake" && to !== "waking") {
    set.push(sql`auto_stop_at = null`);
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
      sql`(s.state <> 'waking' or s.waking_by = ${by} or s.state_at < ${leaseOver}::timestamptz)`,
    );
  }
  if (stateBefore) conditions.push(sql`s.state_at < ${timeParam(stateBefore)}::timestamptz`);
  if (idleBefore) {
    conditions.push(sql`s.last_activity_at < ${timeParam(idleBefore)}::timestamptz`);
  }
  if (limits) conditions.push(roomFor(sql`s.design_id`, limits));
  return queryJson<MoveResult>(
    db,
    sql`
      with before as (
        select id, design_id, state, awake_since from sandboxes where id = ${id}
      ),
      moved as (
        update sandboxes s
           set ${sql.join(set, sql`, `)}
         where s.id = ${id} and ${sql.join(conditions, sql` and `)}
        returning s.*
      ),
      metered as (
        insert into usage_events (id, workspace_id, design_id, user_id, kind, seconds, payer,
                                  rate_card_version, occurred_at)
        select b.id || '/' || floor(extract(epoch from b.awake_since) * 1000)::bigint,
               d.workspace_id, d.id, m.awake_user_id, 'sandbox',
               greatest(0, round(extract(epoch from (${at} - b.awake_since))))::int,
               'ponzu',
               coalesce(
                 (select max(version) from rate_cards where effective_from <= b.awake_since),
                 (select min(version) from rate_cards)
               ),
               b.awake_since
          from moved m
          join before b on b.id = m.id
          join designs d on d.id = m.design_id
         where b.state = 'awake' and m.state <> 'awake'
        on conflict (id) do nothing
      )
      select json_build_object(
        'row', (select row_to_json(moved) from moved),
        'full', ${limits ? sql`not ${roomFor(sql`(select design_id from before)`, limits)}` : sql`false`}
      ) as result
    `,
  );
}

/**
 * Something kept the design's sandbox awake as of `now`: a person did something, or its agent
 * reported working. Its awake time is put down to the person behind the newest event in the
 * design's feed. Answers the sandbox's state, or null when it has none that is not gone.
 */
export async function touchSandbox(
  db: Db,
  { designId, now }: { designId: string; now: Date },
): Promise<SandboxStatus | null> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({
        lastActivityAt: sql`greatest(${sandboxes.lastActivityAt}, ${timeParam(now)}::timestamptz)`,
        awakeUserId: sql`coalesce((${newestPerson(designId)}), ${sandboxes.awakeUserId})`,
      })
      .where(and(eq(sandboxes.designId, designId), ne(sandboxes.state, "gone")))
      .returning({ state: sandboxes.state }),
  );
  return row?.state ?? null;
}

/** Record the provider's auto-stop deadline after moving it out. */
export async function setSandboxAutoStop(
  db: Db,
  { id, autoStopAt }: { id: string; autoStopAt: Date },
): Promise<void> {
  await run(
    db
      .update(sandboxes)
      .set({ autoStopAt: sql`${timeParam(autoStopAt)}::timestamptz` })
      .where(and(eq(sandboxes.id, id), eq(sandboxes.state, "awake"))),
  );
}

/** Count a restart of a runner that was found dead. Answers how many there have been in a row. */
export async function countSandboxRestart(db: Db, id: string): Promise<number> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({ restarts: sql`${sandboxes.restarts} + 1` })
      .where(eq(sandboxes.id, id))
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
  sandbox: Sandbox | null;
  /**
   * Whether the owner, whose Claude it runs on, is still a member of its workspace. Someone who
   * has left lends their Claude to nothing there.
   */
  ownerMember: boolean;
  /**
   * Whether the runner token the sandbox's environment carries is still good for a day, by
   * Postgres's clock, which is what the token's expiry is checked against.
   */
  runnerTokenGood: boolean;
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
    token_good: boolean;
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
        'sandbox', (select row_to_json(s) from sandboxes s
                     where s.design_id = d.id and s.state <> 'gone'),
        'owner_member', ${ownerMember},
        'token_good', exists (
          select 1 from sandboxes s join runner_tokens t on t.id = s.runner_token_id
           where s.design_id = d.id and s.state <> 'gone' and t.revoked_at is null
             and t.expires_at > now() + interval '1 day'
        )
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
    runnerTokenGood: result.token_good,
  };
}

/**
 * The designs with a sandbox that is not gone whose environment may carry this Claude account's
 * credential: those that run on it, and its owner's that have not run yet.
 */
export async function listDesignsWithSandboxOn(
  db: Db,
  { claudeAccountId, userId }: { claudeAccountId: string; userId: string },
): Promise<string[]> {
  const rows = await run(
    db
      .selectDistinct({ id: designs.id })
      .from(designs)
      .innerJoin(sandboxes, eq(sandboxes.designId, designs.id))
      .where(
        and(
          ne(sandboxes.state, "gone"),
          sql`(${designs.claudeAccountId} = ${claudeAccountId}
               or (${designs.claudeAccountId} is null and ${designs.ownerId} = ${userId}))`,
        ),
      ),
  );
  return rows.map((row) => row.id);
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
  sandbox: Sandbox;
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
  /**
   * Whether its environment may keep the Claude credential it carries: the account it runs on
   * is still connected (or only expired), and its owner is still in the design's workspace.
   */
  claudeHeld: boolean;
  /** Whether the design's owner is still a member of its workspace. */
  ownerMember: boolean;
}

/**
 * What the minute's sweep acts on: every sandbox that is moving or awake, and every sandbox
 * that is not gone of a settled design, or whose environment may no longer keep the Claude
 * credential it carries. Asleep sandboxes of active designs cost nothing and are left out.
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
      claude_revoked: boolean;
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
        'claude_revoked', f.claude_revoked,
        'owner_member', f.owner_member
      )), '[]'::json)) as result
        from sandboxes s
        join designs d on d.id = s.design_id
        cross join lateral (
          select exists (select 1 from claude_accounts a where ${runsOn} and a.status = 'revoked')
                   as claude_revoked,
                 ${ownerMember} as owner_member
        ) f
        left join design_runners r on r.design_id = s.design_id
       where s.state <> 'gone'
         and (s.state in ('waking', 'awake', 'stopping') or d.status = 'settled'
              or f.claude_revoked or not f.owner_member)
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
    claudeHeld: !row.claude_revoked && row.owner_member,
    ownerMember: row.owner_member,
  }));
}

/**
 * Whether the provider sandbox `providerId`, which carries the design's label, is one the
 * database still owns: the provider id of a sandbox of a design that exists and is not gone, or
 * possibly one being made right now (a design whose sandbox has been `waking` without a provider
 * id for less than a lease). Past that the sweep's repair has found or given up on it.
 */
export async function isSandboxKnown(
  db: Db,
  { designId, providerId, now }: { designId: string; providerId: string; now: Date },
): Promise<boolean> {
  const leaseOver = timeParam(new Date(now.getTime() - WAKING_LEASE_MS));
  const [row] = await run(
    db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.designId, designId),
          ne(sandboxes.state, "gone"),
          sql`(${sandboxes.providerId} = ${providerId}
               or (${sandboxes.providerId} is null and ${sandboxes.state} = 'waking'
                   and ${sandboxes.stateAt} >= ${leaseOver}::timestamptz))`,
        ),
      ),
  );
  return row !== undefined;
}

/** The person behind the newest event in a design's feed that a person is behind. */
function newestPerson(designId: string) {
  return sql`select e.user_id from events e
              where e.design_id = ${designId} and e.user_id is not null
              order by e.seq desc limit 1`;
}

const COLUMNS = Object.entries(getTableColumns(sandboxes));

/** A row as `row_to_json` writes it, back to what Drizzle would have read. */
function toSandbox(json: Record<string, unknown>): Sandbox {
  const row: Record<string, unknown> = {};
  for (const [key, column] of COLUMNS) {
    const value = json[column.name] ?? null;
    row[key] =
      value !== null && column.columnType === "PgTimestamp" ? new Date(String(value)) : value;
  }
  return row as Sandbox;
}
