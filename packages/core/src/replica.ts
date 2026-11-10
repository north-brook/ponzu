import { applyOp, type Doc, type Op } from "./doc.ts";
import {
  type ClientOp,
  CommitRefusedError,
  type CommittedOp,
  MAX_COMMIT_BYTES,
  MAX_COMMIT_OPS,
  newOpId,
  type SyncTransport,
} from "./sync.ts";
import type { Actor } from "./types.ts";
import { utf8Length } from "./utf8.ts";
import { validateOp } from "./validate.ts";

/** Run `run` once, `ms` from now. Returns a way to call it off. */
export type Scheduler = (run: () => void, ms: number) => () => void;

export interface ReplicaOptions {
  transport: SyncTransport;
  /** The replica's only clock: it waits this way before trying a failed request again. */
  schedule: Scheduler;
  /** Who edits here. Their own ops reach the op listener under this name. */
  actor: Actor;
  /** The design as of `seq`, from `fetchDoc`. The replica keeps it and changes it. */
  doc: Doc;
  seq: number;
  /** Makes each op's id. `newOpId` unless a test wants to know them. */
  newId?: () => string;
}

/** What `apply` gives back. */
export interface AppliedOp {
  /** The id the op is posted under. `onDrop` and `onOp` name the op by it. */
  id: string;
  /** The op that would undo it, as `applyOp` returns. */
  inverse: Op;
}

/** A pending op that will never be in the design. */
export interface DroppedOp {
  /** The id `apply` returned for it. */
  id: string;
  op: Op;
  /** In words: the API's reason, or why the op no longer fits. */
  reason: string;
  /** The API refused it, or ops committed before it left it nothing to apply to. */
  cause: "rejected" | "conflict";
}

/** Which op a listener is hearing. */
export interface OpInfo {
  /** The id it was posted under: for an op made here, the one `apply` returned. */
  id: string;
  /** Its place in the design's order. Absent for an op made here that isn't committed yet. */
  seq?: number;
  /**
   * True when the op was made here and already heard as it was applied, and this is the
   * API's version of it. Draw it, since it may look different; don't count it as a new op.
   */
  echo: boolean;
}

type OpListener = (op: Op, actor: Actor, doc: Doc, info: OpInfo) => void;

interface Pending extends ClientOp {
  /** How much of a post it takes up: `{ id, op }` as JSON, in UTF-8 bytes. */
  bytes: number;
  /** Posted at least once, so only the API can say what became of it. */
  sent: boolean;
  /** Whether `view` holds it. A sent op that stopped fitting waits here, out of the view. */
  applied: boolean;
}

/** How long to wait before trying a failed request again: doubling from the first to the last. */
const RETRY_MS = { first: 500, last: 30_000 };

/**
 * One design on one device: the client side of the sync protocol (docs/cloud.md, "The
 * replica"). The Mac app, the phone and the sandbox all edit through one of these.
 *
 * It holds the document as the API last confirmed it, and a queue of ops made here that the
 * API hasn't confirmed. `doc` is the first with the second applied on top, so an edit shows
 * at once. Committed ops always win: when they arrive, `doc` becomes the confirmed document
 * with whatever is still pending applied again.
 *
 * It talks to the API one request at a time, and never on a timer of its own.
 */
export class Replica {
  /** The design as of `seq`: only committed ops, in order. */
  private confirmed: Doc;
  /** `confirmed` with the pending ops applied. */
  private view: Doc;
  private confirmedSeq: number;
  /** The highest seq anyone has told us exists. */
  private head: number;
  private queue: Pending[] = [];

  private readonly transport: SyncTransport;
  private readonly schedule: Scheduler;
  private readonly actor: Actor;
  private readonly newId: () => string;

  /** A request is in flight. There is never more than one. */
  private busy = false;
  /** Set while waiting to try again after a failure; calling it stops the wait. */
  private cancelRetry: (() => void) | null = null;
  private retryMs = RETRY_MS.first;
  /** `confirmed` can't be brought up to date op by op: fetch the whole document. */
  private needsDoc = false;
  /** No op has been confirmed since the last whole fetch, so another one so soon is a loop. */
  private justFetchedDoc = false;
  /** Which of posting and catching up went last. */
  private lastRequest: "post" | "fetch" | null = null;
  /** The API refused a post whole, so ops go one to a post until it says which is at fault. */
  private oneAtATime = false;
  private failing = false;
  private closed = false;

  private stateListeners = new Set<() => void>();
  private opListeners = new Set<OpListener>();
  private dropListeners = new Set<(dropped: DroppedOp) => void>();

