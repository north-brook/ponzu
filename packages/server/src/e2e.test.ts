import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalWorkspace, serve } from "./index.ts";

let dir: string;
let ws: LocalWorkspace;
let server: ReturnType<typeof serve>;
let client: Client;

const text = (r: any) =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-e2e-"));
  ws = new LocalWorkspace({ cwd: dir });
  server = serve(ws, { port: 0 });
  client = new Client({ name: "claude-code-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)),
  );
});

afterAll(async () => {
  await client.close();
  await ws.closeAll();
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("an agent builds a file through MCP and it lands on disk", async () => {
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(25);

  const created = await client.callTool({
    name: "create_file",
    arguments: { path: "shop.design", pages: [{ name: "Home" }], tokens: ":root { --ink: #111; }" },
  });
  expect(text(created)).toContain("Created");

  const ab = await client.callTool({
    name: "create_artboard",
    arguments: { name: "Hero", width: 800, height: 600 },
  });
  const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;

  const wrote = await client.callTool({
    name: "write_html",
    arguments: {
      target: abId,
      html: `<h1 data-name="Headline" style="color:var(--ink)">Plants</h1><button onclick="evil()">Shop</button>`,
    },
  });
  expect(text(wrote)).toContain("Headline");
  expect(text(wrote)).toContain("onclick");

  const tree = await client.callTool({ name: "get_tree", arguments: { id: abId } });
  expect(text(tree)).toContain('"Headline"');

  await ws.designs()[0]!.design.flush();
  const html = await readFile(join(dir, "shop.design/pages/home/hero.html"), "utf8");
  expect(html).toContain("Plants");
  expect(html).not.toContain("onclick");
  expect(await readFile(join(dir, "shop.design/tokens.css"), "utf8")).toContain("--ink");
});

test("self-closing svg children written with write_html stay siblings", async () => {
  const ab = await client.callTool({
    name: "create_artboard",
    arguments: { name: "Icons", width: 200, height: 200 },
  });
  const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;
  await client.callTool({
    name: "write_html",
    arguments: {
      target: abId,
      html: `<svg viewBox="0 0 24 24"><g data-name="Glyph"><path d="M1 1"/><path d="M2 2"/><circle r="2"/></g></svg>`,
    },
  });
  const found = text(await client.callTool({ name: "find_nodes", arguments: { name: "Glyph" } }));
  const gId = /(n_\w+)/.exec(found)![1]!;
  for (const mode of ["append", "after"])
    await client.callTool({
      name: "write_html",
      arguments: { target: gId, mode, html: `<path d="M3 3"/><path d="M4 4"/>` },
    });
  const html = text(
    await client.callTool({ name: "get_html", arguments: { id: abId, ids: false } }),
  );
  expect(html).toContain(
    `<svg viewBox="0 0 24 24"><g data-name="Glyph"><path d="M1 1"/><path d="M2 2"/><circle r="2"/><path d="M3 3"/><path d="M4 4"/></g><path d="M3 3"/><path d="M4 4"/></svg>`,
  );
});

test("comments flow through wait_for_activity and reply", async () => {
  const design = ws.designs()[0]!.design;
  const ab = design.doc.pages[0]!.artboards[0]!;
  const start = await client.callTool({ name: "wait_for_activity", arguments: { timeout: 0 } });
  const cursor = Number(/cursor=(\d+)/.exec(text(start))![1]);

  const waiting = client.callTool({
    name: "wait_for_activity",
    arguments: { since: cursor, timeout: 5 },
  });
  setTimeout(() => {
    design.apply(
      {
        op: "thread.create",
        thread: {
          id: "th_test1",
          artboardId: ab.id,
          x: 0,
          y: 0,
          status: "open",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              id: "m_1",
              author: { kind: "user", name: "Bryce" },
              text: "make it bigger",
              createdAt: 1,
            },
          ],
        },
      },
      { kind: "user", name: "Bryce" },
    );
  }, 100);
  const got = text(await waiting);
  expect(got).toContain("make it bigger");

  await client.callTool({
    name: "reply",
    arguments: { thread: "th_test1", text: "Bumped to 96px.", resolve: true },
  });
  const t = design.doc.threads.find((x) => x.id === "th_test1")!;
  expect(t.status).toBe("resolved");
  expect(t.messages[1]!.author).toEqual({ kind: "agent", name: "Claude" });
});

