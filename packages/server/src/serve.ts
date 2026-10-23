import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { CatalogAgent, ClientMessage, Origin, ServerMessage } from "@ponzu/core";
import { createHttpHandler } from "@ponzu/mcp";
import { FsAdapter } from "@ponzu/store/fs";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { advertise, type Bonjour } from "./bonjour.ts";
import { CatalogFeed, type Scope } from "./feed.ts";
import { Home, type OpenedBy } from "./home.ts";
import { isTailnetAddress } from "./tailnet.ts";
import type { LocalWorkspace } from "./workspace.ts";

export interface ServeOptions {
  port?: number;
  /** 127.0.0.1 by default. Use 0.0.0.0 (or a tailnet IP) to reach it from other machines. */
  hostname?: string;
  /** Built studio assets. When omitted, / says how to run the dev studio. */
  studioDir?: string;
  /** A folder whose .design folders the home screen always lists, wherever Spotlight looks. */
  root?: string;
  /** Who edits from the studio. */
  user?: string;
  /**
   * The person's other Macs: list their designs, and serve this one's to them
   * over Tailscale whenever it's running. Off by default; `ponzu serve` (and so
   * the desktop app) turns it on.
   */
  tailnet?: boolean;
  /** Port the owner's Macs reach each other on over the tailnet. Default 7777. */
  tailnetPort?: number;
  /**
   * Where the home screen remembers the designs it found and what the person
   * did with them: archived, kept out of Scratch, the folders let in.
   */
  dbFile?: string;
  /** What versions before the database remembered, read once and kept for going back. */
  stateFile?: string;
  /** How to find designs beyond the roots (see CatalogOptions). Default: Spotlight on macOS. */
  spotlight?: boolean | "roots";
  /** The agents Ponzu can set up on this Mac, for the home screen's first steps. */
  agents?: () => Promise<CatalogAgent[]>;
  /**
   * Designs the person named (`ponzu serve a.design`): the home screen lists
   * them even if they're examples. Designs open in the workspace but not named
   * here were found, not chosen.
   */
  opened?: string[];
  /** This Ponzu's version, as /api/info reports it. */
  version?: string;
  /**
   * Whether usage telemetry is on here, and who it counts as: the phone app
   * follows the Mac it pairs with, so it reports as the same person, and not
   * at all when the person turned it off. Asked on each /api/info.
   */
  telemetry?: () => Promise<{ on: boolean; owner: string | null }>;
}

/**
 * What the phone app and this server agree on: the routes it calls and the
 * messages on a design's socket. Bumped when either changes in a way an older
 * phone can't follow; the phone says so rather than misreading a Mac.
 */
export const PROTOCOL = 1;

/** How long a phone counts as using this Mac after its last request, for the idle quit. */
const PHONE_ACTIVE_MS = 2 * 60_000;

/**
 * How long this Mac has gone unused: since an agent's last call, or a phone's
 * last request and a couple of minutes more. Never idle while a phone holds a
 * socket open (a canvas, or the catalog stream) whatever it last asked.
 */
export function idleFor(o: {
  agentIdle: number;
  /** When a phone last asked for anything. 0 for never. */
  phoneAt: number;
  phoneSockets: number;
  now: number;
}): number {
  if (o.phoneSockets > 0) return 0;
  const phone = o.phoneAt ? Math.max(0, o.now - o.phoneAt - PHONE_ACTIVE_MS) : Infinity;
  return Math.min(o.agentIdle, phone);
}

/** Who a request comes from: this Mac, or one of the owner's Macs over the tailnet. */
type Caller = "local" | "peer";

interface SocketData {
  key: string;
  clientId: string;
  /** A home screen card showing the design live: it hears edits and makes none. */
  watch?: boolean;
  /** Set when this socket relays to a design on another Mac. */
  relay?: { url: string; upstream?: WebSocket; queue: string[] };
  /** Set when this socket is a catalog stream: this Mac's home screen, or another Mac's server. */
  feed?: { scope: Scope; peerIp?: string; stop?: () => void; closed?: boolean };
  /** Opened by the phone app. While one is open, this Mac counts as in use. */
  phone?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

/**
 * One local server: the studio UI, a WebSocket per open canvas, assets,
 * and MCP over streamable HTTP at /mcp.
 */
export function serve(ws: LocalWorkspace, opts: ServeOptions = {}) {
  const user: Origin = { kind: "user", name: opts.user ?? process.env.USER ?? "You" };
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const mcp = createHttpHandler(ws, { onClose: (id) => ws.presence.leave(id) });
  /** When a phone last asked this Mac for anything, so the app doesn't quit under it. */
  let phoneAt = 0;
  /** The phone's open sockets: a canvas, or its catalog stream (which `sockets` doesn't hold). */
  const phones = new Set<ServerWebSocket<SocketData>>();
  const phoneSockets = () => phones.size;

  const send = (s: ServerWebSocket<SocketData>, msg: ServerMessage) => s.send(JSON.stringify(msg));
  const broadcast = (key: string | null, msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const s of sockets) if (key === null || s.data.key === key) s.send(text);
  };

