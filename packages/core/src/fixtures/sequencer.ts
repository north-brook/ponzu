import { applyOp, type Doc } from "../doc.ts";
import { sanitizeOp } from "../sanitize.ts";
import { stampOp } from "../stamp.ts";
import type { ClientOp, CommitResult, CommittedOp } from "../sync.ts";
import type { Actor } from "../types.ts";
import { validateCommit, validateOp } from "../validate.ts";

/** What crosses the wire is JSON: nothing a replica holds is the sequencer's own object. */
export function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The API's side of the sync protocol, in memory, for testing a replica against: the commit
 * rules of docs/cloud.md ("Committing"). The post is checked as a whole, then each op is
 * validated, sanitized, stamped and applied, in that order; one that fails any step is
 * rejected and the rest carry on; an id seen before gets the answer it got the first time.
 */
export class Sequencer {
  readonly doc: Doc;
  seq = 0;
  /** Every committed op: `log[0]` is seq 1. */
  readonly log: CommittedOp[] = [];
  /** The doc as JSON after each seq: `history[0]` is the doc it started with. */
  readonly history: string[];
  /** The API's clock. Each commit moves it on, so no two ops share a time. */
  now = Date.UTC(2026, 0, 1);
  private answers = new Map<string, CommittedOp | { id: string; reason: string }>();
  private floor = 0;

  constructor(doc: Doc) {
    this.doc = wire(doc);
    this.history = [JSON.stringify(this.doc)];
  }

  /** Throws `InvalidOpError` for a post that isn't one, which the API answers by refusing it whole. */
  commit(ops: ClientOp[], actor: Actor): CommitResult {
    const result: CommitResult = { committed: [], rejected: [], seq: 0 };
    for (const { id, op } of validateCommit(wire({ ops }))) {
      const answer = this.answers.get(id) ?? this.decide(id, op, actor);
      this.answers.set(id, answer);
      if ("seq" in answer) result.committed.push(answer);
      else result.rejected.push(answer);
    }
    result.seq = this.seq;
    return wire(result);
  }

  /** The ops after `after`, or "gone" once `forget` has let go of them. */
  opsAfter(after: number): { ops: CommittedOp[]; seq: number } | "gone" {
    if (after < this.floor) return "gone";
    return wire({ ops: this.log.slice(after), seq: this.seq });
  }

  snapshot(): { doc: Doc; seq: number } {
    return wire({ doc: this.doc, seq: this.seq });
  }

  /** Stop serving the ops up to `seq`, as the API does once a checkpoint covers them. */
  forget(seq = this.seq): void {
    this.floor = seq;
  }

  private decide(
    id: string,
    input: unknown,
    actor: Actor,
  ): CommittedOp | { id: string; reason: string } {
    try {
      const at = this.now + 1000;
      const op = stampOp(sanitizeOp(validateOp(input)), actor, at);
      applyOp(this.doc, op);
      this.now = at;
      const committed = { seq: ++this.seq, id, op, actor, at: new Date(at).toISOString() };
      this.log.push(committed);
      this.history.push(JSON.stringify(this.doc));
      return committed;
    } catch (err) {
      return { id, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
