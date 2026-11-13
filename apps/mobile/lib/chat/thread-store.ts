import type { Api, Live, LiveRows, LiveSnapshot } from "@ponzu/client";
import type { OlderItems } from "@ponzu/client/model";

/*
 * One open canvas's thread on the phone (iPhone design §9): the `canvas.thread` live query, the
 * newest page of history beside it (the first paint, and offline), older pages while the live
 * rows aren't there, and the person's messages on their way. It is the Mac's ThreadStore
 * (apps/studio/src/app/thread-store.ts) on the phone's own API object, with one difference the
 * design asks for: a send that fails takes its bubble away and throws, so the composer gets its
 * words back and says it didn't go ("Couldn't send. Tap to try again."), rather than leaving a
 * failed bubble in the thread.
 *
 * A message shows at once. Once the API has it, its own item takes the bubble's place and the
 * live row follows with the same id; the live row often comes first, so a bubble also gives way
 * to the person's own message with the same words arriving after it was sent.
 */

export type RunnerItem = LiveRows["canvas.thread"];

/** An image going with a message: its file's ref once uploaded, and a local copy to show. */
export interface SentPicture {
  ref: string;
  /** Shown in the bubble until the thread's own item, with its address, takes its place. */
  uri: string;
  contentType: string;
}

/** A message the person sent that the thread doesn't hold yet. */
export interface PendingMessage {
  id: string;
  text: string;
  pictures: SentPicture[];
  at: string;
}

export interface ThreadSnapshot {
  /** The thread, oldest first; null until a page or the live rows arrive. */
  items: RunnerItem[] | null;
  /** The person's messages on their way, oldest first. */
  pending: PendingMessage[];
  older: OlderItems;
  /** The first page didn't come and the live rows haven't either: nothing to show yet. */
  failed: boolean;
}

/** The most items a page of history holds (the API's own limit). */
export const THREAD_PAGE = 50;
/** How many pages back a line asked for (a push's message) is looked for before giving up. */
export const REVEAL_PAGES = 20;

/**
 * What showing a line of the thread (`message=<seq>` from a link) does next with what the thread
 * holds: wait, ask for the page before it, or show (its seq is held, or nothing older can be
 * had: then the oldest held is shown). The Mac's `revealStep`, by seq alone.
 */
export function revealStep(
  thread: Pick<ThreadSnapshot, "items" | "older">,
  seq: number | null,
  pages: number,
): "wait" | "page" | "show" {
  if (seq === null || !thread.items) return "wait";
  const oldest = thread.items[0];
  if (!oldest || oldest.seq <= seq) return "show";
  if (thread.older === "loading") return "wait";
  if (thread.older === "more" && pages < REVEAL_PAGES) return "page";
  return "show";
}

export interface ThreadStoreOptions {
  api: { canvases: Pick<Api["canvases"], "thread" | "sendMessage"> };
  live: Pick<Live, "subscribe">;
  canvasId: string;
  /** The person, whose messages the bubbles are. */
  meId: string;
  now?: () => number;
}

export class ThreadStore {
  private live: LiveSnapshot<RunnerItem> | null = null;
  private pages = new Map<string, RunnerItem>();
  private sent = new Map<string, RunnerItem>();
  private pending: PendingMessage[] = [];
  private sentAfter = new Map<string, number>();
  private firstPage: "asking" | "full" | "short" | "failed" = "asking";
  private loadingOlder = false;
  private exhausted = false;
  private snapshot: ThreadSnapshot = { items: null, pending: [], older: "none", failed: false };
  private readonly listeners = new Set<() => void>();
  private stopLive: (() => void) | null = null;
  private closed = false;
  private sends = 0;

  constructor(private readonly opts: ThreadStoreOptions) {}

