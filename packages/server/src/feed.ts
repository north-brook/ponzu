import {
  type Catalog,
  type CatalogFile,
  type CatalogMachine,
  type CatalogMessage,
  type CatalogPatch,
  sortFiles,
} from "@ponzu/core";
import { type Home, rebase } from "./home.ts";
import type { TailnetPeer } from "./tailnet.ts";
import type { LocalWorkspace } from "./workspace.ts";

/** How soon a change someone sees (an agent starting, a new design) reaches the home screens. */
const SOON = 50;
/** How soon an edit's new artboards and names do: an agent at work edits many times a second. */
const EDIT_DELAY = 1000;
/** The least time between two listings, however busy it gets. */
const MIN_GAP = 150;
/**
 * How often the listing runs anyway, for what no event reports: a change on disk,
 * a redrawn preview, a design found, an agent that stops watching.
 */
const RESYNC = 3000;
/** How often each stream hears it's alive. */
const PING = 5000;
/** Silence after which a link to another Mac counts as gone: a Mac asleep doesn't close its socket. */
const SILENT = 3 * PING;
/** How often the tailnet's peer list is checked for Macs coming and going. */
const PEERS_EVERY = 15_000;
/** How often an older Mac, without the stream, is asked for its catalog. */
const POLL_EVERY = 5000;
/** How often an older Mac is asked again for its stream: it may have updated. */
const UPGRADE_EVERY = 60_000;
/** How long a new home screen waits for the other Macs before its first snapshot. */
const FIRST_WAIT = 2500;
/** How long the links stay up after the last home screen closes, so a reload doesn't redo them. */
const LINGER = 30_000;
/** How often another Mac's stream checks Tailscale still vouches for it. */
const RECHECK = 60_000;

export type Scope = "local" | "full";

export interface Subscriber {
  scope: Scope;
  /** A CatalogMessage, as JSON. */
  send(text: string): void;
  close(): void;
  /** A tailnet caller's address: its access is checked again while it stays connected. */
  peerIp?: string;
}

interface Side {
  machine: CatalogMachine | null;
  files: Map<string, CatalogFile>;
  json: Map<string, string>;
}

/**
 * The catalog as it changes, for this Mac's home screen and the owner's other
 * Macs. Each Mac lists its own designs once per change, however many are
 * watching, and sends what changed; this Mac keeps a socket to each of the
 * others' streams, so their changes reach its home screen as they happen, and
 * a Mac that goes away drops off when its socket does.
 */
export class CatalogFeed {
  private subs = new Set<Subscriber>();
  private local: Side = { machine: null, files: new Map(), json: new Map() };
  private peers = new Map<string, PeerLink>();
  private sent: { machines: string; agents: string; agent: string } = {
    machines: "",
    agents: "",
    agent: "",
  };
  private agents: Catalog["agents"] = [];
  private agent: Catalog["agent"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = Number.POSITIVE_INFINITY;
  private running: Promise<void> | null = null;
  private again = false;
  private lastRun = 0;
  /**
   * What the last listing covered: "full" also asked which agents are set up. Kept current
   * by events and the resync while anyone streams; null once nobody has for a while.
   */
  private listed: Scope | null = null;
  private ready: Promise<void> | null = null;
  private peerTimer: ReturnType<typeof setInterval> | null = null;
  /** Subscribers sent their snapshot: only they get patches, which build on it. */
  private primed = new WeakSet<Subscriber>();
  private loops: ReturnType<typeof setInterval>[] = [];
  private linger: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private home: Home,
    ws: LocalWorkspace,
    /** How long the links outlive the last home screen. */
    private lingerMs = LINGER,
  ) {
    const soon = () => this.poke(SOON);
    const watch = (key: string) => ws.get(key)?.onOp(() => this.poke(EDIT_DELAY));
    ws.presence.on(soon);
    ws.onCreate(soon);
    ws.onOpen((key) => {
      watch(key);
      soon();
    });
    for (const { key } of ws.designs()) watch(key);
  }

