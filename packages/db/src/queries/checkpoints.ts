import type { Doc } from "@ponzu/core";
import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { queryJson } from "./json.ts";
import { type OpJson, opJson, type StoredOp, toStoredOp } from "./ops.ts";

/**
 * How many of a design's newest ops are always kept, so undo can reach them and a client that
 * is a little behind can catch up without reloading the document.
 */
export const UNDO_DEPTH = 200;

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
 * Save the document as of `seq`, then drop what it makes redundant: older checkpoints, and ops
 * that are both at or before the checkpoint and outside the newest `UNDO_DEPTH`.
 *
 * Nothing is written, and nothing pruned, when the design has not reached `seq` or already has
 * a checkpoint at or after it; a slow writer cannot replace a newer checkpoint with an older one.
 */
export async function writeCheckpoint(
  db: Db,
  { designId, seq, doc }: { designId: string; seq: number; doc: Doc },
): Promise<{ written: boolean; prunedOps: number }> {
  const result = await queryJson<{ written: boolean; prunedOps: number }>(
    db,
    sql`
      with saved as (
        insert into design_checkpoints (design_id, seq, doc)
        select d.id, ${seq}::bigint, ${JSON.stringify(doc)}::json
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
         where design_id = ${designId}
           and seq <= least(
             ${seq}::bigint,
             (select seq from designs where id = ${designId}) - ${UNDO_DEPTH}::bigint
           )
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