  constructor(opts: ReplicaOptions) {
    this.transport = opts.transport;
    this.schedule = opts.schedule;
    this.actor = opts.actor;
    this.newId = opts.newId ?? newOpId;
    this.view = opts.doc;
    this.confirmed = structuredClone(opts.doc);
    this.confirmedSeq = opts.seq;
    this.head = opts.seq;
  }

  /** Fetch the design and start a replica of it. */
  static async open(opts: Omit<ReplicaOptions, "doc" | "seq">): Promise<Replica> {
    const { doc, seq } = await opts.transport.fetchDoc();
    return new Replica({ ...opts, doc, seq });
  }

  /**
   * The design as the person sees it: confirmed ops, then their own pending ones. Read
   * only, and read afresh after each change: when committed ops land under pending ones
   * this is a new object, not the old one changed.
   */
  get doc(): Doc {
    return this.view;
  }

  /** The last committed op in `doc`. */
  get seq(): number {
    return this.confirmedSeq;
  }

  /** Ops made here that the API hasn't confirmed, oldest first. A copy: the queue is the replica's. */
  get pending(): ClientOp[] {
    return this.queue.map(({ id, op }) => ({ id, op }));
  }

  /** The last request failed, or was answered with nothing of use, and none has worked since. */
  get offline(): boolean {
    return this.failing;
  }