  /** Something changed that the home screens show: list again shortly. */
  poke(delay = SOON): void {
    if (!this.subs.size || this.stopped) return;
    const at = Math.max(Date.now() + delay, this.lastRun + MIN_GAP);
    if (at >= this.due) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.due = Number.POSITIVE_INFINITY;
      void this.refresh();
    }, at - Date.now());
  }

  /** Start sending to `sub`: a snapshot now, then each change. */
  async subscribe(sub: Subscriber): Promise<() => void> {
    const first = !this.subs.size;
    this.subs.add(sub);
    if (first) this.start();
    if (sub.scope === "full") {
      // A home screen is back: the links stay. Another Mac's stream says nothing about that.
      if (this.linger) clearTimeout(this.linger);
      this.linger = null;
      this.ready ??= this.startPeers();
      await this.ready;
    }
    await this.baseline(sub.scope);
    if (this.subs.has(sub)) {
      sub.send(JSON.stringify({ t: "snapshot", catalog: this.snapshot(sub.scope) }));
      this.primed.add(sub);
    }
    return () => this.unsubscribe(sub);
  }

  /** Whether this Mac keeps sockets to the other Macs' streams right now. */
  get linked(): boolean {
    return this.peers.size > 0;
  }

  stop(): void {
    this.stopped = true;
    this.halt();
    for (const s of this.subs) s.close();
    this.subs.clear();
  }

  private unsubscribe(sub: Subscriber): void {
    if (!this.subs.delete(sub)) return;
    // With nobody streaming nothing lists, so what was listed goes stale.
    if (!this.subs.size) this.listed = null;
    if (sub.scope === "local") {
      // Nothing left listening at all: the timers go now. Links, if any, wait for the linger.
      if (!this.subs.size && !this.linger) this.halt();
      return;
    }
    if ([...this.subs].some((s) => s.scope === "full")) return;
    // The last home screen here closed: the links to the other Macs go after a while.
    if (this.linger) clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      this.linger = null;
      if (![...this.subs].some((s) => s.scope === "full")) this.stopPeers();
      if (!this.subs.size) this.halt();
    }, this.lingerMs);
    this.linger.unref?.();
  }

  private start(): void {
    // Still running when a home screen comes back before the linger ran out.
    if (this.loops.length) return;
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.loops.push(t);
    };
    every(RESYNC, () => this.poke(0));
    every(PING, () => this.broadcast(() => ({ t: "ping" })));
    every(RECHECK, () => void this.recheck());
  }

  private halt(): void {
    // Nothing keeps the listing current from here on.
    this.listed = null;
    for (const t of this.loops) clearInterval(t);
    this.loops = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = Number.POSITIVE_INFINITY;
    this.stopPeers();
  }

  /** Close the stream of a Mac Tailscale no longer vouches for: re-tagged, or moved to another account. */
  private async recheck(): Promise<void> {
    for (const s of this.subs)
      if (s.peerIp && !(await this.home.trusted(s.peerIp))) {
        this.subs.delete(s);
        s.close();
      }
  }

  /**
   * A listing a new stream's snapshot can come from. One already current serves every
   * stream that joins, and one under way serves those that join meanwhile: a stream
   * joining isn't a change, so it lists nothing more.
   */
  private async baseline(scope: Scope): Promise<void> {
    while (!this.stopped) {
      if (this.listed === "full" || this.listed === scope) return;
      if (!this.running) return this.refresh();
      await this.running;
    }
  }

  /** List this Mac's designs and send what changed. One listing at a time. */
  private refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          this.lastRun = Date.now();
          // A listing that fails (a database another Ponzu holds, say) waits for the next.
          await this.list().catch(() => {});
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async list(): Promise<void> {
    const wantFull = [...this.subs].some((s) => s.scope === "full");
    const [here, agents] = await Promise.all([
      this.home.local(),
      wantFull ? this.home.setupAgents() : Promise.resolve(this.agents),
    ]);
    this.local.machine = here.machine;
    const patch = diff(this.local, here.files);
    this.agents = agents;
    this.agent = this.home.lastAgent();
    this.listed = wantFull ? "full" : "local";
    // This Mac's own designs go to every stream; the rest only to its home screens.
    if (patch.put?.length || patch.drop?.length)
      this.broadcast((s) => (s === "local" ? { t: "patch", patch } : null));
    this.toFull(patch);
  }

  /** A change to the home screens, with the machines and agents if they changed too. */
  private toFull(files: CatalogPatch): void {
    const patch = { ...files, ...this.meta() };
    if (Object.keys(patch).length)
      this.broadcast((s) => (s === "full" ? { t: "patch", patch } : null));
  }

  /** The machines, agents and last agent, where they changed since the home screens last heard. */
  private meta(): CatalogPatch {
    const meta: CatalogPatch = {};
    const machines = JSON.stringify(this.machines());
    if (machines !== this.sent.machines) {
      this.sent.machines = machines;
      meta.machines = this.machines();
    }
    const agents = JSON.stringify(this.agents);
    if (agents !== this.sent.agents) {
      this.sent.agents = agents;
      meta.agents = this.agents;
    }
    const agent = JSON.stringify(this.agent ?? null);
    if (agent !== this.sent.agent) {
      this.sent.agent = agent;
      if (this.agent) meta.agent = this.agent;
    }
    return meta;
  }

  private machines(): CatalogMachine[] {
    const out = this.local.machine ? [this.local.machine] : [];
    for (const link of [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name)))
      if (link.side.machine) out.push(link.side.machine);
    return out;
  }

  private snapshot(scope: Scope): Catalog {
    if (scope === "local")
      return {
        machines: this.local.machine ? [this.local.machine] : [],
        files: sortFiles([...this.local.files.values()]),
        agents: [],
      };
    const files = [...this.local.files.values()];
    for (const link of this.peers.values()) files.push(...link.side.files.values());
    return {
      machines: this.machines(),
      files: sortFiles(files),
      agents: this.agents,
      ...(this.agent ? { agent: this.agent } : {}),
    };
  }

  /** One message per scope, to each stream that has its snapshot. */
  private broadcast(make: (scope: Scope) => CatalogMessage | null): void {
    const by = new Map<Scope, string | null>();
    for (const s of this.subs) {
      if (!this.primed.has(s)) continue;
      if (!by.has(s.scope)) {
        const msg = make(s.scope);
        by.set(s.scope, msg && JSON.stringify(msg));
      }
      const text = by.get(s.scope);
      if (text) s.send(text);
    }
  }

  /** Link to every online Mac Tailscale lists, waiting a moment for their first catalogs. */
  private async startPeers(): Promise<void> {
    await this.syncPeers();
    if (this.peerTimer) clearInterval(this.peerTimer);
    this.peerTimer = setInterval(() => void this.syncPeers(), PEERS_EVERY);
    this.peerTimer.unref?.();
    const firsts = [...this.peers.values()].map((l) => l.first);
    await Promise.race([Promise.all(firsts), new Promise((r) => setTimeout(r, FIRST_WAIT))]);
  }

  private async syncPeers(): Promise<void> {
    const net = await this.home.net();
    if (this.stopped || ![...this.subs].some((s) => s.scope === "full")) return;
    const online = new Map((net?.peers ?? []).filter((p) => p.online).map((p) => [p.name, p]));
    for (const [name, link] of this.peers)
      if (online.get(name)?.ip !== link.ip) this.dropPeer(name);
    for (const p of online.values()) if (!this.peers.has(p.name)) this.addPeer(p);
  }

  private addPeer(p: TailnetPeer): void {
    const link = new PeerLink(p, this.home, (patch) => this.toFull(patch));
    this.peers.set(p.name, link);
  }

  private dropPeer(name: string): void {
    const link = this.peers.get(name);
    if (!link) return;
    this.peers.delete(name);
    const drop = link.close();
    this.toFull({ drop });
  }

  private stopPeers(): void {
    if (this.peerTimer) clearInterval(this.peerTimer);
    this.peerTimer = null;
    for (const name of [...this.peers.keys()]) this.dropPeer(name);
    this.ready = null;
  }
}

