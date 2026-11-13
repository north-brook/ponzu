import type { MaxLiveQueries } from "@ponzu/api/types";
import type { Api } from "../api.ts";
import { type Clock, systemClock } from "../clock.ts";
import { ApiError } from "../errors.ts";
import { keepUnchanged } from "../model/map.ts";
import {
  neonRealtime,
  type RealtimeStatus,
  type RealtimeSubscription,
  type RealtimeTransport,
  type Sealed,
} from "./realtime.ts";
import { DECODE, type LiveArgs, type LiveQueryName, type LiveRows, type RawRow } from "./rows.ts";

/*
 * Live queries (docs/cloud.md, "Realtime"): the API seals a named query for 60 seconds, the
 * client subscribes with it, and renews every subscription it holds in one `POST /v1/live`
 * call every 50 seconds (in as few as the API's limit per call allows). A query the API refuses
 * ends on its own; one that fails otherwise is tried again alone, with a growing wait, while the
 * rest carry on.
 */

/** The API's limit per call, typed against it: a change there fails to compile here. */
export const MAX_LIVE_QUERIES: MaxLiveQueries = 32;

/** A seal lasts 60 seconds; renewing at 50 leaves room for a slow call. */
const RENEW_MS = 50_000;
/** A renewal due this soon rides along with a call that is being made anyway. */
const ALIGN_MS = 25_000;
const RETRY_MS = { first: 1_000, last: 60_000 };
/** Refusals that asking again cannot change: the query has ended. */
const FINAL = { not_found: 404, forbidden: 403, invalid_request: 400 } as const;

/**
 * `connecting`: no rows yet. `live`: the rows are current. `offline`: the rows are the last
 * known (a dropped connection, the app in the background, the API failing) and will be
 * replaced by a full fresh result once it is back. `ended`: refused, for good; see `error`.
 */
export type LiveStatus = "connecting" | "live" | "offline" | "ended";

export interface LiveSnapshot<Row> {
  /** Undefined until the first result. Unordered: see sort.ts. */
  readonly rows: readonly Row[] | undefined;
  readonly status: LiveStatus;
  /** Why it ended: `not_found` or `forbidden` when the person may no longer see it. */
  readonly error?: ApiError;
}

export interface Live {
  /**
   * Watch a query. `onChange` hears each new snapshot; the first comes once the API has sealed
   * it and Realtime has answered. Subscribing twice to the same query shares one subscription.
   */
  subscribe<Name extends LiveQueryName>(
    name: Name,
    args: LiveArgs[Name],
    onChange: (snapshot: LiveSnapshot<LiveRows[Name]>) => void,
  ): () => void;
  /** The current snapshot: the same object until something changes. */
  snapshot<Name extends LiveQueryName>(
    name: Name,
    args: LiveArgs[Name],
  ): LiveSnapshot<LiveRows[Name]>;
  /** The app went to the background: let go of the sockets and stop renewing. */
  pause(): void;
  /** Back in the foreground: subscribe again, each query delivering a full fresh result. */
  resume(): void;
  close(): void;
}

export interface LiveOptions {
  api: Pick<Api, "live">;
  /** Neon Realtime unless given. */
  transport?: RealtimeTransport;
  clock?: Clock;
}

const CONNECTING: LiveSnapshot<never> = Object.freeze({ rows: undefined, status: "connecting" });

interface Entry {
  key: string;
  name: LiveQueryName;
  args: object;
  snapshot: LiveSnapshot<unknown>;
  listeners: Set<(snapshot: LiveSnapshot<any>) => void>;
  sub: RealtimeSubscription | null;
  /** When it next needs sealing: now for a new or broken subscription, else its renewal. */
  due: number;
  /** Failures in a row, for the wait before the next try. */
  failures: number;
}

export function createLive(opts: LiveOptions): Live {
  return new LiveQueries(opts);
}

class LiveQueries implements Live {
  private readonly api: Pick<Api, "live">;
  private readonly transport: RealtimeTransport;
  private readonly clock: Clock;
  private entries = new Map<string, Entry>();
  private cancelTimer: (() => void) | null = null;
  private calling = false;
  /** Whole calls that failed in a row. */
  private failures = 0;
  private paused = false;
  private closed = false;

