import {
  type Actor,
  applyOp,
  type CommitResult,
  type Doc,
  InvalidOpError,
  type Op,
  OpError,
  resolveOp,
  sanitizeOp,
  stampOp,
  validateOp,
} from "@ponzu/core";
import { type CommitInput, commitOps, type Design, findOps, type NewOp } from "@ponzu/db";
import { appSession } from "../analytics/scope.ts";
import type { Actor as Caller } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { requestWake, type WakeDeps } from "../sandboxes/wake.ts";
import { actorOf, personFor, toCommittedOp } from "./actor.ts";
import { keep, readCurrentDoc } from "./document.ts";
import { eventsForPersonOps } from "./events.ts";
import { refusal } from "./op-rules.ts";

/*
 * Committing a post of ops (docs/cloud.md, "Committing"). The body was checked whole by
 * `validateCommit`; here each op is validated, sanitized, stamped, authorized and applied to
 * the current document in turn, and the ones that apply are appended in one statement that
 * holds only if the design is still at the seq they were applied to. When it has moved, the
 * whole post is worked out again on the newer document.
 */

type CommitDeps = Pick<Deps, "db" | "docs" | "background" | "clock" | "analytics"> & WakeDeps;

/** How many times a post is worked out again on a newer document before the caller is told to retry. */
export const COMMIT_ATTEMPTS = 5;

export const designBusy = () =>
  new ApiError(503, "design_busy", "This design is changing quickly. Try again in a moment.");

export async function commitPost(
  deps: CommitDeps,
  {
    design,
    caller,
    posted,
  }: {
    design: Pick<Design, "id" | "agentState" | "agentArtboards">;
    caller: Caller;
    posted: { id: string; op: unknown }[];
  },
): Promise<CommitResult> {
  const actor = actorOf(caller);
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const current = await readCurrentDoc(deps, design.id);
    if (!current) throw new ApiError(404, "not_found", "There is no such design.");
    // Asked after the document is read: an op committed before that read is found here, and
    // one committed after it moved the seq, so the commit below fails and this runs again.
    const replayed = await findOps(deps.db, { designId: design.id, ids: posted.map((p) => p.id) });
    const known = new Set(replayed.map((stored) => stored.id));

    const doc = structuredClone(current.doc);
    const at = deps.clock.now();
    const fresh: NewOp[] = [];
    const rejected: CommitResult["rejected"] = [];
    for (const { id, op } of posted) {
      if (known.has(id)) continue;
      const outcome = prepare(doc, op, actor, at);
      if ("reason" in outcome) rejected.push({ id, reason: outcome.reason });
      else fresh.push({ id, ...outcome });
    }
    if (fresh.length === 0) {
      return { committed: replayed.map(toCommittedOp), rejected, seq: current.seq };
    }

    // A person's ops tell the agent, from the app session they came from.
    const posthogSessionId = appSession();
    const events =
      caller.kind === "user"
        ? eventsForPersonOps(design, personFor(caller.user), fresh, {
            before: current.doc,
            after: doc,
          }).map((event) => ({ ...event, posthogSessionId }))
        : [];
    const result = await commitOps(deps.db, {
      designId: design.id,
      expectedSeq: current.seq,
      actor,
      ops: fresh,
      events,
      head: headChange(current.doc, doc),
    });
    if (result.kind === "conflict") continue;
    if (result.kind === "unstorable") {
      // `validateOp` refuses text Postgres cannot hold, so this is a bug, not a bad request.
      throw new Error(`Validated ops could not be stored: ${result.ids.join(", ")}`);
    }
    // Every op this post appended. One that was in the log already was appended by another
    // request racing this one with the same ids; the document here is then not the design's.
    const appended = result.ops.filter((stored) => !result.replayed.includes(stored.id));
    if (result.replayed.length === 0) {
      keep(deps, design.id, current, { seq: result.seq, doc, ops: appended });
    }
    if (caller.kind === "user" && appended.length > 0) {
      const commented = events.some((event) => event.kind === "comment");
      const added = new Set(appended.map((stored) => stored.id));
      for (const event of events) {
        if (event.kind !== "comment" || !added.has(event.opId)) continue;
        deps.analytics.capture("comment posted", {
          design_id: design.id,
          reply: (event.payload as { reply?: unknown }).reply === true,
        });
      }
      await requestWake(deps, design.id, commented ? "comment" : "edit");
    }
    const committed = [...replayed, ...result.ops].sort((a, b) => a.seq - b.seq);
    return { committed: committed.map(toCommittedOp), rejected, seq: result.seq };
  }
  throw designBusy();
}

/**
 * The design's name and icon after ops took `before` to `after`, when they changed either. The
 * document is where the name lives (the agent's tools read and set it there), and the row
 * follows it in the same statement, for lists and live queries to show.
 */
export function headChange(before: Doc, after: Doc): CommitInput["head"] {
  if (before.name === after.name && before.icon === after.icon) return undefined;
  return { name: after.name, icon: after.icon ?? null };
}

/**
 * One op, made ready and applied to `doc`, or why it cannot be. An op that is refused leaves
 * `doc` exactly as it was.
 */
function prepare(
  doc: Doc,
  input: unknown,
  actor: Actor,
  at: number,
): { op: Op; inverse: Op } | { reason: string } {
  try {
    // The actor and every time in it are the API's; whatever the sender wrote there is gone.
    const op = stampOp(sanitizeOp(validateOp(input)), actor, at);
    const why = refusal(actor, op, doc);
    if (why) return { reason: why };
    // What is stored is what every client can replay, whatever release of `applyOp` it has.
    const resolved = resolveOp(doc, op);
    return { op: resolved, inverse: applyOp(doc, resolved) };
  } catch (error) {
    if (error instanceof InvalidOpError || error instanceof OpError)
      return { reason: error.message };
    throw error;
  }
}
