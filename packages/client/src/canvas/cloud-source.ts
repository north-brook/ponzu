import type { CanvasSource, CanvasState } from "@ponzu/canvas";
import {
  type Actor,
  CommitRefusedError,
  type Doc,
  type Op,
  type Origin,
  type Presence,
  Replica,
  type SyncTransport,
} from "@ponzu/core";
import type { Api } from "../api.ts";
import { type Clock, systemClock } from "../clock.ts";
import type { DocCache } from "../doc-cache.ts";
import { ApiError } from "../errors.ts";
import type { Live } from "../live/live.ts";
import type { DesignHeadRow, PresenceRow } from "../live/rows.ts";
import { presentNow } from "../live/sort.ts";

/*
 * The canvas on Ponzu Cloud (docs/cloud.md, "Clients"): `CanvasSource` over a core `Replica`.
 * Edits show at once and are posted behind; `design.head` says when someone else's have
 * landed. The canvas was written for a server a millisecond away that echoed every edit, so
 * this keeps the promises that made true: a board dropped stays where it was dropped, a
 * comment sent stays on screen, and each op reaches `onOp` once, with who made it.
 */

/** How often to say the design is still open. The API forgets a person after 75 seconds. */
const PRESENCE_MS = 30_000;
/** How long the document rests before it is written to the cache. */
const CACHE_AFTER_MS = 2_000;
const RETRY_MS = { first: 1_000, last: 30_000 };

/** An edit that did not make it into the design, for the UI to say so. */
export interface Unsaved {
  /** In words: the API's reason, why it no longer fits, or that the design is read only. */
  reason: string;
  /** The op, when there was one (an undo that failed has none). */
  op?: Op;
}

export interface CloudSourceOptions {
  api: Pick<Api, "designs">;
  live: Pick<Live, "subscribe">;
  designId: string;
  /** The signed-in person, as the API stamps their ops: `{ kind: "user", id, name, avatarUrl }`. */
  me: Actor;
  /** Shows the last copy of the design while the API cannot be reached. */
  cache?: DocCache;
  clock?: Clock;
}

type OpListener = (op: Op, origin: Origin, doc: Doc) => void;

export class CloudSource implements CanvasSource {
  /** There is no image-resizing service: every image loads at its own size. */
  readonly renditions = false;
  /** Where the design's `assets/` are: known once the API has answered. */
  assetBase?: string;
  /** False for a design the person may only look at, and until the API has answered. */
  writable = false;

  private readonly opts: CloudSourceOptions;
  private readonly api: Pick<Api, "designs">;
  private readonly clock: Clock;
  private state: CanvasState = {
    status: "connecting",
    doc: null,
    path: "",
    presence: [],
    canUndo: false,
    canRedo: false,
  };
  private listeners = new Set<(state: CanvasState) => void>();
  private opListeners = new Set<OpListener>();
  private unsavedListeners = new Set<(unsaved: Unsaved) => void>();

  private replica: Replica | null = null;
  /** The replica's document as last copied into `state`: it changes its own in place. */
  private copied: Doc | null = null;
  /** A copy made for the op listeners, for `state` to take up. */
  private fresh: Doc | null = null;
  private head: DesignHeadRow | null = null;
  /** Who made the last change, for the canvas's activity indicator. */
  private lastOrigin: Origin | undefined;
  /** Why the design can no longer be shown: deleted, or the person lost access to it. */
  private failure: string | null = null;
  private people: readonly PresenceRow[] = [];
  private pageId: string | null = null;
  /** Undo and redo, one after another, each after the edits before it are in. */
  private reversing: Promise<void> = Promise.resolve();
  private cleanups: (() => void)[] = [];
  private cancelPresence: (() => void) | null = null;
  private cancelCache: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private retryMs = RETRY_MS.first;
  private closed = false;

  constructor(opts: CloudSourceOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.clock = opts.clock ?? systemClock;
    void this.showCached();
    this.watch();
    void this.open();
  }

  /* ---------------------------------------------------------------- */
  /* CanvasSource                                                      */
  /* ---------------------------------------------------------------- */

  getState(): CanvasState {
    return this.state;
  }

