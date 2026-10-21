import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { CatalogAgent, ClientMessage, Origin, ServerMessage } from "@ponzu/core";
import { createHttpHandler } from "@ponzu/mcp";
import { FsAdapter } from "@ponzu/store/fs";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
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
  /** Where the home screen remembers which guarded folders it may read. */
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
}

/** Who a request comes from: this Mac, or one of the owner's Macs over the tailnet. */
type Caller = "local" | "peer";

interface SocketData {
  key: string;
  clientId: string;
  /** Set when this socket relays to a design on another Mac. */
  relay?: { url: string; upstream?: WebSocket; queue: string[] };
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
  ws.events.on(({ key, event }) => {
    if (event.type === "selection")
      broadcast(key, { t: "selection", selection: ws.selection(key) });
  });

  const home = new Home(ws, {
    roots: opts.root ? [opts.root] : [],
    spotlight: opts.spotlight,
    stateFile: opts.stateFile,
    tailnet: Boolean(opts.tailnet),
    agents: opts.agents,
    peerPort: opts.tailnetPort ?? 7777,
    opened: opts.opened,
  });

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
      if (srv.upgrade(req, { data: { key: resolved, clientId: crypto.randomUUID() } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (path === "/api/catalog") {
      if (caller === "peer" || url.searchParams.get("scope") === "local")
        return Response.json(await home.local());
      return Response.json(await home.full());
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
      return Response.json({
        version: "0.1.0",
        mcp: `${url.origin}/mcp`,
        renderer: Boolean(ws.renderer),
        /** Seconds since an agent last had a call running. */
        idle: Math.floor(mcp.idleMs() / 1000),
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
      sockets.add(s);
      if (s.data.relay) return openRelay(s);
      ws.telemetry?.capture("canvas opened", { open_canvases: sockets.size });
      const design = ws.get(s.data.key)!;
      send(s, {
        t: "hello",
        doc: design.doc,
        seq: design.seq,
        path: s.data.key,
        presence: ws.presence.list(),
        selection: ws.selection(s.data.key),
        canUndo: design.canUndo,
        canRedo: design.canRedo,
      });
    },
    close(s) {
      sockets.delete(s);
      s.data.relay?.upstream?.close();
    },
    message(s, raw) {
      const relayed = s.data.relay;
      if (relayed) {
        const text = String(raw);
        if (relayed.upstream?.readyState === WebSocket.OPEN) relayed.upstream.send(text);
        else relayed.queue.push(text);
        return;
      }
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
        } else if (msg.t === "select") {
          ws.setSelection(s.data.key, msg.selection);
        }
      } catch (err) {
        const req = "req" in msg ? msg.req : undefined;
        send(s, { t: "error", message: err instanceof Error ? err.message : String(err), req });
        // Resync so the client drops its optimistic state.
        send(s, { t: "reset", doc: design.doc, seq: design.seq });
      }
    },
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
  const listenOnTailnet = async () => {
    if (!opts.tailnet || tailnetServer) return;
    const net = await home.net();
    if (!net) return;
    // Not when the main listener already hears the tailnet address on the tailnet port: it
    // checks tailnet callers itself, and a second bind there would fail.
    const host = opts.hostname ?? "127.0.0.1";
    const port = opts.tailnetPort ?? 7777;
    if ((host === "0.0.0.0" || host === "::" || host === net.ip) && server.port === port) return;
    try {
      // Always the tailnet port, whatever port this Mac's own server got: that's where
      // the other Macs look. It doesn't clash with a server on 127.0.0.1 at the same port.
      tailnetServer = Bun.serve<SocketData>({
        port,
        hostname: net.ip,
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
  if (opts.tailnet) {
    void listenOnTailnet();
    const timer = setInterval(() => void listenOnTailnet(), 60_000);
    timer.unref?.();
    const stop = server.stop.bind(server);
    server.stop = (force?: boolean) => {
      clearInterval(timer);
      tailnetServer?.stop(force);
      return stop(force);
    };
  }

  return server;
}

/**
 * What another Mac may ask for: the catalog, previews, thumbnails, a design's
 * socket and its assets. Not MCP, uploads or the studio, and nothing from a
 * browser page: only another Ponzu server sends these, without an Origin.
 */
function peerAllowed(req: Request, pathname: string): boolean {
  if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) return false;
  if (req.method !== "GET") return false;
  return (
    ["/api/catalog", "/api/preview", "/api/thumb", "/api/info", "/ws"].includes(pathname) ||
    /^\/files\/[^/]+\/assets\/.+$/.test(pathname)
  );
}

/** A request passed on to another Mac's server, and its answer passed back. */
async function relay(req: Request, target: string): Promise<Response> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(30_000) });
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
