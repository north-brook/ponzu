import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCatalogPatch, type Catalog, type CatalogMessage } from "@ponzu/core";
import { getTool, runTool, type ToolCaller } from "@ponzu/tools";
import { CatalogFeed } from "./feed.ts";
import { Home } from "./home.ts";
import { LocalWorkspace, serve } from "./index.ts";

const caller: ToolCaller = {
  id: "agent_spare",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};

let dir: string;
let before: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-feed-"));
  before = process.env.PONZU_TAILSCALE;
});

afterAll(async () => {
  if (before === undefined) delete process.env.PONZU_TAILSCALE;
  else process.env.PONZU_TAILSCALE = before;
  await rm(dir, { recursive: true, force: true });
});

/** A Tailscale that lists one other Mac, "spare", at 127.0.0.1: a second server in this test. */
async function fakeTailnet(): Promise<void> {
  const bin = join(dir, "tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
echo '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"spare","TailscaleIPs":["127.0.0.1"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  process.env.PONZU_TAILSCALE = bin;
}

/** A catalog stream, kept current, with a way to wait for what it should come to show. */
function stream(url: string) {
  const socket = new WebSocket(url);
  let catalog: Catalog | null = null;
  const waiters = new Set<() => void>();
  socket.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as CatalogMessage;
    if (msg.t === "snapshot") catalog = msg.catalog;
    else if (msg.t === "patch" && catalog) catalog = applyCatalogPatch(catalog, msg.patch);
    for (const w of waiters) w();
  };
  return {
    close: () => socket.close(),
    until(pred: (c: Catalog) => boolean, ms = 3000): Promise<Catalog> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (catalog && pred(catalog)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(catalog);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`stream never showed it: ${JSON.stringify(catalog)?.slice(0, 400)}`));
        }, ms);
        waiters.add(check);
        check();
      });
    },
  };
}

test("an agent's work on another Mac reaches this Mac's home screen as it happens", async () => {
  await fakeTailnet();
  const spareDir = join(dir, "spare");
  const spareWs = new LocalWorkspace({ cwd: spareDir });
  const spare = serve(spareWs, { port: 0, root: spareDir, spotlight: "roots" });
  const hereDir = join(dir, "here");
  const hereWs = new LocalWorkspace({ cwd: hereDir });
  // The other Macs serve on the tailnet port: here, the second server's.
  const here = serve(hereWs, {
    port: 0,
    root: hereDir,
    spotlight: "roots",
    tailnet: true,
    tailnetPort: spare.port,
  });
  const home = stream(`ws://127.0.0.1:${here.port}/api/catalog/stream`);
  try {
    await runTool(getTool("create_file")!, { path: "kiosk.design" }, { ws: spareWs, caller });
    let c = await home.until((c) => c.files.some((f) => f.name === "kiosk"));
    const kiosk = c.files.find((f) => f.name === "kiosk")!;
    expect(kiosk).toMatchObject({ machine: "spare", base: "/peers/spare" });
    expect(c.machines.map((m) => m.id)).toEqual(["local", "spare"]);

    // The agent starts on an artboard: the card says so well inside a poll's time.
    const started = Date.now();
    await runTool(
      getTool("create_artboard")!,
      { name: "Hero", width: 400, height: 300 },
      { ws: spareWs, caller },
    );
    await runTool(
      getTool("set_status")!,
      { status: "Laying out the hero" },
      { ws: spareWs, caller },
    );
    c = await home.until((c) =>
      Boolean(c.files.find((f) => f.id === kiosk.id)?.agents?.some((a) => a.status)),
    );
    expect(Date.now() - started).toBeLessThan(1500);
    const card = c.files.find((f) => f.id === kiosk.id)!;
    expect(card.busy).toBe("claude");
    expect(card.agents).toEqual([
      {
        id: "agent_spare",
        name: "Claude",
        client: "claude",
        status: "Laying out the hero",
        activity: "working",
      },
    ]);
    expect(card.artboards.map((a) => a.thumb)).toEqual([
      expect.stringMatching(/^\/peers\/spare\/api\/thumb\?/),
    ]);

    // The agent waits for comments: iterating, not working.
    spareWs.presence.touch(caller, { listening: true, working: [], status: undefined });
    await home.until(
      (c) => c.files.find((f) => f.id === kiosk.id)?.agents?.[0]?.activity === "iterating",
    );

    // The other Mac goes away: its designs leave at once, not on a timeout.
    const gone = Date.now();
    spare.stop(true);
    c = await home.until((c) => !c.files.some((f) => f.machine === "spare"));
    expect(Date.now() - gone).toBeLessThan(1000);
    expect(c.machines.map((m) => m.id)).toEqual(["local"]);
  } finally {
    home.close();
    here.stop(true);
    spare.stop(true);
    await hereWs.closeAll();
    await spareWs.closeAll();
  }
}, 15_000);