test("presence says what an agent is doing, and in which file", async () => {
  const { key, design } = ws.designs()[0]!;
  const ab = design.doc.pages[0]!.artboards[0]!;
  const claude = () => ws.presence.list().find((p) => p.name === "Claude")!;

  // Straight to /mcp: the studio says so and names the client.
  expect(claude().origin).toMatchObject({ via: "http", clientName: "claude-code-test" });
  expect(claude().since).toBeLessThanOrEqual(Date.now());

  await client.callTool({
    name: "update_artboard",
    arguments: { id: ab.id, x: ab.x + 10 },
  });
  expect(claude()).toMatchObject({ working: [ab.id], file: key });
  await client.callTool({ name: "set_status", arguments: { status: "tightening the hero" } });
  expect(claude()).toMatchObject({ working: [ab.id], status: "tightening the hero" });

  const waiting = client.callTool({ name: "wait_for_activity", arguments: { timeout: 1 } });
  await Bun.sleep(100);
  expect(claude().listening).toBe(true);
  expect(claude().working).toEqual([]);
  expect(claude().status).toBeUndefined();
  await waiting;
  expect(claude().listening).toBe(false);
  expect(claude().listenedAt).toBeGreaterThan(0);
});

test("a malformed origin header costs the folder, not the session", async () => {
  const odd = new Client({ name: "claude-code-odd", version: "1" });
  await odd.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { "x-ponzu-via": "bridge", "x-ponzu-cwd": "%E0%A4%A" } },
    }),
  );
  try {
    await odd.callTool({ name: "list_files", arguments: {} });
    const p = ws.presence.list().find((x) => x.origin?.clientName === "claude-code-odd");
    expect(p?.origin).toMatchObject({ via: "bridge" });
    expect(p?.origin?.cwd).toBeUndefined();
  } finally {
    await odd.close();
  }
});

test("edits made in a text editor show up as file.changed", async () => {
  const design = ws.designs()[0]!.design;
  const cursor = ws.events.cursor;
  const path = join(dir, "shop.design/pages/home/hero.html");
  const html = await readFile(path, "utf8");
  await writeFile(path, html.replace("Plants", "Ferns"));
  const events = await ws.events.wait(cursor, 3000, { types: ["file.changed"] });
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(design.doc)).toContain("Ferns");
});

test("an agent watches its animation through screenshot and record", async () => {
  const { ChromiumRenderer, findChromium } = await import("@ponzu/render/chromium");
  const chromium = findChromium();
  if (!chromium) return;
  ws.renderer = new ChromiumRenderer({ executablePath: chromium });
  try {
    const ab = await client.callTool({
      name: "create_artboard",
      arguments: { name: "Motion", width: 400, height: 240 },
    });
    const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;
    await client.callTool({
      name: "write_html",
      arguments: {
        target: abId,
        html: `<style>@keyframes in { from { opacity: 0 } to { opacity: 1 } } .cta { transition: transform 200ms } .cta:hover { transform: scale(1.1) }</style>
<h1 data-name="Title" style="opacity:0;animation:in 600ms 100ms forwards">Ferns</h1>
<button data-name="Buy" class="cta">Buy</button>`,
      },
    });
    const shot = await client.callTool({ name: "screenshot", arguments: { id: abId } });
    expect(text(shot)).toContain("settled at 700ms");
    expect(text(shot)).toMatch(/: in \(opacity\) 600ms, delay 100ms/);

    const rec = await client.callTool({ name: "record", arguments: { id: abId, frames: 4 } });
    expect((rec.content as { type: string }[]).filter((c) => c.type === "image")).toHaveLength(1);
    expect(text(rec)).toContain("4 frames from 0ms to 700ms settled");

    const buy = /n_\w+(?=: transition)/;
    const tree = text(await client.callTool({ name: "find_nodes", arguments: { name: "Buy" } }));
    const buyId = /(n_\w+)/.exec(tree)![1]!;
    const hover = await client.callTool({
      name: "record",
      arguments: { id: buyId, hover: buyId, frames: 3 },
    });
    expect(text(hover)).toContain(`after hover ${buyId}`);
    expect(text(hover)).toMatch(buy);
    // Lint runs in the hovered end state: the full-width button outgrows the artboard.
    expect(text(hover)).toContain(`Lint at the end (hover ${buyId})`);
  } finally {
    await ws.renderer.close();
    ws.renderer = undefined;
  }
}, 30_000);

