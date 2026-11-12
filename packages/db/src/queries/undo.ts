import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { UNDO_DEPTH } from "./checkpoints.ts";
import { queryJson } from "./json.ts";
import {
  type CommitInput,
  type CommitResult,
  commit,
  type NewOp,
  type OpJson,
  opJson,
  type StoredOp,
  toStoredOp,
} from "./ops.ts";

/**
 * The op an undo by `actorId` would take back: the newest do or redo, by them or by an agent,
 * that has not been taken back, within the newest `UNDO_DEPTH` ops.
 *
 * `olderThan` skips past an op whose inverse no longer applies to the document.
 */
export async function nextUndo(
  db: Db,
  { canvasId, actorId, olderThan }: { canvasId: string; actorId: string; olderThan?: number },
): Promise<StoredOp | null> {
  const result = await queryJson<OpJson>(
    db,
    sql`
      select ${opJson("o")} as result
        from canvas_ops o
       where o.canvas_id = ${canvasId}
         and o.kind in ('do', 'redo')
         and o.reversed_by_seq is null
         and (o.actor_id = ${actorId} or o.actor_kind = 'agent')
         and o.seq > (select seq from canvases where id = ${canvasId}) - ${UNDO_DEPTH}::bigint
         ${olderThan === undefined ? sql.empty() : sql`and o.seq < ${olderThan}`}
       order by o.seq desc
       limit 1
    `,
  );
  return result && toStoredOp(result);
}

/**
 * The undo a redo by `actorId` would take back: their newest undo that has not been redone.
 * A new op by them or by an agent since then ends the chance to redo, as in any editor.
 */
export async function nextRedo(
  db: Db,
  { canvasId, actorId }: { canvasId: string; actorId: string },
): Promise<StoredOp | null> {
  const result = await queryJson<OpJson>(
    db,
    sql`
      select ${opJson("o")} as result
        from canvas_ops o
       where o.canvas_id = ${canvasId}
         and o.kind = 'undo'
         and o.reversed_by_seq is null
         and o.actor_id = ${actorId}
         and not exists (
           select 1
             from canvas_ops later
            where later.canvas_id = o.canvas_id
              and later.seq > o.seq
              and later.kind = 'do'
              and (later.actor_id = ${actorId} or later.actor_kind = 'agent')
         )
       order by o.seq desc
       limit 1
    `,
  );
  return result && toStoredOp(result);
}

/**
 * Record an undo or a redo: append `op`, which is the target's inverse as the caller applied
 * it, and mark the target taken back, in the one statement `commitOps` uses.
 *
 * It is a conflict, and nothing is written, if the canvas moved or the target is no longer
 * there to take back. Ask `nextUndo` or `nextRedo` again.
 */
export function commitReversal(
  db: Db,
  input: CommitInput & {
    kind: "undo" | "redo";
    /** The seq of the op being taken back. */
    reverses: number;
    op: NewOp;
  },
): Promise<CommitResult> {
  return commit(db, input, [{ ...input.op, kind: input.kind, reverses: input.reverses }]);
}
