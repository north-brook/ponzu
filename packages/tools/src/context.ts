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

/** What one agent connection remembers between calls. */
export interface ToolSession {
  /** The design this agent last created, named or reached by id: calls without `file` use it. */
  file?: string;
}

/** How a call found its design: named, by the ids it passed, the session's file, or the only one. */
export type FileSource = "arg" | "ids" | "session" | "only";

export interface ToolContext {
  ws: Workspace;
  caller: ToolCaller;
  signal?: AbortSignal;
  /** Without one, every call without `file` needs a single open design. */
  session?: ToolSession;
  /** Set while the call runs, by resolveFile. */
  resolved?: { from: FileSource; note?: string };
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

/** How long an agent can go without a tool call before it stops showing as working. */
export const WORKING_IDLE = 60_000;

export class PresenceHub {
  private map = new Map<string, Presence>();
  private listeners = new Set<(p: Presence[]) => void>();
  private idle = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private idleMs = WORKING_IDLE) {}

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
    this.armIdle(next);
    // A plain tool call only moves lastSeen, which nothing shows; skip the broadcast.
    if (!prev || Object.keys(patch).length) this.notify();
  }

  /**
   * The agent changed these artboards in `file`, or deleted the `gone` ones.
   * It shows as working on them, and on any it touched before, until it
   * goes quiet. `status` replaces what it said it's doing.
   */
  worked(
    caller: ToolCaller,
    file: string,
    change: { artboards?: string[]; gone?: string[]; status?: string },
  ): void {
    if (change.gone?.length) this.drop(caller.id, file, change.gone);
    const prev = this.map.get(caller.id);
    const same = prev?.file === file;
    const kept = same ? prev.working.filter((id) => !change.gone?.includes(id)) : [];
    const working = [...new Set([...kept, ...(change.artboards ?? [])])];
    const status = change.status ?? (same ? prev.status : undefined);
    // Another edit to the same artboards changes nothing anyone sees, and the call already touched.
    if (same && sameIds(working, prev.working) && status === prev.status) return;
    this.touch(caller, { file, working, status });
  }

  /** Deleted artboards are no longer anyone's: take them from the other agents in `file`. */
  private drop(except: string, file: string, gone: string[]): void {
    let changed = false;
    for (const p of this.map.values()) {
      if (p.id === except || p.file !== file || !p.working.some((id) => gone.includes(id)))
        continue;
      this.map.set(p.id, { ...p, working: p.working.filter((id) => !gone.includes(id)) });
      changed = true;
    }
    if (changed) this.notify();
  }

  leave(id: string): void {
    clearTimeout(this.idle.get(id));
    this.idle.delete(id);
    if (this.map.delete(id)) this.notify();
  }

  /** Clear what an agent is working on once it has made no tool call for `idleMs`. */
  private armIdle(p: Presence): void {
    clearTimeout(this.idle.get(p.id));
    this.idle.delete(p.id);
    if (!p.working.length && !p.status) return;
    const timer = setTimeout(() => {
      this.idle.delete(p.id);
      const cur = this.map.get(p.id);
      if (!cur) return;
      this.map.set(p.id, { ...cur, working: [], status: undefined });
      this.notify();
    }, this.idleMs);
    timer.unref?.();
    this.idle.set(p.id, timer);
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

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export type { Op };