/** What changed between what was sent and `files`; `side` becomes `files`. */
function diff(side: Side, files: CatalogFile[]): CatalogPatch {
  const put: CatalogFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.id);
    const json = JSON.stringify(f);
    if (side.json.get(f.id) === json) continue;
    side.json.set(f.id, json);
    side.files.set(f.id, f);
    put.push(f);
  }
  const drop = [...side.files.keys()].filter((id) => !seen.has(id));
  for (const id of drop) {
    side.files.delete(id);
    side.json.delete(id);
  }
  return { ...(put.length ? { put } : {}), ...(drop.length ? { drop } : {}) };
}

/**
 * This Mac's socket to another Mac's catalog stream. While it's open the
 * other Mac's designs are listed; when it closes, or goes quiet, they're
 * dropped, and it reconnects, backing off. A Mac on an older Ponzu, without
 * the stream, is polled instead.
 */
class PeerLink {
  readonly name: string;
  readonly ip: string;
  readonly side: Side = { machine: null, files: new Map(), json: new Map() };
  /** Settles once the first catalog came, or the Mac didn't answer. */
  readonly first: Promise<void>;
  private settle!: () => void;
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private legacySince = 0;
  private closed = false;

  constructor(
    p: TailnetPeer,
    private home: Home,
    private emit: (patch: CatalogPatch) => void,
  ) {
    this.name = p.name;
    this.ip = p.ip;
    this.first = new Promise((r) => {
      this.settle = r;
    });
    this.connect();
  }

