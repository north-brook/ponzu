import type { Live, LiveRows, LiveSnapshot } from "@ponzu/client";
import type { Attachment, OlderItems } from "../cloud/model.ts";
import { mutate, type StorePonzu } from "./store-ponzu.ts";

/*
 * One open design's thread: the `design.thread` live query, pages of its history from the API
 * while the live rows aren't there yet (the first paint, offline), and the viewer's messages on
 * their way. A message shows at once; once the API has it, its own item takes the bubble's place
 * and the live row follows with the same id. The live row often comes first (the API wakes the
 * agent before it answers), so a bubble also gives way to the viewer's own message with its words
 * arriving after it was sent. One that fails stays, marked, to send again or take back to edit.
 * Pages of history are the client's `threadPage` queries, and a send its `sendMessage`.
 */

type RunnerItem = LiveRows["design.thread"];

/** A message the viewer sent that the thread doesn't hold yet. */
export interface PendingMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  status: "sending" | "failed";
  at: string;
}

export interface ThreadSnapshot {
  /** The thread, oldest first; null until a page or the live rows arrive. */
  items: RunnerItem[] | null;
  /** The viewer's messages on their way, or that didn't arrive, oldest first. */
  pending: PendingMessage[];
  older: OlderItems;
}

/** The most items a page of the thread's history holds (the API's own limit). */
export const THREAD_PAGE = 50;

export class ThreadStore {
  private live: LiveSnapshot<RunnerItem> | null = null;
  /** Pages of history, by id. */
  private pages = new Map<string, RunnerItem>();
  /** What the API answered each message with, until the live rows have it. */
  private sent = new Map<string, RunnerItem>();
  private pending: PendingMessage[] = [];
  /** The newest seq held when each message on its way was sent: its row comes after it. */
  private sentAfter = new Map<string, number>();
  private firstPage: "asking" | "full" | "short" | "failed" = "asking";
  private loadingOlder = false;
  private exhausted = false;
  private snapshot: ThreadSnapshot = { items: null, pending: [], older: "none" };
  private readonly listeners = new Set<() => void>();
  private stopLive: (() => void) | null = null;
  private closed = false;
  private sends = 0;

  constructor(
    private readonly opts: {
      ponzu: StorePonzu;
      live: Pick<Live, "subscribe">;
      designId: string;
      /** The viewer, whose messages the bubbles are. */
      meId: string;
      now?: () => number;
    },
  ) {}

  /** Starts watching: the live rows, and the newest page of history beside them. */
  start(): this {
    this.stopLive = this.opts.live.subscribe(
      "design.thread",
      { designId: this.opts.designId },
      (live) => {
        this.live = live;
        // A message the live rows hold no longer needs the API's answer to show it.
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
    return () => this.listeners.delete(listener);
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
   * The first message of a design just made with it, which the API already has: shown at once,
   * as on its way, until the thread's own item arrives in its place. Nothing is sent.
   */
  seed(text: string, attachments: Attachment[] = []): void {
    const message: PendingMessage = {
      id: `local_${++this.sends}`,
      text,
      attachments,
      status: "sending",
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
    this.pending = [...this.pending, message];
    this.sentAfter.set(message.id, 0);
    this.emit();
  }

  /** Says something to the agent: in the thread at once, sent behind it. */
  send(text: string, attachments: Attachment[]): void {
    const message: PendingMessage = {
      id: `local_${++this.sends}`,
      text,
      attachments,
      status: "sending",
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
    this.pending = [...this.pending, message];
    this.sentAfter.set(message.id, this.snapshot.items?.at(-1)?.seq ?? 0);
    this.emit();
    void this.deliver(message);
  }

  /** Sends a message that didn't arrive again. */
  retry(id: string): void {
    const message = this.pending.find((m) => m.id === id);
    if (message?.status !== "failed") return;
    const again = { ...message, status: "sending" as const };
    this.pending = this.pending.map((m) => (m.id === id ? again : m));
    this.emit();
    void this.deliver(again);
  }

  /** Lets go of a message that didn't arrive: its words went back to the composer. */
  discard(id: string): void {
    this.pending = this.pending.filter((m) => m.id !== id);
    this.sentAfter.delete(id);
    this.emit();
  }

  /**
   * Bubbles on their way whose message the live rows already hold: the viewer's, with the same
   * words, after the bubble was sent, each row taking one bubble, oldest first.
   */
  private arrived(rows: readonly RunnerItem[]): void {
    const sending = this.pending.filter((m) => m.status === "sending");
    if (!sending.length) return;
    const taken = new Set<string>();
    const landed = new Set<string>();
    for (const message of sending) {
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
      this.sentAfter.delete(message.id);
    }
    if (landed.size) this.pending = this.pending.filter((m) => !landed.has(m.id));
  }

  private async deliver(message: PendingMessage): Promise<void> {
    const refs = message.attachments.map((a) => a.ref);
    try {
      const { ponzu, designId } = this.opts;
      const item = await mutate(ponzu, ponzu.mutations.sendMessage(), {
        designId,
        body: { text: message.text, ...(refs.length ? { attachments: refs } : {}) },
      });
      // Held until the live rows have it, unless they already do.
      if (!this.live?.rows?.some((row) => row.id === item.id)) this.sent.set(item.id, item);
      this.pending = this.pending.filter((m) => m.id !== message.id);
      this.sentAfter.delete(message.id);
    } catch {
      this.pending = this.pending.map((m) =>
        m.id === message.id ? { ...m, status: "failed" } : m,
      );
    }
    this.emit();
  }

  private page(page: { before?: number; limit: number }) {
    const { ponzu, designId } = this.opts;
    return ponzu.queryClient.fetchQuery(ponzu.queries.threadPage(designId, page));
  }

  private emit(): void {
    if (this.closed) return;
    this.snapshot = {
      items: this.items(),
      pending: this.pending,
      older: this.older(),
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
