import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { ClientMessage, Origin, ServerMessage } from "@ponzu/core";
import { createHttpHandler } from "@ponzu/mcp";
import type { ServerWebSocket } from "bun";
import { findDesigns, type LocalWorkspace } from "./workspace.ts";

export interface ServeOptions {
  port?: number;
  /** 127.0.0.1 by default. Use 0.0.0.0 (or a tailnet IP) to reach it from other machines. */
  hostname?: string;
  /** Built studio assets. When omitted, / says how to run the dev studio. */
  studioDir?: string;
  /** Where to look for .design folders to list on the home screen. */
  root?: string;
  /** Who edits from the studio. */
  user?: string;
}

interface SocketData {
  key: string;
  clientId: string;
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

  const server = Bun.serve<SocketData>({
    port: opts.port ?? 7777,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/mcp" || path.startsWith("/mcp/")) {
        if (!sameHostOk(req, url)) return new Response("Forbidden", { status: 403 });
        // wait_for_activity holds a response open with nothing to send for up to 300s.
        srv.timeout(req, 0);
        return mcp(req);
      }

      if (path === "/ws") {
        const key = url.searchParams.get("file");
        if (!key) return new Response("file required", { status: 400 });
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

      if (path === "/api/files") {
        if (req.method === "POST") {
          const body = (await req.json()) as { path: string };
          const { key, design } = await ws.open(body.path);
          return Response.json({ key, name: design.doc.name });
        }
        const open = ws.designs().map(({ key, design }) => ({
          key,
          name: design.doc.name,
          pages: design.doc.pages.length,
          artboards: design.doc.pages.reduce((n, p) => n + p.artboards.length, 0),
          open: true,
        }));
        const found = opts.root ? await findDesigns(opts.root) : [];
        const extra = found
          .filter((p) => !open.some((o) => o.key === p))
          .map((key) => ({
            key,
            name: key
              .split("/")
              .pop()!
              .replace(/\.design$/, ""),
            open: false,
          }));
        return Response.json({ files: [...open, ...extra], root: opts.root ?? null });
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

      // /files/<encoded key>/assets/... serves a design's assets.
      const assetMatch = /^\/files\/([^/]+)\/(assets\/.+)$/.exec(url.pathname);
      if (assetMatch) {
        const key = decodeURIComponent(assetMatch[1]!);
        const design = ws.get(key);
        if (!design) return new Response("Not found", { status: 404 });
        const rel = decodeURIComponent(assetMatch[2]!);
        const bytes = await design.storage.readAsset(rel);
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

      return serveStudio(path, opts.studioDir);
    },
    websocket: {
      open(s) {
        sockets.add(s);
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
      },
      message(s, raw) {
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
    },
  });

  return server;
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