  const subscribed = new Set<string>();
  const subscribe = (key: string) => {
    if (subscribed.has(key)) return;
    subscribed.add(key);
    const design = ws.get(key)!;
    design.onOp((e) =>
      broadcast(key, {
        t: "op",
        seq: e.seq,
        op: e.op,
        origin: e.origin,
        canUndo: design.canUndo,
        canRedo: design.canRedo,
      }),
    );
    design.onReset((doc) => broadcast(key, { t: "reset", doc, seq: design.seq }));
  };
  for (const { key } of ws.designs()) subscribe(key);
  ws.onOpen(subscribe);
  ws.presence.on((presence) => broadcast(null, { t: "presence", presence }));
  ws.onFocus((key, artboard) => {
    const design = ws.get(key);
    const page = design?.doc.pages.find((p) => p.artboards.some((a) => a.id === artboard));
    if (page) broadcast(key, { t: "focus", artboard, page: page.id });
  });

  const home = new Home(ws, {
    roots: opts.root ? [opts.root] : [],
    spotlight: opts.spotlight,
    dbFile: opts.dbFile,
    stateFile: opts.stateFile,
    tailnet: Boolean(opts.tailnet),
    agents: opts.agents,
    peerPort: opts.tailnetPort ?? 7777,
    opened: opts.opened,
  });
  const feed = new CatalogFeed(home, ws);

  /** The idle the desktop app reads: no agent call and no phone for this long. */
  const idleMs = (): number =>
    idleFor({ agentIdle: mcp.idleMs(), phoneAt, phoneSockets: phoneSockets(), now: Date.now() });

  /**
   * Every request, from this Mac or over the tailnet. `caller` says which:
   * another Mac only reaches what the home screen and a canvas need, never
   * MCP or uploads, and never from a browser page.
   */
  const handle = async (
    req: Request,
    srv: Server<SocketData>,
    caller: Caller,
  ): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const phone = caller === "peer" && isPhone(req);
    if (phone) phoneAt = Date.now();

