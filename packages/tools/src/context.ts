import {
  type Author,
  type ColorScheme,
  type Doc,
  type EventType,
  isWatching,
  type Op,
  type PonzuEvent,
  type Presence,
  type PresenceOrigin,
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
  /** Ask any open studio to show this artboard. */
  focus?(key: string, artboardId: string): void;
  /**
   * A link the person can click to open this design in Ponzu, on the artboard if one is given.
   * `origin` is where the agent reached this host, for a canvas link that works from its machine.
   * Absent, or undefined, when there's no canvas for one to open.
   */
  link?(key: string, opts?: { artboard?: string; origin?: string }): string | undefined;
  /** Whether an open canvas has an unsent reply in this thread: agents leave it open. */
  writing?(key: string, thread: string): boolean;
  /** How the person's canvas looks, once one has said. Renders default to it. */
  theme?: ColorScheme;
  events: EventHub;
  presence: PresenceHub;
  /** Usage events and agent feedback for the Ponzu team. Without it nothing is sent. */
  telemetry?: Telemetry;
  /** Keep what the person asked for, as an agent distilled it, in the design's history. */
  intent?(key: string, text: string, origin: Author): void;
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
  /** The origin the agent reached this host at over HTTP, e.g. http://studio-mac:7777. */
  reachedAt?: string;
}

/** What one agent connection remembers between calls. */
export interface ToolSession {
  /** The design this agent last created, named or reached by id: calls without `file` use it. */
  file?: string;
  /** The designs it has worked in, most recent first: waits hear from all of them. */
  files?: string[];
}

/** How many designs a session remembers working in. */
export const SESSION_FILES = 8;

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

export interface EventFilter {
  /** The designs to hear from. All of them when absent. */
  keys?: string[];
  types?: EventType[];
  excludeAuthor?: string;
}

/**
 * A ring buffer of recent events with cursors, so agents can long-poll
 * (`wait_for_activity`) without missing anything between calls.
 *
 * Events are numbered from the microsecond this hub started, not from 0, so a
 * cursor says which Ponzu handed it out: one from before a restart is below
 * `base`, one from a Ponzu that started later (the bridge running tools
 * itself while the host is down) is past `cursor`. Two Ponzus' numbers could
 * only meet if one told more than a thousand events a millisecond.
 */
export class EventHub {
  private buffer: KeyedEvent[] = [];
  /** Where this hub's numbering starts. */
  readonly base: number;
  private seq: number;
  /** The newest event the ring has let go of. */
  private dropped: number;
  private waiters = new Set<() => void>();
  private listeners = new Set<(e: KeyedEvent) => void>();

  constructor(
    private capacity = 500,
    /** In milliseconds, to the fraction: two Ponzus that start in one millisecond start apart. */
    started = performance.timeOrigin + performance.now(),
  ) {
    const base = Math.floor(started * 1000);
    this.base = base;
    this.seq = base;
    this.dropped = base;
  }

  get cursor(): number {
    return this.seq;
  }

  emit(key: string, input: EventInput): PonzuEvent {
    const event = { ...input, seq: ++this.seq } as PonzuEvent;
    const item = { key, event };
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) this.dropped = this.buffer.shift()!.event.seq;
    for (const w of this.waiters) w();
    for (const l of this.listeners) l(item);
    return event;
  }

  on(fn: (e: KeyedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Why events after `cursor` can't all be told: it came from another Ponzu
   * (this one restarted, or it's a different one), or the ring has let some
   * go. Undefined when everything after it is still here. 0 asks for all of it.
   */
  gap(cursor: number): "restart" | "dropped" | undefined {
    if (cursor === 0) return undefined;
    if (cursor < this.base || cursor > this.seq) return "restart";
    if (cursor < this.dropped) return "dropped";
    return undefined;
  }

  since(cursor: number, filter?: EventFilter): KeyedEvent[] {
    return this.buffer.filter(
      (e) =>
        e.event.seq > cursor &&
        (!filter?.keys || filter.keys.includes(e.key)) &&
        (!filter?.types?.length || filter.types.includes(e.event.type)) &&
        !(filter?.excludeAuthor && authorOf(e.event) === filter.excludeAuthor),
    );
  }

  /** Resolve with events after `cursor`, waiting up to `timeoutMs` for the first one. */
  async wait(
    cursor: number,
    timeoutMs: number,
    filter?: EventFilter,
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

/**
 * How long an agent can go without a tool call before it stops showing as
 * working. Writing one large artboard, by tool or straight to its file, can
 * take a model a minute or more, all of it work.
 */
export const WORKING_IDLE = 2 * 60_000;

/** How recently an agent must have made a call for an edit on disk to count as its own. */
const DISK_CREDIT = 5 * 60_000;

/** How often an agent that isn't watching the canvas hears it should, at most. */
const REMIND_EVERY = 10 * 60_000;

export class PresenceHub {
  private map = new Map<string, Presence>();
  private listeners = new Set<(p: Presence[]) => void>();
  private idle = new Map<string, ReturnType<typeof setTimeout>>();
  /** The design each agent's calls last resolved to, read or written: where its disk edits go. */
  private seenIn = new Map<string, string>();
  /** When each agent was last reminded to watch the canvas. */
  private reminded = new Map<string, number>();

  constructor(private idleMs = WORKING_IDLE) {}

  list(): Presence[] {
    const cutoff = Date.now() - 10 * 60_000;
    return [...this.map.values()].filter((p) => p.lastSeen > cutoff);
  }

  /** Whether this agent is watching the canvas. */
  watching(id: string, now = Date.now()): boolean {
    const p = this.map.get(id);
    return !!p && isWatching(p, now);
  }

  /**
   * Whether to remind this agent to watch the canvas once it's done: it
   * isn't watching, and hasn't been reminded in a while.
   */
  shouldRemindToWatch(id: string, now = Date.now()): boolean {
    if (this.watching(id, now)) return false;
    const last = this.reminded.get(id);
    if (last && now - last < REMIND_EVERY) return false;
    this.reminded.set(id, now);
    return true;
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

  /** A call by this agent worked on `file`, even if only to read it. */
  saw(caller: ToolCaller, file: string): void {
    this.seenIn.set(caller.id, file);
  }

  /**
   * These artboards in `file` changed on disk. An agent writing the files
   * itself makes no tool call, so credit the agent most likely behind it:
   * the one seen most recently in this design, or in the project that holds
   * it, that isn't waiting for activity (a waiting agent is watching for the
   * person's edits). With none, it was the person.
   */
  wroteOnDisk(file: string, change: { artboards: string[]; gone: string[] }): void {
    const now = Date.now();
    const writer = [...this.map.values()]
      .filter(
        (p) =>
          p.kind === "agent" &&
          !p.listening &&
          now - p.lastSeen < DISK_CREDIT &&
          (this.seenIn.get(p.id) === file ||
            p.file === file ||
            (p.origin?.cwd && within(file, p.origin.cwd))),
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (!writer) {
      if (change.gone.length) this.drop("", file, change.gone);
      return;
    }
    const caller: ToolCaller = {
      id: writer.id,
      author: { kind: "agent", name: writer.name },
      client: writer.client,
      origin: writer.origin,
    };
    // Counts as a tool call: each write keeps it working for another idle window.
    this.touch(caller);
    this.worked(caller, file, change);
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
    this.seenIn.delete(id);
    this.reminded.delete(id);
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

/** Whether `path` is in the folder `dir`, on either kind of separator. `/` holds everything. */
export function within(path: string, dir: string): boolean {
  const base = dir.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export type { Op };
