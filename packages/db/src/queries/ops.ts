import type { Op } from "@ponzu/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { ActorKind, OpKind } from "../schema/index.ts";
import { queryJson } from "./json.ts";
import { isStorable, toStorableJson } from "./text.ts";

/** Who made a change. It comes from the caller's token, never from what they sent. */
export interface Actor {
  kind: ActorKind;
  /** A user id, or the agent's id. */
  id: string;
  name: string;
  avatarUrl?: string;
}

/** An op as the log holds it. */
export interface StoredOp {
  seq: number;
  /** The sender's id for it. */
  id: string;
  op: Op;
  inverse: Op;
  kind: OpKind;
  /** For an undo or a redo, the seq of the op it took back. */
  reverses: number | null;
  /** The seq of the undo or redo that took this one back. */
  reversedBy: number | null;
  actor: Actor;
  at: Date;
}

/** An op to append: already validated, sanitized and applied by the caller, which is how it has an inverse. */
export interface NewOp {
  id: string;
  op: Op;
  inverse: Op;
}

export type CommitResult =
  | {
      kind: "committed";
      /** The design's seq afterwards. */
      seq: number;
      /** One per op given, in the order given. */
      ops: StoredOp[];
      /** The ids that were in the log already. Their `ops` are the originals; nothing was appended for them. */
      replayed: string[];
    }
  /**
   * Nothing was written: the design is not at `expectedSeq` (or is gone). Read the ops after
   * the seq you have, apply them, and commit again.
   */
  | { kind: "conflict" }
  /**
   * Nothing was written: these ops hold text Postgres cannot store (see `isStorable`). The
   * later ops in the batch were applied on top of them, so the batch cannot go in without
   * them; reject these while validating, before applying anything.
   */
  | { kind: "unstorable"; ids: string[] };

/**
 * Append ops to a design's log and move `designs.seq` past them, or do neither.
 *
 * It is one statement, so it is atomic over Neon's HTTP driver, which has no interactive
 * transactions. The update of the design's row is the gate: it matches only while `seq` is
 * still `expectedSeq`, and the insert takes its rows only if that update happened. Of two
 * callers racing on one `expectedSeq`, the second waits on the row lock, looks again, finds
 * `seq` moved and writes nothing.
 *
 * An op whose id is already in the log is not appended again; the stored op comes back in its
 * place. A batch made only of such ops succeeds whatever `expectedSeq` says, so a retry is
 * safe for as long as the log keeps the op: `OP_RETENTION_DAYS` at least (see `writeCheckpoint`).
 */
export function commitOps(
  db: Db,
  input: { designId: string; expectedSeq: number; actor: Actor; ops: NewOp[] },
): Promise<CommitResult> {
  return commit(
    db,
    input,
    input.ops.map((op) => ({ ...op, kind: "do", reverses: null })),
  );
}

export interface LogEntry extends NewOp {
  kind: OpKind;
  reverses: number | null;
}

/** The statement behind `commitOps` and `commitReversal`. */
export async function commit(
  db: Db,
  { designId, expectedSeq, actor }: { designId: string; expectedSeq: number; actor: Actor },
  entries: LogEntry[],
): Promise<CommitResult> {
  if (entries.length === 0) throw new Error("A commit needs at least one op.");
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("The ops in one commit must have distinct ids.");
  }
  const texts = entries.map(toStorableJson);
  const unstorable = entries.filter((_, index) => texts[index] === null).map((entry) => entry.id);
  if (unstorable.length > 0) return { kind: "unstorable", ids: unstorable };
  // One parameter however long the batch is. `json` keeps each op's text as sent, so `->` hands
  // back the op with its keys in the order the caller wrote them.
  const batch = `[${texts.join(",")}]`;
  const result = await queryJson<{
    seq: number;
    conflict: boolean;
    ops: { replayed: boolean; op: OpJson }[];
  }>(
    db,
    sql`
      with input as (
        select t.ord,
               t.e->>'id' as client_op_id,
               t.e->'op' as op,
               t.e->'inverse' as inverse,
               t.e->>'kind' as kind,
               (t.e->>'reverses')::bigint as reverses_seq
          from json_array_elements(${batch}::json) with ordinality as t(e, ord)
      ),
      replayed as (
        select i.ord, o.*
          from input i
          join design_ops o on o.design_id = ${designId} and o.client_op_id = i.client_op_id
      ),
      fresh as (
        select i.*, row_number() over (order by i.ord) as n
          from input i
         where not exists (select 1 from replayed r where r.ord = i.ord)
      ),
      bumped as (
        update designs
           set seq = seq + (select count(*) from fresh),
               last_activity_at = now(),
               updated_at = now()
         where id = ${designId}
           and seq = ${expectedSeq}
           and exists (select 1 from fresh)
           -- An undo takes back a do or a redo, a redo takes back an undo, and only once.
           and not exists (
             select 1
               from fresh f
              where f.reverses_seq is not null
                and not exists (
                  select 1
                    from design_ops target
                   where target.design_id = ${designId}
                     and target.seq = f.reverses_seq
                     and target.reversed_by_seq is null
                     and (target.kind = 'undo') = (f.kind = 'redo')
                )
           )
        returning seq
      ),
      appended as (
        insert into design_ops (
          design_id, seq, client_op_id, op, inverse, kind, reverses_seq,
          actor_kind, actor_id, actor_name, actor_avatar_url
        )
        select ${designId}, ${expectedSeq} + f.n, f.client_op_id, f.op, f.inverse, f.kind,
               f.reverses_seq, ${actor.kind}, ${actor.id}, ${actor.name}, ${actor.avatarUrl ?? null}
          from fresh f
         where exists (select 1 from bumped)
        returning *
      ),
      reversed as (
        update design_ops target
           set reversed_by_seq = a.seq
          from appended a
         where target.design_id = ${designId} and target.seq = a.reverses_seq
      )
      select json_build_object(
        'seq', coalesce((select seq from bumped), (select seq from designs where id = ${designId})),
        'conflict', exists (select 1 from fresh) and not exists (select 1 from bumped),
        'ops', (
          select coalesce(json_agg(json_build_object('replayed', x.replayed, 'op', x.op) order by x.ord), '[]'::json)
            from (
              select r.ord, true as replayed, ${opJson("r")} as op from replayed r
              union all
              select f.ord, false, ${opJson("a")}
                from appended a
                join fresh f on f.client_op_id = a.client_op_id
            ) x
        )
      ) as result
    `,
  );
  if (!result || result.conflict) return { kind: "conflict" };
  return {
    kind: "committed",
    seq: result.seq,
    ops: result.ops.map((entry) => toStoredOp(entry.op)),
    replayed: result.ops.filter((entry) => entry.replayed).map((entry) => entry.op.id),
  };
}