    if (caller === "peer" && !peerAllowed(req, url.pathname))
      return new Response("Forbidden", { status: 403 });

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      if (!sameHostOk(req, url)) return new Response("Forbidden", { status: 403 });
      // wait_for_activity holds a response open with nothing to send for up to 300s.
      srv.timeout(req, 0);
      return mcp(req);
    }

    // A design on another Mac, through its server. Only the studio on this Mac asks.
    const peer = /^\/peers\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (peer) {
      if (caller !== "local" || !sameHostOk(req, url))
        return new Response("Forbidden", { status: 403 });
      const ip = await home.peerIp(decodeURIComponent(peer[1]!));
      if (!ip) return new Response("Not found", { status: 404 });
      const target = `http://${ip}:${opts.tailnetPort ?? 7777}${peer[2]}${url.search}`;
      if (peer[2] === "/ws") {
        const data: SocketData = {
          key: target,
          clientId: crypto.randomUUID(),
          watch: url.searchParams.get("watch") === "1",
          relay: { url: target.replace(/^http/, "ws"), queue: [] },
        };
        if (srv.upgrade(req, { data })) return;
        return new Response("Upgrade failed", { status: 400 });
      }
      return relay(req, target);
    }

    if (path === "/ws") {
      const key = url.searchParams.get("file");
      if (!key) return new Response("file required", { status: 400 });
      // Another Mac opens only what this one's home screen lists.
      if (caller === "peer" && !(await home.listed(key)))
        return new Response("Not found", { status: 404 });
      try {
        await ws.open(key);
      } catch (err) {
        return new Response(String(err), { status: 404 });
      }
      const resolved = (await ws.resolve(key)).key;
      subscribe(resolved);
      const watch = url.searchParams.get("watch") === "1";
      if (
        srv.upgrade(req, {
          data: {
            key: resolved,
            clientId: crypto.randomUUID(),
            watch,
            ...(phone ? { phone } : {}),
          },
        })
      )
        return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // The catalog as it changes. Another Mac gets this Mac's designs alone.
    if (path === "/api/catalog/stream") {
      if (caller === "local" && !sameHostOk(req, url))
        return new Response("Forbidden", { status: 403 });
      const scope: Scope =
        caller === "peer" || url.searchParams.get("scope") === "local" ? "local" : "full";
      const peerIp = caller === "peer" ? srv.requestIP(req)?.address : undefined;
      const data: SocketData = {
        key: "",
        clientId: crypto.randomUUID(),
        feed: { scope, peerIp },
        ...(phone ? { phone } : {}),
      };
      if (srv.upgrade(req, { data })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (path === "/api/catalog") {
      if (caller === "peer" || url.searchParams.get("scope") === "local")
        return Response.json(await home.local());
      return Response.json(await home.full());
    }

    // The person archives, restores or shelves a design. Another Mac's studio asks this
    // Mac for its own designs, so every Mac shows the same.
    if (path === "/api/shelf") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (caller === "local" && !sameHostOk(req, url))
        return new Response("Forbidden", { status: 403 });
      const body = (await req.json().catch(() => null)) as ShelfRequest | null;
      if (!body || typeof body.key !== "string" || !SHELF_ACTIONS.includes(body.action))
        return new Response("key and action required", { status: 400 });
      if (!(await home.catalog.has(body.key))) return new Response("Not found", { status: 404 });
      if (home.catalog.db.readOnly)
        return new Response("A newer Ponzu owns this Mac's catalog", { status: 409 });
      if (body.action === "archive") home.catalog.archive(body.key);
      else if (body.action === "restore") home.catalog.restore(body.key);
      else home.catalog.shelve(body.key, body.action === "scratch" ? "scratch" : "recent");
      feed.poke(0);
      return Response.json({ ok: true });
    }

    // What agents changed in this Mac's designs, for the phone's Activity.
    if (path === "/api/activity") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const entries = await home.activity({
        since: Number.isFinite(since) ? since : 0,
        file: url.searchParams.get("file") ?? undefined,
        limit: Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 100,
      });
      return Response.json({ entries });
    }

    if (path === "/api/preview" || path === "/api/thumb") {
      const key = url.searchParams.get("file");
      if (!key) return new Response("file required", { status: 400 });
      const bytes =
        path === "/api/preview"
          ? await home.preview(key, url.searchParams.get("theme") === "dark" ? "dark" : "light")
          : await home.thumb(
              key,
              url.searchParams.get("artboard") ?? "",
              url.searchParams.get("v") ?? "",
            );
      if (!bytes) return new Response("Not found", { status: 404 });
      return new Response(bytes as BodyInit, {
        // Versioned URLs: a new edit or preview gets a new one.
        headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000" },
      });
    }

    if (path === "/api/files") {
      if (req.method === "POST") {
        // `by: "person"` from the studio and the app; `ponzu mcp` registering a project's
        // designs, and any older client, leaves it out.
        const body = (await req.json()) as { path: string; by?: OpenedBy };
        const { key, design } = await home.open(
          body.path,
          body.by === "person" ? "person" : "agent",
        );
        feed.poke(0);
        return Response.json({ key, name: design.doc.name });
      }
      const open = ws.designs().map(({ key, design }) => ({
        key,
        name: design.doc.name,
        pages: design.doc.pages.length,
        artboards: design.doc.pages.reduce((n, p) => n + p.artboards.length, 0),
        open: true,
      }));
      return Response.json({ files: open, root: opts.root ?? null });
    }

    if (path === "/api/info") {
      const net = await home.net();
      const telemetry = (await opts.telemetry?.()) ?? { on: false, owner: null };
      return Response.json({
        version: opts.version ?? "0.0.0",
        protocol: PROTOCOL,
        mcp: `${url.origin}/mcp`,
        renderer: Boolean(ws.renderer),
        /**
         * Seconds since anyone last used this Ponzu: an agent's call, or the phone app
         * asking for something. The desktop app quits a windowless Ponzu after a while.
         */
        idle: Math.floor(idleMs() / 1000),
        /** This Mac on the tailnet: what the phone saves to find it again. */
        machine: {
          name: net?.name ?? null,
          dns: net?.dns ?? null,
          kind: await home.machineKind(),
        },
        /** Whether this Mac reports usage, and the person it reports as (a hash). */
        telemetry,
      });
    }

    // The owner's Macs on the tailnet, this one first: the phone pairs with one Mac
    // and learns the others here, since iOS can't list a tailnet's devices.
    if (path === "/api/macs") {
      const net = await home.net();
      if (!net) return Response.json({ macs: [] });
      const kind = await home.machineKind();
      return Response.json({
        macs: [
          { name: net.name, dns: net.dns ?? null, ip: net.ip, online: true, self: true, kind },
          ...net.peers.map((p) => ({
            name: p.name,
            dns: p.dns ?? null,
            ip: p.ip,
            online: p.online,
            self: false,
          })),
        ],
      });
    }

    // /files/<encoded key>/assets/... serves a design's assets: an open one's, or
    // one the home screen lists, which its preview and thumbnails draw from disk.
    const assetMatch = /^\/files\/([^/]+)\/(assets\/.+)$/.exec(url.pathname);
    if (assetMatch) {
      const key = decodeURIComponent(assetMatch[1]!);
      const storage =
        ws.get(key)?.storage ?? ((await home.listed(key)) ? new FsAdapter(key) : null);
      if (!storage) return new Response("Not found", { status: 404 });
      const rel = decodeURIComponent(assetMatch[2]!);
      const bytes = await storage.readAsset(rel);
      if (!bytes) return new Response("Not found", { status: 404 });
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": MIME[extname(rel).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    }

    if (req.method === "POST" && /^\/files\/([^/]+)\/upload$/.test(url.pathname)) {
      const key = decodeURIComponent(/^\/files\/([^/]+)\/upload$/.exec(url.pathname)![1]!);
      const design = ws.get(key);
      if (!design) return new Response("Not found", { status: 404 });
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return new Response("file required", { status: 400 });
      const safe = file.name.replace(/[^\w.-]+/g, "-").slice(-80) || "upload";
      const rel = `assets/${safe}`;
      await design.storage.writeAsset(rel, new Uint8Array(await file.arrayBuffer()));
      return Response.json({ path: rel });
    }

    // Another Mac only gets the routes above; nothing falls through to the studio.
    if (caller === "peer") return new Response("Not found", { status: 404 });
    return serveStudio(path, opts.studioDir);
  };

  const websocket: WebSocketHandler<SocketData> = {
    open(s) {
      if (s.data.phone) phones.add(s);
      if (s.data.feed) return openFeed(s);
      sockets.add(s);
      if (s.data.relay) return openRelay(s);
      if (!s.data.watch) {
        let canvases = 0;
        for (const c of sockets) if (!c.data.watch) canvases++;
        ws.telemetry?.capture("canvas opened", { open_canvases: canvases });
      }
      const design = ws.get(s.data.key)!;
      send(s, {
        t: "hello",
        doc: design.doc,
        seq: design.seq,
        path: s.data.key,
        presence: ws.presence.list(),
        canUndo: design.canUndo,
        canRedo: design.canRedo,
      });
    },
    close(s) {
      if (s.data.phone) {
        phones.delete(s);
        // Counted as in use until now, then for a couple of minutes, as after any request.
        phoneAt = Date.now();
      }
      if (s.data.feed) {
        s.data.feed.closed = true;
        s.data.feed.stop?.();
        return;
      }
      sockets.delete(s);
      s.data.relay?.upstream?.close();
    },
    message(s, raw) {
      if (s.data.feed) return;
      const relayed = s.data.relay;
      if (relayed) {
        const text = String(raw);
        if (relayed.upstream?.readyState === WebSocket.OPEN) relayed.upstream.send(text);
        else relayed.queue.push(text);
        return;
      }
      if (s.data.watch) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const design = ws.get(s.data.key);
      if (!design) return;
      try {
        if (msg.t === "op") {
          design.apply(msg.op, user);
          if (msg.op.op === "thread.create" || msg.op.op === "thread.message")
            ws.telemetry?.capture("comment left", { reply: msg.op.op === "thread.message" });
          send(s, { t: "ack", req: msg.req });
        } else if (msg.t === "undo") {
          design.undo(user);
          send(s, { t: "ack", req: msg.req });
        } else if (msg.t === "redo") {
          design.redo(user);
          send(s, { t: "ack", req: msg.req });
        } else if (msg.t === "theme" && (msg.theme === "light" || msg.theme === "dark")) {
          ws.theme = msg.theme;
        }
      } catch (err) {
        const req = "req" in msg ? msg.req : undefined;
        send(s, { t: "error", message: err instanceof Error ? err.message : String(err), req });
        // Resync so the client drops its optimistic state.
        send(s, { t: "reset", doc: design.doc, seq: design.seq });
      }
    },
  };

  /** Send a catalog stream the catalog, then each change, until it closes. */
  const openFeed = (s: ServerWebSocket<SocketData>) => {
    const f = s.data.feed!;
    void feed
      .subscribe({
        scope: f.scope,
        peerIp: f.peerIp,
        send: (text) => s.send(text),
        close: () => s.close(),
      })
      .then((stop) => {
        if (f.closed) stop();
        else f.stop = stop;
      });
  };

  /** Pipe a studio socket to the same design's socket on another Mac. */
  const openRelay = (s: ServerWebSocket<SocketData>) => {
    const relayed = s.data.relay!;
    const upstream = new WebSocket(relayed.url);
    relayed.upstream = upstream;
    upstream.onopen = () => {
      for (const m of relayed.queue.splice(0)) upstream.send(m);
    };
    upstream.onmessage = (e) => s.send(String(e.data));
    upstream.onclose = () => s.close();
    upstream.onerror = () => s.close();
  };

  const server = Bun.serve<SocketData>({
    port: opts.port ?? 7777,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req, srv) {
      // Bound past loopback (--host 0.0.0.0 or a tailnet IP), this listener hears the
      // tailnet too: a tailnet caller gets the same check and limits as on the tailnet one.
      // Other addresses (the LAN) keep the access `--host` has always given them.
      if (!isLoopback(opts.hostname ?? "127.0.0.1")) {
        const ip = srv.requestIP(req)?.address ?? "";
        if (isTailnetAddress(ip)) {
          if (!(await home.trusted(ip))) return new Response("Forbidden", { status: 403 });
          return handle(req, srv, "peer");
        }
      }
      return handle(req, srv, "local");
    },
    websocket,
  });
  // Renders load a design's assets from here, as the canvas does.
  ws.assetOrigin = `http://127.0.0.1:${server.port}`;

  // The owner's other Macs reach this one on its tailnet address. Each request is checked
  // against Tailscale: only devices signed in as the same user get through.
  let tailnetServer: Server<SocketData> | null = null;
  /** Whether this server answers on the tailnet port, given this Mac's tailnet address. */
  const onTailnet = (ip: string): boolean => {
    const host = opts.hostname ?? "127.0.0.1";
    const port = opts.tailnetPort ?? 7777;
    if (tailnetServer) return true;
    return (host === "0.0.0.0" || host === "::" || host === ip) && server.port === port;
  };
  let stopped = false;
  const listenOnTailnet = async () => {
    if (!opts.tailnet) return;
    const net = await home.net();
    if (stopped) return;
    if (!net) return updateAdvert(null);
    // Not when the main listener already hears the tailnet address on the tailnet port: it
    // checks tailnet callers itself, and a second bind there would fail.
    if (!onTailnet(net.ip)) bindTailnet(net.ip);
    updateAdvert(onTailnet(net.ip) && net.dns ? net : null);
  };
  const bindTailnet = (ip: string) => {
    const port = opts.tailnetPort ?? 7777;
    try {
      // Always the tailnet port, whatever port this Mac's own server got: that's where
      // the other Macs look. It doesn't clash with a server on 127.0.0.1 at the same port.
      tailnetServer = Bun.serve<SocketData>({
        port,
        hostname: ip,
        idleTimeout: 255,
        async fetch(req, srv) {
          const ip = srv.requestIP(req)?.address ?? "";
          if (!(await home.trusted(ip))) return new Response("Forbidden", { status: 403 });
          return handle(req, srv, "peer");
        },
        websocket,
      });
    } catch {
      // The address went away, or the port is taken there. Tried again on the next check.
    }
  };
  // The phone on the same Wi-Fi finds this Mac by Bonjour, then connects to its MagicDNS
  // name over the tailnet. Only while this server is the one answering there: not while
  // Tailscale is off, and not for a second Ponzu whose tailnet port another one holds.
  let advert: Bonjour | null = null;
  const updateAdvert = (net: { name: string; dns?: string } | null) => {
    const port = opts.tailnetPort ?? 7777;
    const a = advert?.advert;
    if (net?.dns && a && a.host === net.dns && a.name === net.name && a.port === port) return;
    advert?.stop();
    advert = net?.dns ? advertise({ name: net.name, host: net.dns, port }) : null;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.tailnet) {
    void listenOnTailnet();
    timer = setInterval(() => void listenOnTailnet(), 60_000);
    timer.unref?.();
  }
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    stopped = true;
    clearInterval(timer);
    feed.stop();
    advert?.stop();
    advert = null;
    tailnetServer?.stop(force);
    return stop(force);
  };

  return server;
}