test("screenshots load the design's assets/ images", async () => {
  const { ChromiumRenderer, findChromium } = await import("@ponzu/render/chromium");
  const chromium = findChromium();
  if (!chromium) return;
  ws.renderer = new ChromiumRenderer({ executablePath: chromium });
  try {
    // A 1×1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await ws.designs()[0]!.design.storage.writeAsset("assets/dot.png", new Uint8Array(png));
    const ab = await client.callTool({
      name: "create_artboard",
      arguments: {
        name: "Pictures",
        width: 200,
        height: 200,
        html: `<img data-name="Dot" src="assets/dot.png" style="width:40px;height:40px">`,
      },
    });
    const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;
    const shot = text(await client.callTool({ name: "screenshot", arguments: { id: abId } }));
    expect(shot).not.toContain("failed to load");
  } finally {
    await ws.renderer.close();
    ws.renderer = undefined;
  }
}, 30_000);

test("get_node gives rendered boxes, and the height an artboard's content needs", async () => {
  const ab = await client.callTool({
    name: "create_artboard",
    arguments: {
      name: "Boxes",
      width: 390,
      height: 400,
      style: { padding: 20 },
      html: `<div data-name="Hero" style="height:300px;margin-bottom:24px"></div><p data-name="Copy" style="margin:0;font:16px/24px sans-serif">Plants</p>`,
    },
  });
  const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;
  const found = text(await client.callTool({ name: "find_nodes", arguments: { name: "Hero" } }));
  const heroId = /(n_\w+)/.exec(found)![1]!;
  // Without a renderer there's no box, and the rest reads as before.
  const bare = text(await client.callTool({ name: "get_node", arguments: { id: heroId } }));
  expect(bare).toContain("height: 300px");
  expect(bare).not.toContain("Box:");

  const { ChromiumRenderer, findChromium } = await import("@ponzu/render/chromium");
  const chromium = findChromium();
  if (!chromium) return;
  ws.renderer = new ChromiumRenderer({ executablePath: chromium });
  try {
    const hero = text(await client.callTool({ name: "get_node", arguments: { id: heroId } }));
    expect(hero).toContain("Box: x 20, y 20, 350×300.");
    // 20 + 300 + 24 + 24 + 20 = 388, with room to spare.
    const room = text(await client.callTool({ name: "get_node", arguments: { id: abId } }));
    expect(room).toContain("Rendered: 390×400, content needs 388px.");
    // Too short: the hero squeezes before anything overflows, and the shortfall still counts it.
    await client.callTool({
      name: "update_styles",
      arguments: { updates: [{ ids: [abId], style: { height: 360 } }] },
    });
    const short = text(await client.callTool({ name: "get_node", arguments: { id: abId } }));
    expect(short).toContain("Rendered: 390×360, content needs 388px, 28px more.");
    const squeezed = text(await client.callTool({ name: "get_node", arguments: { id: heroId } }));
    expect(squeezed).toContain("350×272.");
  } finally {
    await ws.renderer.close();
    ws.renderer = undefined;
  }
}, 30_000);