  /** Starts watching: the live rows, and the newest page of history beside them. */
  start(): this {
    this.stopLive = this.opts.live.subscribe(
      "canvas.thread",
      { canvasId: this.opts.canvasId },
      (live) => {
        this.live = live;
        for (const row of live.rows ?? []) this.sent.delete(row.id);
        this.arrived(live.rows ?? []);
        this.emit();
      },
    );
    this.page({ limit: THREAD_PAGE }).then(
      ({ items }) => {
        for (const item of items) this.pages.set(item.id, item);
        this.firstPage = items.length < THREAD_PAGE ? "short" : "full";
        this.arrived(items);
        this.emit();
      },
      () => {
        this.firstPage = "failed";
        this.emit();
      },
    );
    return this;
  }

  close(): void {
    this.closed = true;
    this.stopLive?.();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ThreadSnapshot => this.snapshot;

  /** The page before the oldest item held, when the live rows aren't there to have it all. */
  loadOlder(): void {
    if (this.snapshot.older !== "more") return;
    const oldest = this.snapshot.items?.[0];
    if (!oldest) return;
    this.loadingOlder = true;
    this.emit();
    this.page({ before: oldest.seq, limit: THREAD_PAGE })
      .then(
        ({ items }) => {
          for (const item of items) this.pages.set(item.id, item);
          if (items.length < THREAD_PAGE) this.exhausted = true;
        },
        () => {},
      )
      .finally(() => {
        this.loadingOlder = false;
        this.emit();
      });
  }

  /**
   * Says something to the agent: in the thread at once, sent behind it. Resolves once the API
   * has it; a send that didn't go takes its bubble away and throws what the API said.
   */
  async send(text: string, pictures: SentPicture[] = []): Promise<void> {
    const message: PendingMessage = {
      id: `local_${++this.sends}`,
      text,
      pictures,
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
    this.pending = [...this.pending, message];
    this.sentAfter.set(message.id, this.snapshot.items?.at(-1)?.seq ?? 0);
    this.emit();
    const refs = pictures.map((p) => p.ref);
    try {
      const item = await this.opts.api.canvases.sendMessage(this.opts.canvasId, {
        text,
        ...(refs.length ? { attachments: refs } : {}),
      });
      if (!this.live?.rows?.some((row) => row.id === item.id)) this.sent.set(item.id, item);
    } finally {
      this.pending = this.pending.filter((m) => m.id !== message.id);
      this.sentAfter.delete(message.id);
      this.emit();
    }
  }

  /**
   * Bubbles on their way whose message the live rows already hold: the person's, with the same
   * words, after the bubble was sent, each row taking one bubble, oldest first.
   */
  private arrived(rows: readonly RunnerItem[]): void {
    if (!this.pending.length) return;
    const taken = new Set<string>();
    const landed = new Set<string>();
    for (const message of this.pending) {
      const after = this.sentAfter.get(message.id) ?? 0;
      const row = rows.find(
        (r) =>
          r.kind === "message" &&
          r.seq > after &&
          !taken.has(r.id) &&
          r.payload.from.id === this.opts.meId &&
          r.payload.text === message.text,
      );
      if (!row) continue;
      taken.add(row.id);
      landed.add(message.id);
    }
    if (landed.size) this.pending = this.pending.filter((m) => !landed.has(m.id));
  }

  private page(page: { before?: number; limit: number }) {
    return this.opts.api.canvases.thread(this.opts.canvasId, page);
  }

  private emit(): void {
    if (this.closed) return;
    const items = this.items();
    this.snapshot = {
      items,
      pending: this.pending,
      older: this.older(),
      failed: items === null && this.firstPage === "failed",
    };
    for (const listener of this.listeners) listener();
  }

  /** Every item held, live rows over what a page or a send answered, in the thread's order. */
  private items(): RunnerItem[] | null {
    const rows = this.live?.rows;
    const paged = this.firstPage === "full" || this.firstPage === "short";
    if (!rows && !paged && !this.sent.size) return null;
    const byId = new Map<string, RunnerItem>([...this.pages, ...this.sent]);
    for (const row of rows ?? []) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The live rows are the whole thread; without them, history is asked for a page at a time. */
  private older(): OlderItems {
    if (this.live?.status === "live" || this.live?.rows) return "none";
    if (this.loadingOlder) return "loading";
    return this.firstPage === "full" && !this.exhausted ? "more" : "none";
  }
}
