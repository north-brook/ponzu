import type {
  Author,
  Doc,
  EventType,
  Op,
  PonzuEvent,
  Presence,
  PresenceOrigin,
  Selection,
} from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import type { Design } from "@ponzu/store";

/**
 * Everything a tool handler can reach. A host (the CLI server, the desktop
 * app, or your own backend) builds one per open design.
 */
export interface Workspace {
  /** The open designs, by key (usually the absolute path). */
  designs(): { key: string; design: Design }[];
  /** Resolve a file argument (path, name or key) to an open design. Opens it if allowed. */
  resolve(file?: string): Promise<{ key: string; design: Design }>;
  /** Create a new .design and open it. */
  create?(path: string, doc: Doc): Promise<{ key: string; design: Design }>;
  renderer?: Renderer;
  /** Where a renderer loads this design's assets/ from, when the host serves them. */
  assetBase?(key: string): string | undefined;
  /** What the person in the studio has selected, per design key. */
  selection(key: string): Selection;
  /** Ask any open studio to show this artboard. */
  focus?(key: string, artboardId: string): void;
  events: EventHub;
  presence: PresenceHub;
  /** Usage events and agent feedback for the Ponzu team. Without it nothing is sent. */
  telemetry?: Telemetry;
}

/**
 * Where a host sends usage. Properties are names, counts and timings, never
 * design content, file names or paths.
 */
export interface Telemetry {
  capture(event: string, properties?: Record<string, unknown>): void;
  /** Send an agent's feedback to the Ponzu team. False when telemetry is off. */
  feedback(feedback: Feedback): Promise<boolean>;
}

export interface Feedback {
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  category: "bug" | "missing_capability" | "confusing_tool" | "praise" | "other";
  summary: string;
  details?: string;
  /** The tool it's about, if any. */
  tool?: string;
  /** The agent that sent it, e.g. "claude". */
  client?: string;
}

export interface ToolCaller {
  /** Stable per agent connection. */
  id: string;
  author: Author;
  client?: string;
  /** Where the session comes from, shown in the studio. */
  origin?: PresenceOrigin;
}

export interface ToolContext {
  ws: Workspace;
  caller: ToolCaller;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

type EventInput = PonzuEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq">
    : never
  : never;

export interface KeyedEvent {
  key: string;
  event: PonzuEvent;
}

/**
 * A ring buffer of recent events with cursors, so agents can long-poll
 * (`wait_for_activity`) without missing anything between calls.
 */
export class EventHub {
  private buffer: KeyedEvent[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();
  private listeners = new Set<(e: KeyedEvent) => void>();

  constructor(private capacity = 500) {}

  get cursor(): number {
    return this.seq;
  }

  emit(key: string, input: EventInput): PonzuEvent {
    const event = { ...input, seq: ++this.seq } as PonzuEvent;
    const item = { key, event };
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const w of this.waiters) w();
    for (const l of this.listeners) l(item);
    return event;
  }

  on(fn: (e: KeyedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  since(
    cursor: number,
    filter?: { key?: string; types?: EventType[]; excludeAuthor?: string },
  ): KeyedEvent[] {
    return this.buffer.filter(
      (e) =>
        e.event.seq > cursor &&
        (!filter?.key || e.key === filter.key) &&
        (!filter?.types?.length || filter.types.includes(e.event.type)) &&
        !(filter?.excludeAuthor && authorOf(e.event) === filter.excludeAuthor),
    );
  }

  /** Resolve with events after `cursor`, waiting up to `timeoutMs` for the first one. */
  async wait(
    cursor: number,
    timeoutMs: number,
    filter?: Parameters<EventHub["since"]>[1],
    signal?: AbortSignal,
  ): Promise<KeyedEvent[]> {
    const ready = this.since(cursor, filter);
    if (ready.length || timeoutMs <= 0) return ready;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", done);
        resolve(this.since(cursor, filter));
      };
      const check = () => {
        // Small delay so a burst (one tool call = several ops) arrives together.
        if (this.since(cursor, filter).length) setTimeout(done, 150);
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(check);
      signal?.addEventListener("abort", done);
    });
  }
}

function authorOf(e: PonzuEvent): string | undefined {
  if (e.type === "change") return e.origin.name;
  if ("author" in e) return e.author;
  return undefined;
}

export class PresenceHub {
  private map = new Map<string, Presence>();
  private listeners = new Set<(p: Presence[]) => void>();

  list(): Presence[] {
    const cutoff = Date.now() - 10 * 60_000;
    return [...this.map.values()].filter((p) => p.lastSeen > cutoff);
  }

  touch(
    caller: ToolCaller,
    patch: Partial<Pick<Presence, "working" | "status" | "file" | "listening" | "listenedAt">> = {},
  ): void {
    const prev = this.map.get(caller.id);
    const now = Date.now();
    const next: Presence = {
      ...prev,
      ...patch,
      id: caller.id,
      name: caller.author.name,
      kind: caller.author.kind,
      client: caller.client,
      origin: caller.origin,
      working: patch.working ?? prev?.working ?? [],
      since: prev?.since ?? now,
      lastSeen: now,
    };
    this.map.set(caller.id, next);
    // A plain tool call only moves lastSeen, which nothing shows; skip the broadcast.
    if (!prev || Object.keys(patch).length) this.notify();
  }

  leave(id: string): void {
    if (this.map.delete(id)) this.notify();
  }

  on(fn: (p: Presence[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const list = this.list();
    for (const l of this.listeners) l(list);
  }
}

export type { Op };