  /** Stop, and return the ids of the files it listed. */
  close(): string[] {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.silence) clearTimeout(this.silence);
    this.socket?.close();
    this.socket = null;
    this.settle();
    return [...this.side.files.keys()];
  }

  private connect(): void {
    if (this.closed) return;
    const url = `ws://${this.ip}:${this.home.peerPort}/api/catalog/stream?scope=local`;
    let opened = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.later();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      opened = true;
      this.retry = 0;
      this.legacySince = 0;
      this.heard();
    };
    socket.onmessage = (e) => {
      this.heard();
      let msg: CatalogMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.t === "snapshot") this.replace(msg.catalog.machines[0] ?? null, msg.catalog.files);
      else if (msg.t === "patch") this.apply(msg.patch);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      // Never opened: an older Ponzu that only answers GET /api/catalog, or nothing there.
      if (!opened) {
        this.socket = null;
        if (!this.closed) void this.poll();
        return;
      }
      this.lost();
    };
  }

  /** The socket closed, or went quiet: a Mac asleep or off the network sends no close. */
  private lost(): void {
    const socket = this.socket;
    this.socket = null;
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
    socket?.close();
    if (this.closed) return;
    this.forget();
    this.later();
  }

  /** The other Mac went away: its designs leave the home screen now, not on a timeout. */
  private forget(): void {
    const drop = [...this.side.files.keys()];
    this.side.files.clear();
    this.side.json.clear();
    this.side.machine = null;
    this.emit(drop.length ? { drop } : {});
  }

  private later(delay = Math.min(30_000, 1000 * 2 ** this.retry++)): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  /** Each message proves the Mac is there; a few pings missed, and it isn't. */
  private heard(): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => this.lost(), SILENT);
    this.silence.unref?.();
  }

  private async poll(): Promise<void> {
    const got = await this.home.peerCatalog(this.name, this.ip);
    if (this.closed) return;
    this.settle();
    if (!got) {
      this.forget();
      return this.later();
    }
    this.legacySince ||= Date.now();
    this.replace(got.machine, got.files, true);
    // Back to the stream now and then: the Mac may have updated.
    if (Date.now() - this.legacySince > UPGRADE_EVERY) {
      this.legacySince = 0;
      return this.later(POLL_EVERY);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, POLL_EVERY);
    this.timer.unref?.();
  }

  private replace(machine: CatalogMachine | null, files: CatalogFile[], rebased = false): void {
    this.side.machine = machine && { ...machine, id: this.name, name: this.name };
    const patch = diff(this.side, rebased ? files : files.map((f) => rebase(this.name, f)));
    this.emit(patch);
    this.settle();
  }

  private apply(patch: CatalogPatch): void {
    const put = (patch.put ?? []).map((f) => rebase(this.name, f));
    for (const f of put) {
      this.side.files.set(f.id, f);
      this.side.json.set(f.id, JSON.stringify(f));
    }
    const drop = (patch.drop ?? []).map((id) => `${this.name}:${id.replace(/^local:/, "")}`);
    for (const id of drop) {
      this.side.files.delete(id);
      this.side.json.delete(id);
    }
    if (patch.machines?.[0])
      this.side.machine = { ...patch.machines[0], id: this.name, name: this.name };
    this.emit({ ...(put.length ? { put } : {}), ...(drop.length ? { drop } : {}) });
  }
}