  /** Hear when `doc`, `seq`, `pending` or `offline` changes. */
  subscribe(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Hear each op as it reaches `doc`, with who made it: once per op the person hasn't seen.
   * An op made here is heard when it's applied, and not again when the API confirms it,
   * unless what was committed differs from it (the API sanitizes and stamps, so every comment
   * does) or it had left `doc` in the meantime. That second hearing has `info.echo` set.
   * `doc` is the document with the op, and any that arrived with it, in.
   * Ops that arrive inside a whole fetched document are not heard one by one.
   */
  onOp(listener: OpListener): () => void {
    this.opListeners.add(listener);
    return () => this.opListeners.delete(listener);
  }

  /** Hear of each pending op that will never be in the design. */
  onDrop(listener: (dropped: DroppedOp) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /**
   * Apply an op here and now, and queue it for the API. Returns the id it is posted under and
   * its inverse. Throws, and changes nothing, for an op that can't be committed:
   * `InvalidOpError` when the API would refuse it on sight (`validateOp`: too large, a
   * malformed id), `OpError` when it doesn't fit the document, exactly as `applyOp` does.
   * The op is the replica's from here on: don't change it afterwards.
   */
  apply(op: Op): AppliedOp {
    validateOp(op);
    const inverse = applyOp(this.view, op);
    const id = this.newId();
    const bytes = utf8Length(JSON.stringify({ id, op }));
    this.queue.push({ id, op, bytes, sent: false, applied: true });
    this.pump();
    for (const listener of this.opListeners)
      listener(op, this.actor, this.view, { id, echo: false });
    this.changed();
    return { id, inverse };
  }

  /**
   * Take in committed ops, in any order and any number of times. Those that follow `seq`
   * without a hole are applied; any past a hole wait for the fetch that fills it.
   */
  ingest(committed: CommittedOp[]): void {
    this.finish(this.settle(committed, []));
  }

  /** The design's head moved to `seq`: fetch what's missing. Late, repeated and stale calls are fine. */
  notify(seq: number): void {
    if (seq > this.head) this.head = seq;
    // Word from the API means it can be reached: don't sit out the rest of a wait.
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.pump();
  }

  /** Stop talking to the API. What's pending stays pending. */
  close(): void {
    this.closed = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  /* ---------------------------------------------------------------- */
  /* Requests                                                          */
  /* ---------------------------------------------------------------- */

  /** Start whatever is due next, unless a request is already out. */
  private pump(): void {
    if (this.closed || this.busy || this.cancelRetry) return;
    const behind = this.confirmedSeq < this.head;
    const waiting = this.queue.length > 0;
    if (this.needsDoc) this.fetchDoc();
    // When both are due they take turns, so neither posting nor catching up starves.
    else if (behind && !(waiting && this.lastRequest === "fetch")) this.fetchOps();
    else if (waiting) this.post();
  }

  private post(): void {
    const batch = this.nextPost();
    for (const entry of batch) entry.sent = true;
    this.lastRequest = "post";
    const ops = batch.map(({ id, op }) => ({ id, op }));
    this.request(
      async () => {
        try {
          return await this.transport.commit(ops);
        } catch (err) {
          // An answer, not a failure: the API was reached, and said no.
          if (err instanceof CommitRefusedError) return err;
          throw err;
        }
      },
      (result) => {
        if (result instanceof CommitRefusedError) {
          // One op in the post is at fault, and only a post of one says which. So they go
          // one at a time, and a post of one that is refused is that op rejected.
          this.oneAtATime = true;
          const alone = batch.length === 1 ? [{ id: batch[0]!.id, reason: result.message }] : [];
          return this.settle([], alone);
        }
        const answered = new Set([...result.committed, ...result.rejected].map((r) => r.id));
        // An op the answer doesn't mention is still in doubt: post it again.
        if (batch.some((entry) => !answered.has(entry.id))) return null;
        this.oneAtATime = false;
        this.head = Math.max(this.head, result.seq);
        return this.settle(result.committed, result.rejected);
      },
    );
  }

  /**
   * The ops the next post carries: from the head of the queue, as many as `MAX_COMMIT_OPS`
   * and `MAX_COMMIT_BYTES` allow. Always at least one, or the queue would never move.
   */
  private nextPost(): Pending[] {
    const most = this.oneAtATime ? 1 : MAX_COMMIT_OPS;
    let count = 0;
    let bytes = 0;
    for (const entry of this.queue) {
      if (count === most || (count > 0 && bytes + entry.bytes > MAX_COMMIT_BYTES)) break;
      bytes += entry.bytes;
      count++;
    }
    return this.queue.slice(0, count);
  }

  private fetchOps(): void {
    this.lastRequest = "fetch";
    const after = this.confirmedSeq;
    const told = this.head;
    this.request(
      () => this.transport.fetchOps(after),
      (answer) => {
        if (answer === "gone") {
          this.lost();
          return { heard: [], dropped: [] };
        }
        // The API says where the head is. If it has less than this replica had been told of
        // when it asked, what it was told was wrong (word of another design, or of one since
        // reset), and asking again would get the same answer. Word that came while the
        // request was out stays: the API may have answered before that op was committed.
        if (answer.seq < told && this.head === told) this.head = this.confirmedSeq;
        this.head = Math.max(this.head, answer.seq);
        const before = this.confirmedSeq;
        const effects = this.settle(answer.ops, []);
        // The answer has to carry on from where this replica is: every op in it applied, and
        // at least one if the API says there are more.
        const last = answer.ops.reduce((max, c) => Math.max(max, c.seq), 0);
        const stuck = this.confirmedSeq === before && this.confirmedSeq < answer.seq;
        if ((this.confirmedSeq < last || stuck) && !this.needsDoc) this.lost();
        return effects;
      },
    );
  }

  private fetchDoc(): void {
    this.request(
      () => this.transport.fetchDoc(),
      ({ doc, seq }) => {
        // Older than what's here (a stale cache, say): taking it would undo confirmed ops.
        if (seq < this.confirmedSeq) return null;
        if (seq > this.confirmedSeq) this.retryMs = RETRY_MS.first;
        this.confirmed = doc;
        this.confirmedSeq = seq;
        this.head = Math.max(this.head, seq);
        this.needsDoc = false;
        this.justFetchedDoc = true;
        const effects: Effects = { heard: [], dropped: [] };
        this.rebuild(effects.dropped);
        return effects;
      },
    );
  }

  /**
   * Make one request. `done` takes the answer in and returns what to tell the listeners, or
   * null for an answer that is no use, which is treated as no answer at all.
   */
  private request<T>(send: () => Promise<T>, done: (value: T) => Effects | null): void {
    this.busy = true;
    let answer: Promise<T>;
    try {
      answer = send();
    } catch (err) {
      answer = Promise.reject(err);
    }
    answer.then(
      (value) => {
        if (this.closed) return;
        this.busy = false;
        const effects = done(value);
        if (!effects) return this.failed();
        this.failing = false;
        this.finish(effects);
      },
      () => {
        if (this.closed) return;
        this.busy = false;
        this.failed();
      },
    );
  }

  /** The request didn't get through. Whatever it carried is tried again, with the same ids. */
  private failed(): void {
    this.failing = true;
    this.retryLater();
    this.changed();
  }

  /** The confirmed document can't be continued from here: get it whole. */
  private lost(): void {
    this.needsDoc = true;
    // Straight after a whole fetch, the API is giving answers that don't add up. Don't spin.
    if (this.justFetchedDoc) this.retryLater();
  }

  /**
   * Try again after a wait that doubles each time. The waits start over when the API moves
   * this replica forward (confirms or rejects an op), not whenever it answers: an API that
   * answers without getting anywhere is asked less and less often too.
   */
  private retryLater(): void {
    if (this.cancelRetry) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(wait * 2, RETRY_MS.last);
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      this.pump();
    }, wait);
  }

  /* ---------------------------------------------------------------- */
  /* Committed ops                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Bring the replica in line with what the API decided: drop what it rejected, apply what
   * it committed in order, and leave `view` as the confirmed document with the rest of the
   * queue on top.
   */
  private settle(committed: CommittedOp[], rejected: { id: string; reason: string }[]): Effects {
    const effects: Effects = { heard: [], dropped: [] };
    // Whether `view` still is `confirmed` plus the queue, or has to be built again.
    let stale = false;

    for (const { id, reason } of rejected) {
      const mine = this.take(id);
      if (!mine) continue;
      this.retryMs = RETRY_MS.first;
      stale ||= mine.applied;
      effects.dropped.push({ id, op: mine.op, reason, cause: "rejected" });
    }

    const inOrder = [...committed].sort((a, b) => a.seq - b.seq);
    this.head = Math.max(this.head, inOrder.at(-1)?.seq ?? 0);
    for (const c of inOrder) {
      // Past a hole, or on a document that needs fetching whole: the fetch will bring these.
      if (this.needsDoc || c.seq > this.confirmedSeq + 1) break;
      if (c.seq <= this.confirmedSeq) {
        // Already in the document: it came twice, or inside a whole fetch. If it's one of
        // ours, the view has it a second time.
        if (this.take(c.id)?.applied) stale = true;
        continue;
      }
      try {
        applyOp(this.confirmed, c.op);
      } catch {
        // The API applied this op to the same document, so ours isn't the same.
        this.lost();
        break;
      }
      this.confirmedSeq = c.seq;
      this.justFetchedDoc = false;
      this.retryMs = RETRY_MS.first;

      const next = this.queue[0];
      if (!stale && next?.id === c.id && next.applied && sameOp(next.op, c.op)) {
        // Our oldest op, committed as we made it: the view already is confirmed plus the rest.
        this.queue.shift();
        continue;
      }
      if (!stale && this.queue.length === 0) {
        try {
          applyOp(this.view, c.op);
          effects.heard.push({ committed: c, echo: false });
          continue;
        } catch {
          // The view was the confirmed document, so this can't happen. Build it again if it does.
        }
      }
      const mine = this.take(c.id);
      if (!mine?.applied || !sameOp(mine.op, c.op))
        effects.heard.push({ committed: c, echo: mine !== undefined });
      stale = true;
    }

    if (stale) this.rebuild(effects.dropped);
    return effects;
  }

  /** `view` from scratch: the confirmed document, then each pending op that still fits. */
  private rebuild(dropped: DroppedOp[]): void {
    this.view = structuredClone(this.confirmed);
    this.queue = this.queue.filter((entry) => {
      try {
        applyOp(this.view, entry.op);
        entry.applied = true;
        return true;
      } catch (err) {
        entry.applied = false;
        // A posted op may be committed all the same, on a document this replica hasn't
        // caught up with: the API has the last word on it.
        if (entry.sent) return true;
        const reason = err instanceof Error ? err.message : String(err);
        dropped.push({ id: entry.id, op: entry.op, reason, cause: "conflict" });
        return false;
      }
    });
  }

  private take(id: string): Pending | undefined {
    const at = this.queue.findIndex((entry) => entry.id === id);
    return at < 0 ? undefined : this.queue.splice(at, 1)[0];
  }

  /** Start the next request, then tell the listeners what just happened. */
  private finish(effects: Effects): void {
    this.pump();
    for (const { committed, echo } of effects.heard) {
      const info = { id: committed.id, seq: committed.seq, echo };
      for (const listener of this.opListeners)
        listener(committed.op, committed.actor, this.view, info);
    }
    for (const dropped of effects.dropped)
      for (const listener of this.dropListeners) listener(dropped);
    this.changed();
  }

  private changed(): void {
    for (const listener of this.stateListeners) listener();
  }
}

/** What a round of settling leaves to tell the listeners. */
interface Effects {
  /** Committed ops that are news to the person here, in order. An `echo` is one made here. */
  heard: { committed: CommittedOp; echo: boolean }[];
  dropped: DroppedOp[];
}

/**
 * Whether the API committed an op exactly as it was made here. Compared as JSON, key order
 * included: `sanitizeOp` and `stampOp` keep the order they were given, and the order of
 * `attrs` and `style` is part of what an op says.
 */
function sameOp(a: Op, b: Op): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
