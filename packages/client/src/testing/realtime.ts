import type { Clock } from "../clock.ts";
import type {
  RealtimeListener,
  RealtimeStatus,
  RealtimeSubscription,
  RealtimeTransport,
  Sealed,
} from "../live/realtime.ts";

/** What a fake seal stands for: the query, and whose it is. */
export interface FakeQuery {
  name: string;
  args: Record<string, unknown>;
  userId: string;
}

const PREFIX = "fake:";

/** A seal the fake transport can read back, good for 60 seconds as the API's are. */
export function fakeSeal(query: FakeQuery, now: number): Sealed {
  const text = JSON.stringify(query);
  return { capability: PREFIX + text, queryFingerprint: text, expiresAt: now + 60_000 };
}

function unseal(sealed: Sealed): FakeQuery {
  if (!sealed.capability.startsWith(PREFIX)) throw new Error("not a fake seal");
  return JSON.parse(sealed.capability.slice(PREFIX.length)) as FakeQuery;
}

export class FakeSubscription implements RealtimeSubscription {
  closed = false;
  status: RealtimeStatus = "connecting";
  renewals = 0;
  /** The last result sent, as JSON, so an unchanged one is not sent again. */
  sent: string | null = null;
  private cancelExpiry: () => void = () => {};

  constructor(
    private readonly realtime: FakeRealtime,
    readonly query: FakeQuery,
    public sealed: Sealed,
    readonly listener: RealtimeListener,
  ) {
    this.expireAt(sealed.expiresAt);
  }

  async renew(sealed: Sealed): Promise<void> {
    if (this.closed || this.status === "error") throw new Error("This subscription is over.");
    if (sealed.queryFingerprint !== this.sealed.queryFingerprint) {
      throw new Error("Live-query renewal must be for the same query.");
    }
    this.renewals++;
    this.sealed = sealed;
    this.expireAt(sealed.expiresAt);
    // Renewed after it went stale: Realtime subscribes again and sends the result whole.
    if (this.status === "stale") this.realtime.resync(this);
  }

  close(): void {
    this.closed = true;
    this.cancelExpiry();
  }

  setStatus(status: RealtimeStatus): void {
    if (this.closed || this.status === status) return;
    this.status = status;
    this.listener.status(status);
  }

  private expireAt(at: number): void {
    this.cancelExpiry();
    const clock = this.realtime.clock;
    if (!clock) return;
    this.cancelExpiry = clock.schedule(() => this.setStatus("stale"), at - clock.now());
  }
}

/**
 * Realtime in memory. Subscriptions hear `rowsFor(query)` when they start and whenever
 * `refresh()` finds it changed; the methods below play out what the real service does to a
 * client: a dropped socket, a reconnect, a subscription that fails. With a clock, a seal that
 * is not renewed in time makes its subscription go stale, as Neon's does.
 */
export class FakeRealtime implements RealtimeTransport {
  readonly url = "wss://realtime.test";
  private subs: FakeSubscription[] = [];
  private online = true;

  constructor(
    private readonly rowsFor: (query: FakeQuery) => unknown[] = () => [],
    readonly clock?: Clock,
  ) {}

  subscribe(url: string, sealed: Sealed, listener: RealtimeListener): RealtimeSubscription {
    if (url !== this.url) throw new Error(`No Realtime at ${url}.`);
    const sub = new FakeSubscription(this, unseal(sealed), sealed, listener);
    this.subs.push(sub);
    queueMicrotask(() => this.resync(sub));
    return sub;
  }

  close(): void {
    for (const sub of this.subs) sub.close();
    this.subs = [];
  }

  /** The subscriptions still open, for one query or all. */
  open(name?: string): FakeSubscription[] {
    this.subs = this.subs.filter((sub) => !sub.closed);
    return this.subs.filter((sub) => name === undefined || sub.query.name === name);
  }

  /** The rows may have changed: send each live subscription its result if it did. */
  refresh(): void {
    for (const sub of this.open()) if (sub.status === "live") this.send(sub, false);
  }

  /** The socket drops: every subscription is reconnecting and hears nothing. */
  disconnect(): void {
    this.online = false;
    for (const sub of this.open()) sub.setStatus("connecting");
  }

  /** It comes back: each subscription whose seal still holds gets its whole result again. */
  reconnect(): void {
    this.online = true;
    for (const sub of this.open()) if (sub.status !== "stale") this.resync(sub);
  }

  /** A subscription fails for good, as one does when a row grows past 4 MiB. */
  fail(name: string): void {
    for (const sub of this.open(name)) sub.setStatus("error");
  }

  /** Send the whole result and go live, as a new or renewed subscription does. */
  resync(sub: FakeSubscription): void {
    if (sub.closed || !this.online || sub.status === "error") return;
    this.send(sub, true);
    sub.setStatus("live");
  }

  private send(sub: FakeSubscription, always: boolean): void {
    const rows = this.rowsFor(sub.query);
    const json = JSON.stringify(rows);
    if (!always && json === sub.sent) return;
    sub.sent = json;
    sub.listener.rows(JSON.parse(json));
  }
}