/**
 * What another Mac may ask for: the catalog and its stream, what agents changed, previews,
 * thumbnails, a design's socket and its assets. Not MCP, uploads or the studio, and nothing from a
 * browser page: only another Ponzu server sends these, without an Origin.
 */
export function peerAllowed(req: Request, pathname: string): boolean {
  if (isPage(req)) return false;
  if (pathname === "/api/shelf") return req.method === "POST";
  if (req.method !== "GET") return false;
  return (
    [
      "/api/catalog",
      "/api/catalog/stream",
      "/api/activity",
      "/api/preview",
      "/api/thumb",
      "/api/info",
      "/api/macs",
      "/ws",
    ].includes(pathname) || /^\/files\/[^/]+\/assets\/.+$/.test(pathname)
  );
}

/**
 * The phone app names itself in its User-Agent (`Ponzu-iOS/<version>`). Only a
 * hint for counting this Mac as in use: what it may reach is the same as any
 * of the owner's devices.
 */
export function isPhone(req: Request): boolean {
  return /\bPonzu-iOS\//.test(req.headers.get("user-agent") ?? "");
}

/**
 * A request a web page made: browsers send Sec-Fetch-Site, and an Origin that
 * is a real web origin. The phone app's native WebSocket sends an Origin too,
 * but its own (`ponzu-app://`, or the Mac's address it dials), which no page
 * on the web can forge, since browsers set Origin themselves.
 */
