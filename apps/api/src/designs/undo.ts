import { applyOp, type CommittedOp, newOpId, OpError } from "@ponzu/core";
import { appendEvents, commitReversal, type Design, nextRedo, nextUndo } from "@ponzu/db";
import type { Actor as Caller } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { actorOf, toCommittedOp } from "./actor.ts";
import { COMMIT_ATTEMPTS, designBusy } from "./commit.ts";
import { keep, readCurrentDoc } from "./document.ts";
import { eventsForPersonOps } from "./events.ts";

/*
 * Undo is the API's (docs/cloud.md, "Undo"). An undo commits the inverse of the newest op by
 * the caller or by the agent that has not been taken back; a redo commits the inverse of the
 * caller's newest undo. Each goes through the log like any op and comes back as one.
 *
 * The inverse is not judged by who may send what: taking back the agent's edit is how a person
 * says no to it. Nor is it stamped: undoing a deleted thread puts back other people's messages
 * with their own names and times.
 */

type UndoDeps = Pick<Deps, "db" | "docs" | "background">;

/** How many ops an undo passes over whose inverse no longer applies, before it gives up. */
const SKIPS = 20;

export async function reverse(
  deps: UndoDeps,
  {
    design,
    caller,
    kind,
  }: {
    design: Pick<Design, "id" | "agentState" | "agentArtboards">;
    caller: Caller;
    kind: "undo" | "redo";
  },
): Promise<{ committed: CommittedOp; seq: number }> {
  const actor = actorOf(caller);
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const current = await readCurrentDoc(deps, design.id);
    if (!current) throw new ApiError(404, "not_found", "There is no such design.");
    const doc = structuredClone(current.doc);
    const query = { designId: design.id, actorId: actor.id };

    let target = kind === "undo" ? await nextUndo(deps.db, query) : await nextRedo(deps.db, query);
    let inverse: ReturnType<typeof applyOp> | undefined;
    for (let skipped = 0; target && !inverse; skipped++) {
      try {
        inverse = applyOp(doc, target.inverse);
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
        // Later ops took away what it changed. An undo looks further back; a redo has no
        // other undo to take back, since a new op ends the chance to redo.
        target =
          kind === "undo" && skipped < SKIPS
            ? await nextUndo(deps.db, { ...query, olderThan: target.seq })
            : null;
      }
    }
    if (!target || !inverse) {
      throw kind === "undo"
        ? new ApiError(409, "nothing_to_undo", "There is nothing left to undo.")
        : new ApiError(409, "nothing_to_redo", "There is nothing to redo.");
    }

    const result = await commitReversal(deps.db, {
      designId: design.id,
      expectedSeq: current.seq,
      actor,
      kind,
      reverses: target.seq,
      op: { id: newOpId(), op: target.inverse, inverse },
    });
    if (result.kind === "conflict") continue;
    if (result.kind === "unstorable") {
      throw new Error("An inverse from the log could not be stored again.");
    }
    keep(deps, design.id, current, { seq: result.seq, doc, ops: result.ops });
    if (caller.kind === "user") {
      await appendEvents(deps.db, eventsForPersonOps(design, caller.user.id, result.ops, doc));
    }
    return { committed: toCommittedOp(result.ops[0]!), seq: result.seq };
  }
  throw designBusy();
}