  constructor(opts: LiveOptions) {
    this.api = opts.api;
    this.transport = opts.transport ?? neonRealtime();
    this.clock = opts.clock ?? systemClock;
  }

  subscribe<Name extends LiveQueryName>(
    name: Name,
    args: LiveArgs[Name],
    onChange: (snapshot: LiveSnapshot<LiveRows[Name]>) => void,
  ): () => void {
    const key = keyOf(name, args);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        name,
        args,
        snapshot: CONNECTING,
        listeners: new Set(),
        sub: null,
        due: this.clock.now(),
        failures: 0,
      };
      this.entries.set(key, entry);
      this.schedule();
    }
    const listener = (snapshot: LiveSnapshot<any>) => onChange(snapshot);
    entry.listeners.add(listener);
    const owner = entry;
    // Joining a query that has already answered: hear where it stands, once this has returned.
    const joined = entry.snapshot;
    if (joined !== CONNECTING) {
      void Promise.resolve().then(() => {
        if (owner.listeners.has(listener) && owner.snapshot === joined) listener(joined);
      });
    }
    return () => {
      owner.listeners.delete(listener);
      if (owner.listeners.size > 0 || this.entries.get(key) !== owner) return;
      this.entries.delete(key);
      owner.sub?.close();
      owner.sub = null;
    };
  }

  snapshot<Name extends LiveQueryName>(name: Name, args: LiveArgs[Name]) {
    return (this.entries.get(keyOf(name, args))?.snapshot ?? CONNECTING) as LiveSnapshot<
      LiveRows[Name]
    >;
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (const entry of this.entries.values()) {
      entry.sub?.close();
      entry.sub = null;
      if (entry.snapshot.status !== "ended") this.update(entry, { status: "offline" });
    }
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    const now = this.clock.now();
    for (const entry of this.entries.values()) entry.due = now;
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.cancelTimer?.();
    for (const entry of this.entries.values()) entry.sub?.close();
    this.entries.clear();
    this.transport.close();
  }

  /** Wake for the next query that needs sealing. */
  private schedule(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.paused || this.closed || this.calling) return;
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.snapshot.status !== "ended") next = Math.min(next, entry.due);
    }
    if (next === Number.POSITIVE_INFINITY) return;
    this.cancelTimer = this.clock.schedule(
      () => {
        this.cancelTimer = null;
        void this.seal();
      },
      Math.max(0, next - this.clock.now()),
    );
  }

  /** Everything due, and everything nearly due, in as few calls as the API takes, all at once. */
  private async seal(): Promise<void> {
    const now = this.clock.now();
    const due = [...this.entries.values()].filter(
      (entry) => entry.snapshot.status !== "ended" && entry.due <= now + ALIGN_MS,
    );
    if (due.length === 0) return this.schedule();
    for (const entry of due) entry.due = Number.POSITIVE_INFINITY;
    this.calling = true;
    try {
      const calls: Promise<Entry[]>[] = [];
      for (let i = 0; i < due.length; i += MAX_LIVE_QUERIES) {
        calls.push(this.sealSome(due.slice(i, i + MAX_LIVE_QUERIES)));
      }
      const unanswered = (await Promise.all(calls)).flat();
      if (unanswered.length === 0) {
        this.failures = 0;
        return;
      }
      const wait = backoff(this.failures++);
      for (const entry of unanswered) {
        entry.due = this.clock.now() + wait;
        if (!entry.sub && entry.snapshot.rows) this.update(entry, { status: "offline" });
      }
    } finally {
      this.calling = false;
      this.schedule();
    }
  }

  /**
   * One call for `batch`, answering with the entries it got no answer for. A call refused whole
   * is not sent again as it was: it is halved until the query at fault is alone, and that ends.
   */
  private async sealSome(batch: Entry[]): Promise<Entry[]> {
    try {
      const answer = await this.api.live(batch.map(({ name, args }) => ({ name, args })));
      answer.results.forEach((result, i) => this.take(batch[i]!, answer.url, result));
      return [];
    } catch (error) {
      if (!(error instanceof ApiError && Object.hasOwn(FINAL, error.code))) return batch;
      if (batch.length === 1) {
        this.end(batch[0]!, error);
        return [];
      }
      const half = Math.ceil(batch.length / 2);
      const halves = [batch.slice(0, half), batch.slice(half)].map((part) => this.sealSome(part));
      return (await Promise.all(halves)).flat();
    }
  }

  private take(
    entry: Entry,
    url: string,
    result:
      | { name: string; sealed: Sealed }
      | { name: string; error: { code: string; message: string } },
  ): void {
    // Let go of meanwhile, or paused: `resume` seals everything again.
    if (this.entries.get(entry.key) !== entry || this.paused) return;
    if ("error" in result) {
      const { code, message } = result.error;
      if (Object.hasOwn(FINAL, code)) {
        this.end(entry, new ApiError(FINAL[code as keyof typeof FINAL], code as never, message));
      } else {
        // GitHub or the database failing for this one query: the others are not held back.
        entry.due = this.clock.now() + backoff(entry.failures++);
      }
      return;
    }
    entry.due = this.clock.now() + RENEW_MS;
    if (entry.sub) {
      const renewing = entry.sub;
      renewing.renew(result.sealed).catch(() => {
        if (entry.sub === renewing) this.restart(entry);
      });
      return;
    }
    // A transport may speak before `subscribe` returns: until then the subscription is current.
    let sub: RealtimeSubscription | null = null;
    const current = () => sub === null || entry.sub === sub;
    sub = this.transport.subscribe(url, result.sealed, {
      rows: (raw) => {
        if (!current()) return;
        const decode = DECODE[entry.name] as (row: RawRow<LiveQueryName>) => unknown;
        entry.failures = 0;
        // Realtime sends a query's whole result each time, every row a new object. A row equal
        // to one held stays the object held, so a screen drawing a line per row (the thread,
        // the sidebar) draws again only the rows that changed; a result that changed nothing
        // (a row written with the same values) is not heard again.
        const rows = keepUnchanged(
          entry.snapshot.rows,
          raw.map((row) => decode(row as RawRow<LiveQueryName>)),
        );
        if (rows === entry.snapshot.rows && entry.snapshot.status === "live") return;
        this.update(entry, { rows, status: "live" });
      },
      status: (status) => {
        if (current()) this.heard(entry, status);
      },
    });
    entry.sub = sub;
  }

  /** What the transport says about one subscription. */
  private heard(entry: Entry, status: RealtimeStatus): void {
    switch (status) {
      case "live":
        entry.failures = 0;
        if (entry.snapshot.rows) this.update(entry, { status: "live" });
        return;
      case "connecting":
        if (entry.snapshot.rows) this.update(entry, { status: "offline" });
        return;
      case "stale":
        // The seal ran out before a renewal reached it: renew now.
        this.update(entry, { status: "offline" });
        entry.due = this.clock.now();
        this.schedule();
        return;
      case "error":
        this.restart(entry);
        return;
      case "closed":
        return;
    }
  }

  /** Refused for good: no more tries until it is subscribed to afresh. */
  private end(entry: Entry, error: ApiError): void {
    if (this.entries.get(entry.key) !== entry) return;
    entry.sub?.close();
    entry.sub = null;
    this.update(entry, { status: "ended", error });
  }

  /** A subscription that failed is over: make a new one, which brings the whole result again. */
  private restart(entry: Entry): void {
    entry.sub?.close();
    entry.sub = null;
    if (entry.snapshot.rows) this.update(entry, { status: "offline" });
    entry.due = this.clock.now() + backoff(entry.failures++);
    this.schedule();
  }

  private update(entry: Entry, patch: Partial<LiveSnapshot<unknown>>): void {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch });
    for (const listener of entry.listeners) listener(entry.snapshot);
  }
}

function backoff(failures: number): number {
  return Math.min(RETRY_MS.first * 2 ** failures, RETRY_MS.last);
}

function keyOf(name: string, args: object): string {
  return `${name} ${JSON.stringify(args, Object.keys(args).sort())}`;
}