export function isPage(req: Request): boolean {
  if (req.headers.get("sec-fetch-site")) return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (isPhone(req)) {
    try {
      const u = new URL(origin);
      if (u.protocol === "ponzu-app:") return false;
      // iOS's WebSocket sends the URL it dials as the Origin.
      return u.host !== new URL(req.url).host;
    } catch {
      return true;
    }
  }
  return true;
}

const SHELF_ACTIONS = ["archive", "restore", "scratch", "recent"] as const;

interface ShelfRequest {
  key: string;
  action: (typeof SHELF_ACTIONS)[number];
}

/**
 * A request passed on to another Mac's server, and its answer passed back. GETs,
 * and the one POST another Mac takes, a shelf change, without the studio's
 * Origin: the other Mac only answers servers, never pages.
 */
async function relay(req: Request, target: string): Promise<Response> {
  const shelf = req.method === "POST" && new URL(target).pathname === "/api/shelf";
  if (req.method !== "GET" && !shelf) return new Response("Method not allowed", { status: 405 });
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(shelf ? 5_000 : 30_000),
      ...(shelf
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: await req.text(),
          }
        : {}),
    });
    const headers = new Headers();
    for (const h of ["content-type", "cache-control"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return new Response("That Mac isn't answering", { status: 502 });
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Block cross-site requests to MCP from browsers (DNS rebinding, drive-by pages). */
function sameHostOk(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function serveStudio(path: string, dir?: string): Promise<Response> {
  if (!dir || !existsSync(dir)) {
    return new Response(
      `<!doctype html><meta charset=utf-8><title>Ponzu</title><body style="font:15px system-ui;padding:40px;max-width:560px">
<h1 style="font-weight:600">Ponzu is running</h1><p>The studio isn't built in this checkout. Run <code>bun run --filter @ponzu/studio dev</code> and open the URL it prints, or <code>bun run build</code> first.</p>
<p>MCP endpoint: <code>/mcp</code></p></body>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(dir, clean);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory())
    file = join(dir, "index.html");
  const body = await readFile(file);
  const ext = extname(file);
  return new Response(body, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}
