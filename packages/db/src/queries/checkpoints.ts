import type { Doc } from "@ponzu/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { queryJson } from "./json.ts";
import { type OpJson, opJson, type StoredOp, toStoredOp } from "./ops.ts";
import { toStorableJson, unstorableDocument } from "./text.ts";

/**
 * How many of a design's newest ops are always kept, so undo can reach them and a client that
 * is a little behind can catch up without reloading the document.
 */
export const UNDO_DEPTH = 200;

/**
 * How long an op stays in the log at least, whatever has been checkpointed since. An op's id
 * is remembered for as long as its row is, so this is the window in which posting it again
 * answers with the original and appends nothing. A sender must not retry an op older than this.
 */
export const OP_RETENTION_DAYS = 7;

/** What the current document is rebuilt from: apply `ops` to `checkpoint.doc` to reach `seq`. */
export interface DocSource {
  seq: number;
  checkpoint: { seq: number; doc: Doc };
  ops: StoredOp[];
}

/**
 * A design's latest checkpoint and every op after it. One statement, so one snapshot: a
 * checkpoint written in between cannot prune ops out from under the read.
 * Null when there is no such design.
 */
export async function readDocSource(db: Db, designId: string): Promise<DocSource | null> {
  const result = await queryJson<{ seq: number; checkpointSeq: number; doc: Doc; ops: OpJson[] }>(
    db,
    sql`
      select json_build_object(
        'seq', d.seq,
        'checkpointSeq', c.seq,
        'doc', c.doc,
        'ops', (
          select coalesce(json_agg(${opJson("o")} order by o.seq), '[]'::json)
            from design_ops o
           where o.design_id = d.id and o.seq > c.seq
        )
      ) as result
        from designs d
        join lateral (
          select seq, doc
            from design_checkpoints
           where design_id = d.id
           order by seq desc
           limit 1
        ) c on true
       where d.id = ${designId}
    `,
  );
  if (!result) return null;
  return {
    seq: result.seq,
    checkpoint: { seq: result.checkpointSeq, doc: result.doc },
    ops: result.ops.map(toStoredOp),
  };
}

/**
 * Save the document as of `seq`, then drop what it makes redundant: older checkpoints, and the
 * ops `pruneOps` would drop.
 *
 * Nothing is written, and nothing pruned, when the design has not reached `seq` or already has
 * a checkpoint at or after it; a slow writer cannot replace a newer checkpoint with an older one.
 */
export async function writeCheckpoint(
  db: Db,
  { designId, seq, doc }: { designId: string; seq: number; doc: Doc },
): Promise<{ written: boolean; prunedOps: number }> {
  const text = toStorableJson(doc);
  if (text === null) throw unstorableDocument();
  const result = await queryJson<{ written: boolean; prunedOps: number }>(
    db,
    sql`
      with saved as (
        insert into design_checkpoints (design_id, seq, doc)
        select d.id, ${seq}::bigint, ${text}::json
          from designs d
         where d.id = ${designId}
           and d.seq >= ${seq}::bigint
           and not exists (
             select 1
               from design_checkpoints c
              where c.design_id = d.id and c.seq >= ${seq}::bigint
           )
        returning seq
      ),
      superseded as (
        delete from design_checkpoints
         where design_id = ${designId}
           and seq < ${seq}::bigint
           and exists (select 1 from saved)
      ),
      pruned as (
        delete from design_ops
         where ${redundant(designId, sql`${seq}::bigint`)}
           and exists (select 1 from saved)
        returning seq
      )
      select json_build_object(
        'written', exists (select 1 from saved),
        'prunedOps', (select count(*) from pruned)
      ) as result
    `,
  );
  return result ?? { written: false, prunedOps: 0 };
}

/**
 * Drop the ops a design no longer needs: those that are at or before its latest checkpoint,
 * outside its newest `UNDO_DEPTH`, and older than `OP_RETENTION_DAYS`. Answers how many went.
 *
 * `writeCheckpoint` does this as it writes. Call it on its own for a design that has stopped
 * changing, whose last checkpoint came before its last ops were old enough to go.
 */
export async function pruneOps(db: Db, designId: string): Promise<number> {
  const latestCheckpoint = sql`(select max(seq) from design_checkpoints where design_id = ${designId})`;
  const result = await queryJson<{ prunedOps: number }>(
    db,
    sql`
      with pruned as (
        delete from design_ops
         where ${redundant(designId, latestCheckpoint)}
        returning seq
      )
      select json_build_object('prunedOps', (select count(*) from pruned)) as result
    `,
  );
  return result?.prunedOps ?? 0;
}

/** The `where` of a delete from `design_ops`, for a design whose checkpoint is at `checkpointSeq`. */
function redundant(designId: string, checkpointSeq: SQL): SQL {
  return sql`
    design_id = ${designId}
    and seq <= least(
      ${checkpointSeq},
      (select seq from designs where id = ${designId}) - ${UNDO_DEPTH}::bigint
    )
    -- Every op before the first one still inside the retention is older than it. Stopping
    -- there, and not testing each op's age, means a prune reads only the ops it deletes: a
    -- busy design holds a week of them, and a checkpoint is written every few dozen.
    and seq < coalesce(
      (
        select kept.seq
          from design_ops kept
         where kept.design_id = ${designId}
           and kept.created_at >= now() - make_interval(days => ${OP_RETENTION_DAYS})
         order by kept.seq
         limit 1
      ),
      9223372036854775807
    )
  `;
}