export type ReadOpsResult =
  | {
      kind: "ok";
      /** The design's seq. When the last op read is below it, read again from there. */
      seq: number;
      ops: StoredOp[];
    }
  /** The ops right after `after` have been pruned. Start again from the document. */
  | { kind: "too_old"; seq: number };

/** The ops after `after`, oldest first, at most `limit` of them. Null when there is no such design. */
export async function readOps(
  db: Db,
  { designId, after, limit = 500 }: { designId: string; after: number; limit?: number },
): Promise<ReadOpsResult | null> {
  const result = await queryJson<{ seq: number; ops: OpJson[] }>(
    db,
    sql`
      select json_build_object(
        'seq', d.seq,
        'ops', (
          select coalesce(json_agg(${opJson("o")} order by o.seq), '[]'::json)
            from (
              select *
                from design_ops
               where design_id = d.id and seq > ${after}
               order by seq
               limit ${limit}
            ) o
        )
      ) as result
        from designs d
       where d.id = ${designId}
    `,
  );
  if (!result) return null;
  // The log has no gaps, so the first op after `after` is `after + 1` unless it was pruned.
  const first = result.ops[0]?.seq ?? result.seq + 1;
  if (after < result.seq && first !== after + 1) return { kind: "too_old", seq: result.seq };
  return { kind: "ok", seq: result.seq, ops: result.ops.map(toStoredOp) };
}

/**
 * The ops in a design's log with these sender ids. The API asks before applying a batch, so an
 * op that was already committed is answered from the log and not applied a second time.
 */
export async function findOps(
  db: Db,
  { designId, ids }: { designId: string; ids: string[] },
): Promise<StoredOp[]> {
  // An id Postgres cannot store is not in the log, and asking for it would fail the query.
  const known = ids.filter(isStorable);
  if (known.length === 0) return [];
  const result = await queryJson<{ ops: OpJson[] }>(
    db,
    sql`
      select json_build_object(
        'ops', coalesce(json_agg(${opJson("o")} order by o.seq), '[]'::json)
      ) as result
        from design_ops o
       where o.design_id = ${designId} and o.client_op_id in ${known}
    `,
  );
  return (result?.ops ?? []).map(toStoredOp);
}

export interface OpJson {
  seq: number;
  id: string;
  op: Op;
  inverse: Op;
  kind: OpKind;
  reverses: number | null;
  reversedBy: number | null;
  actorKind: ActorKind;
  actorId: string;
  actorName: string;
  actorAvatarUrl: string | null;
  /** Milliseconds since the epoch. */
  at: number;
}

/** A `design_ops` row as json, where `row` is the statement's name for the row. */
export function opJson(row: string): SQL {
  const o = sql.raw(row);
  return sql`json_build_object(
    'seq', ${o}.seq,
    'id', ${o}.client_op_id,
    'op', ${o}.op,
    'inverse', ${o}.inverse,
    'kind', ${o}.kind,
    'reverses', ${o}.reverses_seq,
    'reversedBy', ${o}.reversed_by_seq,
    'actorKind', ${o}.actor_kind,
    'actorId', ${o}.actor_id,
    'actorName', ${o}.actor_name,
    'actorAvatarUrl', ${o}.actor_avatar_url,
    'at', floor(extract(epoch from ${o}.created_at) * 1000)
  )`;
}

export function toStoredOp(json: OpJson): StoredOp {
  return {
    seq: json.seq,
    id: json.id,
    op: json.op,
    inverse: json.inverse,
    kind: json.kind,
    reverses: json.reverses,
    reversedBy: json.reversedBy,
    actor: {
      kind: json.actorKind,
      id: json.actorId,
      name: json.actorName,
      ...(json.actorAvatarUrl ? { avatarUrl: json.actorAvatarUrl } : {}),
    },
    at: new Date(json.at),
  };
}