test("a Mac on an older Ponzu, without the stream, is still listed", async () => {
  await fakeTailnet();
  // An older server only answers GET /api/catalog.
  const old = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/catalog") return new Response("Not found", { status: 404 });
      return Response.json({
        machine: { id: "local", name: "This Mac", kind: "desktop" },
        files: [
          {
            id: "local:/old/legacy.design",
            key: "/old/legacy.design",
            name: "Legacy",
            machine: "local",
            base: "",
            modified: 1,
            preview: null,
            busy: "openai",
            pages: [],
            artboards: [],
          },
        ],
      });
    },
  });
  const hereDir = join(dir, "here-old");
  const hereWs = new LocalWorkspace({ cwd: hereDir });
  const here = serve(hereWs, {
    port: 0,
    root: hereDir,
    spotlight: "roots",
    tailnet: true,
    tailnetPort: old.port,
  });
  const home = stream(`ws://127.0.0.1:${here.port}/api/catalog/stream`);
  try {
    const c = await home.until((c) => c.files.some((f) => f.name === "Legacy"));
    expect(c.files.find((f) => f.name === "Legacy")).toMatchObject({
      id: "spare:/old/legacy.design",
      machine: "spare",
      base: "/peers/spare",
      busy: "openai",
    });
  } finally {
    home.close();
    here.stop(true);
    old.stop(true);
    await hereWs.closeAll();
  }
}, 15_000);

test("this Mac's own changes reach its home screen, and the stream refuses other sites", async () => {
  delete process.env.PONZU_TAILSCALE;
  const root = join(dir, "solo");
  const ws = new LocalWorkspace({ cwd: root });
  const server = serve(ws, { port: 0, root, spotlight: "roots" });
  const base = `http://127.0.0.1:${server.port}`;
  const home = stream(`ws://127.0.0.1:${server.port}/api/catalog/stream`);
  try {
    await home.until((c) => c.machines.length === 1);
    await runTool(getTool("create_file")!, { path: "pad.design" }, { ws, caller });
    const c = await home.until((c) => c.files.some((f) => f.name === "pad"));
    const pad = c.files.find((f) => f.name === "pad")!;
    expect(pad.created).toBeNumber();

    // Archiving shows on the home screen without waiting for anything else to change.
    const res = await fetch(`${base}/api/shelf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: pad.key, action: "archive" }),
    });
    expect(res.ok).toBe(true);
    await home.until((c) => c.files.find((f) => f.id === pad.id)?.shelf === "archived", 1000);

    const cross = await fetch(`${base}/api/catalog/stream`, {
      headers: { origin: "https://evil.example", upgrade: "websocket", connection: "upgrade" },
    });
    expect(cross.status).toBe(403);
  } finally {
    home.close();
    server.stop(true);
    await ws.closeAll();
  }
}, 15_000);

test("the links to the other Macs close after the last home screen, whoever else is streaming", async () => {
  await fakeTailnet();
  const spareDir = join(dir, "spare-linger");
  const spareWs = new LocalWorkspace({ cwd: spareDir });
  const spare = serve(spareWs, { port: 0, root: spareDir, spotlight: "roots" });
  const hereDir = join(dir, "here-linger");
  const hereWs = new LocalWorkspace({ cwd: hereDir });
  const home = new Home(hereWs, {
    roots: [hereDir],
    spotlight: "roots",
    tailnet: true,
    peerPort: spare.port!,
  });
  const feed = new CatalogFeed(home, hereWs, 200);
  const sink = (scope: "local" | "full") => ({ scope, send: () => {}, close: () => {} });
  try {
    const leaveHome = await feed.subscribe(sink("full"));
    expect(feed.linked).toBe(true);
    leaveHome();
    // Another Mac's stream comes and goes in the meantime: it isn't a home screen here.
    const other = await feed.subscribe(sink("local"));
    await new Promise((r) => setTimeout(r, 400));
    expect(feed.linked).toBe(false);
    other();
  } finally {
    feed.stop();
    home.catalog.close();
    spare.stop(true);
    await hereWs.closeAll();
    await spareWs.closeAll();
  }
}, 15_000);

test("streams that join share a listing rather than each starting one", async () => {
  delete process.env.PONZU_TAILSCALE;
  const root = join(dir, "shared");
  const ws = new LocalWorkspace({ cwd: root });
  const home = new Home(ws, { roots: [root], spotlight: "roots", tailnet: false, peerPort: 0 });
  let listings = 0;
  const local = home.local.bind(home);
  home.local = () => {
    listings++;
    return local();
  };
  const feed = new CatalogFeed(home, ws);
  const sink = (scope: "local" | "full") => ({ scope, send: () => {}, close: () => {} });
  try {
    await feed.subscribe(sink("full"));
    expect(listings).toBe(1);
    // A home screen reloading in several windows, and other Macs reconnecting, all at once.
    await Promise.all([
      ...Array.from({ length: 4 }, () => feed.subscribe(sink("full"))),
      ...Array.from({ length: 4 }, () => feed.subscribe(sink("local"))),
    ]);
    expect(listings).toBe(1);
  } finally {
    feed.stop();
    home.catalog.close();
    await ws.closeAll();
  }
});