  subscribe(listener: (state: CanvasState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Each op once, as it reaches the document, with who made it: the person's own included. */
  onOp(listener: OpListener): () => void {
    this.opListeners.add(listener);
    return () => this.opListeners.delete(listener);
  }

  apply(op: Op): void {
    if (!this.replica || !this.writable) {
      this.unsaved({ op, reason: "This design can only be looked at right now." });
      return;
    }
    try {
      this.replica.apply(op);
    } catch (error) {
      this.unsaved({ op, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  undo(): void {
    this.reverse("undo");
  }

  redo(): void {
    this.reverse("redo");
  }

  /** Puts a file in the design's `assets/` and answers with its reference. */
  async upload(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = await this.api.designs.upload(this.opts.designId, {
      name: file.name,
      type: file.type,
      bytes,
    });
    if (!uploaded.ref) throw new Error("The upload has no reference.");
    return uploaded.ref;
  }

  /* ---------------------------------------------------------------- */
  /* For the host                                                      */
  /* ---------------------------------------------------------------- */

  /** Hear of an edit that will not be in the design: "That change could not be saved." */
  onUnsaved(listener: (unsaved: Unsaved) => void): () => void {
    this.unsavedListeners.add(listener);
    return () => this.unsavedListeners.delete(listener);
  }

  /**
   * Resolves once every edit made here so far has been sent and answered: committed, or turned
   * away (`onUnsaved` says which). What needs an op in the design first waits on it.
   */
  saved(): Promise<void> {
    return this.replica ? settled(this.replica) : Promise.resolve();
  }

  /** The page the person is on, for the others' presence. */
  setPage(pageId: string | null): void {
    if (pageId === this.pageId) return;
    this.pageId = pageId;
    if (this.replica && !this.failure) this.keepPresent();
  }

  /** Back online, or back in the foreground: try now instead of sitting out a wait. */
  retryNow(): void {
    if (this.replica) {
      this.replica.retryNow();
      return;
    }
    this.cancelRetry?.();
    this.cancelRetry = null;
    void this.open();
  }

  /** Close the design: stop syncing, say the person left, and keep a copy for next time. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cancelPresence?.();
    this.cancelRetry?.();
    this.replica?.close();
    if (this.replica) {
      void this.api.designs.leave(this.opts.designId).catch(() => {});
      this.cancelCache?.();
      void this.saveCopy();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Opening                                                           */
  /* ---------------------------------------------------------------- */

  private async showCached(): Promise<void> {
    const cached = await this.opts.cache?.read(this.opts.designId);
    if (!cached || this.replica || this.closed) return;
    this.assetBase = cached.assetsUrl;
    this.set({ doc: cached.doc, path: cached.name });
  }

  private async open(): Promise<void> {
    const { designId, me } = this.opts;
    let view: Awaited<ReturnType<Api["designs"]["get"]>>;
    let current: { doc: Doc; seq: number };
    try {
      [view, current] = await Promise.all([
        this.api.designs.get(designId),
        this.api.designs.doc(designId),
      ]);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof ApiError && !error.transient) return this.fail(error.message);
      const wait = this.retryMs;
      this.retryMs = Math.min(wait * 2, RETRY_MS.last);
      this.cancelRetry = this.clock.schedule(() => {
        this.cancelRetry = null;
        void this.open();
      }, wait);
      return this.set({ status: "offline" });
    }
    if (this.closed || this.replica || this.failure) return;

    this.assetBase = view.assetsUrl;
    this.writable = view.access === "write";
    const replica = new Replica({
      transport: this.transport(),
      schedule: (run, ms) => this.clock.schedule(run, ms),
      actor: me,
      doc: current.doc,
      seq: current.seq,
    });
    this.replica = replica;
    this.cleanups.push(
      replica.onOp((op, actor, doc, info) => {
        // The API's version of an op made here: `state` takes it, but it is not news.
        if (info.echo) return;
        this.fresh ??= structuredClone(doc);
        for (const listener of this.opListeners) {
          try {
            listener(op, actor, this.fresh);
          } catch (error) {
            // Motion only: a listener that fails must never hold the document back.
            console.error("[ponzu] op listener failed:", error);
          }
        }
        this.lastOrigin = actor;
      }),
      replica.onDrop(({ op, reason }) => this.unsaved({ op, reason })),
      replica.subscribe(() => this.synced()),
    );
    if (this.head) replica.notify(this.head.seq);
    this.set({
      path: view.name,
      canUndo: this.writable,
      canRedo: this.writable,
    });
    this.synced();
    this.keepPresent();
  }

  /** `state` from the replica, with the document copied when it changed. */
  private synced(): void {
    const replica = this.replica!;
    let doc = this.state.doc;
    if (this.fresh) doc = this.fresh;
    else if (replica.doc !== this.copied) doc = structuredClone(replica.doc);
    this.fresh = null;
    this.copied = replica.doc;
    const changed = doc !== this.state.doc;
    this.set({
      status: this.failure ? "error" : replica.offline ? "offline" : "ready",
      doc,
      lastOrigin: this.lastOrigin,
    });
    if (changed) this.cacheSoon();
  }

  /** The replica's way to the API, for this design. */
  private transport(): SyncTransport {
    const { designs } = this.api;
    const id = this.opts.designId;
    /** Deleted, or no longer theirs: stop now, rather than retry until `design.head` says so. */
    const gone = (error: unknown) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        this.fail(error.message);
      }
      return error;
    };
    return {
      async commit(ops) {
        try {
          return await designs.commit(id, ops);
        } catch (error) {
          gone(error);
          // Refused outright (malformed, too large, not allowed): sending it again can't help.
          if (error instanceof ApiError && [400, 403, 404, 413].includes(error.status)) {
            throw new CommitRefusedError(error.message);
          }
          throw error;
        }
      },
      async fetchOps(after) {
        try {
          return await designs.ops(id, after);
        } catch (error) {
          if (error instanceof ApiError && error.code === "ops_pruned") return "gone";
          throw gone(error);
        }
      },
      fetchDoc: () => designs.doc(id).catch((error) => Promise.reject(gone(error))),
    };
  }

  /** The design's head and who has it open, live. */
  private watch(): void {
    const args = { designId: this.opts.designId };
    this.cleanups.push(
      this.opts.live.subscribe("design.head", args, ({ rows, status, error }) => {
        if (status === "ended") return this.fail(error?.message ?? "This design is gone.");
        const head = rows?.[0];
        if (!head) return;
        this.head = head;
        this.replica?.notify(head.seq);
        this.set({ path: head.name, presence: this.presence() });
      }),
      this.opts.live.subscribe("design.presence", args, ({ rows }) => {
        this.people = rows ?? [];
        this.set({ presence: this.presence() });
      }),
    );
  }

  /** The agent at work and the other people here, as the canvas shows them. */
  private presence(): Presence[] {
    const now = this.clock.now();
    const present: Presence[] = presentNow(this.people, now)
      .filter((row) => row.userId !== this.opts.me.id)
      .map((row) => ({
        id: row.userId,
        kind: "user",
        name: row.name ?? row.githubLogin,
        working: [],
        since: Date.parse(row.joinedAt),
        lastSeen: Date.parse(row.seenAt),
      }));
    const head = this.head;
    if (head?.agentState === "working") {
      present.unshift({
        id: "agent",
        kind: "agent",
        name: "Claude",
        client: "claude",
        working: head.agentArtboards,
        ...(head.agentStatus ? { status: head.agentStatus } : {}),
        since: Date.parse(head.lastActivityAt),
        lastSeen: now,
      });
    }
    return present;
  }

  /* ---------------------------------------------------------------- */
  /* Undo, presence, the cache                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The API undoes the person's newest committed op, so whatever they did before pressing undo
   * has to be committed first, or an older op would be the one taken back.
   */
  private reverse(kind: "undo" | "redo"): void {
    const replica = this.replica;
    if (!replica || !this.writable) return;
    this.reversing = this.reversing.then(async () => {
      await settled(replica);
      try {
        const { committed, seq } = await this.api.designs[kind](this.opts.designId);
        replica.ingest([committed]);
        replica.notify(seq);
      } catch (error) {
        if (error instanceof ApiError && /^nothing_to_(undo|redo)$/.test(error.code)) return;
        this.unsaved({ reason: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /** Say the design is open now and every 30 seconds after, until it is closed. */
  private keepPresent(): void {
    this.cancelPresence?.();
    const beat = () => {
      void this.api.designs.presence(this.opts.designId, this.pageId).catch(() => {});
      this.cancelPresence = this.clock.schedule(beat, PRESENCE_MS);
    };
    beat();
  }

  private cacheSoon(): void {
    if (!this.opts.cache) return;
    this.cancelCache?.();
    this.cancelCache = this.clock.schedule(() => {
      this.cancelCache = null;
      void this.saveCopy();
    }, CACHE_AFTER_MS);
  }

  private async saveCopy(): Promise<void> {
    const replica = this.replica;
    if (!this.opts.cache || !replica || !this.assetBase) return;
    await this.opts.cache.write({
      designId: this.opts.designId,
      name: this.state.path,
      doc: replica.doc,
      seq: replica.seq,
      assetsUrl: this.assetBase,
    });
  }

  /** Deleted, or no longer the person's to see: stop, say why, and that what is waiting is lost. */
  private fail(reason: string): void {
    if (this.failure) return;
    this.failure = reason;
    this.writable = false;
    this.replica?.close();
    this.cancelPresence?.();
    this.cancelPresence = null;
    this.set({ status: "error", error: reason });
    for (const { op } of this.replica?.pending ?? []) this.unsaved({ op, reason });
  }

  private unsaved(unsaved: Unsaved): void {
    for (const listener of this.unsavedListeners) listener(unsaved);
  }

  private set(patch: Partial<CanvasState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

/** Resolves once the replica has nothing waiting to be committed. */
function settled(replica: Replica): Promise<void> {
  return new Promise((resolve) => {
    if (replica.pending.length === 0) return resolve();
    const off = replica.subscribe(() => {
      if (replica.pending.length > 0) return;
      off();
      resolve();
    });
  });
}