test("screenshot lint catches a fit-content artboard grown over the one below it", async () => {
  const key = join(dir, "grown.design");
  await client.callTool({ name: "create_file", arguments: { path: key } });
  const top = await client.callTool({
    name: "create_artboard",
    arguments: { file: key, name: "Wordmarks", width: 800, height: "fit-content", x: 0, y: 0 },
  });
  const topId = /artboard (ab_\w+)/.exec(text(top))![1]!;
  const below = await client.callTool({
    name: "create_artboard",
    arguments: { file: key, name: "Below", width: 800, height: 400, x: 0, y: 980 },
  });
  // Declared, fit-content reads as 900 tall: no overlap yet.
  expect(text(below)).not.toContain("Overlap");

  const { ChromiumRenderer, findChromium } = await import("@ponzu/render/chromium");
  const chromium = findChromium();
  if (!chromium) return;
  ws.renderer = new ChromiumRenderer({ executablePath: chromium });
  try {
    await client.callTool({
      name: "write_html",
      arguments: { file: key, target: topId, html: `<div style="height:1200px"></div>` },
    });
    const shot = text(
      await client.callTool({ name: "screenshot", arguments: { file: key, id: topId } }),
    );
    expect(shot).toMatch(
      /overlaps artboard ab_\w+ "Below" by 800×220px on the canvas; ab_\w+ clears it at y 1280/,
    );
    const info = text(await client.callTool({ name: "get_basic_info", arguments: { file: key } }));
    expect(info).toContain("Overlapping artboards");
    // A new artboard in the row goes right of the grown one, not into it.
    const next = text(
      await client.callTool({
        name: "create_artboard",
        arguments: { file: key, name: "Next", width: 400, height: 400, y: 900 },
      }),
    );
    expect(next).toContain("at (880, 900)");
    expect(next).not.toContain("Overlap");
  } finally {
    await ws.renderer.close();
    ws.renderer = undefined;
  }
}, 30_000);

test("the canvas tells agents its theme; a home screen card can't", async () => {
  const key = join(dir, "themed.design");
  await client.callTool({ name: "create_file", arguments: { path: key } });
  const info = async () =>
    text(await client.callTool({ name: "get_basic_info", arguments: { file: key } }));
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const url = `ws://127.0.0.1:${server.port}/ws?file=${encodeURIComponent(key)}`;
  const card = new WebSocket(`${url}&watch=1`);
  await new Promise((r) => (card.onopen = r));
  card.send(JSON.stringify({ t: "theme", theme: "dark" }));
  const canvas = new WebSocket(url);
  await new Promise((r) => (canvas.onopen = r));
  canvas.send(JSON.stringify({ t: "theme", theme: "sepia" }));
  await new Promise((r) => setTimeout(r, 50));
  expect(ws.theme).toBeUndefined();
  canvas.send(JSON.stringify({ t: "theme", theme: "dark" }));
  await until(() => ws.theme === "dark");
  expect(await info()).toContain("The person's canvas is in dark mode.");
  canvas.close();
  card.close();
  ws.theme = undefined;
});

test("a home screen card's watch socket hears an agent's edits and can't make any", async () => {
  const key = join(dir, "watched.design");
  await client.callTool({ name: "create_file", arguments: { path: key } });
  const ab = await client.callTool({
    name: "create_artboard",
    arguments: { file: key, name: "Card", width: 400, height: 300 },
  });
  const abId = /artboard (ab_\w+)/.exec(text(ab))![1]!;
  const card = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws?file=${encodeURIComponent(key)}&watch=1`,
  );
  const heard: any[] = [];
  card.onmessage = (e) => heard.push(JSON.parse(String(e.data)));
  await new Promise((r) => (card.onopen = r));
  // Nor does it count as an open canvas when one opens beside it.
  const opened: number[] = [];
  ws.telemetry = {
    capture: (event: string, props?: { open_canvases?: number }) => {
      if (event === "canvas opened") opened.push(props?.open_canvases ?? -1);
    },
  } as any;
  const canvas = new WebSocket(`ws://127.0.0.1:${server.port}/ws?file=${encodeURIComponent(key)}`);
  await new Promise((r) => (canvas.onopen = r));
  canvas.close();
  ws.telemetry = undefined;
  expect(opened).toEqual([1]);
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  await until(() => heard.some((m) => m.t === "hello"));
  expect(heard[0].doc.pages[0].artboards.map((a: any) => a.id)).toEqual([abId]);

  const design = ws.get(key)!;
  const before = design.seq;
  card.send(JSON.stringify({ t: "op", req: 1, op: { op: "file.rename", name: "Hijacked" } }));
  await client.callTool({
    name: "write_html",
    arguments: { file: key, target: abId, html: `<p data-name="Line">Live</p>` },
  });
  await until(() => heard.some((m) => m.t === "op"));
  expect(heard.some((m) => m.t === "op")).toBe(true);
  expect(heard.some((m) => m.t === "ack")).toBe(false);
  expect(design.doc.name).not.toBe("Hijacked");
  expect(design.seq).toBe(before + 1);
  card.close();
});
