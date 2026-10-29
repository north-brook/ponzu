import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveBridge } from "@ponzu/mcp/bridge";
import { LocalWorkspace, serve } from "./index.ts";

let dir: string;
let local: LocalWorkspace;
let hostWs: LocalWorkspace | null = null;
let host: ReturnType<typeof serve> | null = null;
/** What ~/.ponzu/host.json would say, when it isn't simply `host`. */
let announced: string | null = null;
/** How many times the bridge asked for Ponzu to be started, as `ponzu mcp` would launch the app. */
let launches = 0;
let bridge: Awaited<ReturnType<typeof serveBridge>>;
let agent: Client;

const text = (r: any) =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function startHost() {
  hostWs = new LocalWorkspace({ cwd: dir });
  host = serve(hostWs, { port: 0 });
}

async function stopHost() {
  host?.stop(true);
  await hostWs?.closeAll();
  host = null;
  hostWs = null;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-bridge-"));
  local = new LocalWorkspace({ cwd: dir });
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  bridge = await serveBridge(
    {
      local,
      findHost: async (launch) => {
        const url = announced ?? (host ? `http://127.0.0.1:${host.port}/mcp` : null);
        if (!url && launch) launches++;
        return url;
      },
      cwd: dir,
      restartGrace: 1500,
    },
    theirs,
  );
  agent = new Client({ name: "claude-code-test", version: "1" });
  await agent.connect(ours);
});

afterAll(async () => {
  await agent.close().catch(() => {});
  await bridge.close();
  await stopHost();
  await local.closeAll();
  await rm(dir, { recursive: true, force: true });
});

test("with no host, tools run in the bridge itself", async () => {
  const { tools } = await agent.listTools();
  expect(tools.length).toBeGreaterThan(25);
  const created = await agent.callTool({
    name: "create_file",
    arguments: { path: join(dir, "shop.design") },
  });
  expect(text(created)).toContain("Created");
  expect(local.designs()).toHaveLength(1);
});

test("once a host is running, calls go to it and the agent shows up there", async () => {
  await startHost();
  const files = await agent.callTool({ name: "list_files", arguments: {} });
  // The host opened nothing yet; it sees the file once it's named.
  expect(text(files)).toContain("No files open");
  const info = await agent.callTool({
    name: "get_basic_info",
    arguments: { file: join(dir, "shop.design") },
  });
  expect(text(info)).toContain("shop");
  expect(hostWs!.designs()).toHaveLength(1);
  const claude = hostWs!.presence.list().find((p) => p.name === "Claude");
  // The host learns where the session comes from, for the studio's card.
  expect(claude?.origin).toMatchObject({ via: "bridge", cwd: dir, clientName: "claude-code-test" });
});

test("when the host goes away, the next call runs locally again", async () => {
  await stopHost();
  const files = await agent.callTool({ name: "list_files", arguments: {} });
  expect(text(files)).toContain("shop");
});

test("a restarted host picks the agent up with a new session", async () => {
  await startHost();
  await agent.callTool({ name: "list_files", arguments: {} });
  await stopHost();
  await startHost();
  const info = await agent.callTool({
    name: "get_basic_info",
    arguments: { file: join(dir, "shop.design") },
  });
  expect(text(info)).toContain("shop");
  expect(hostWs!.presence.list().map((p) => p.name)).toContain("Claude");
});

test("a wait whose host quits and doesn't come back in time says nothing was checked", async () => {
  const file = join(dir, "shop.design");
  const since = cursorOf(
    await agent.callTool({ name: "wait_for_activity", arguments: { file, timeout: 0 } }),
  );
  // Shorter than the grace the bridge gives Ponzu to come back by itself.
  const waiting = agent.callTool({
    name: "wait_for_activity",
    arguments: { file, since, timeout: 1 },
  });
  await Bun.sleep(300);
  launches = 0;
  await stopHost();
  const started = Date.now();
  // It looks for Ponzu to come back for the rest of its time, without starting the old one.
  const r = text(await waiting);
  expect(Date.now() - started).toBeLessThan(4000);
  expect(r).toContain("nothing was checked");
  expect(r).not.toContain("No open threads");
  expect(cursorOf({ content: [{ type: "text", text: r }] })).toBe(since);
  expect(launches).toBe(0);
});

test("a wait whose Ponzu can't be started again doesn't answer from the bridge's own copy", async () => {
  await startHost();
  const file = join(dir, "shop.design");
  const since = cursorOf(
    await agent.callTool({ name: "wait_for_activity", arguments: { file, timeout: 0 } }),
  );
  const waiting = agent.callTool({
    name: "wait_for_activity",
    arguments: { file, since, timeout: 4 },
  });
  await Bun.sleep(300);
  launches = 0;
  await stopHost();
  // Past the grace it asks for Ponzu to be started, which fails here.
  const r = text(await waiting);
  expect(launches).toBeGreaterThan(0);
  expect(r).toContain("nothing was checked");
  expect(r).not.toContain("Ponzu restarted");
  expect(r).not.toContain("No open threads");
});

test("a wait cut off by Ponzu restarting carries on once it's back, and hears what comes next", async () => {
  await startHost();
  const file = join(dir, "shop.design");
  const since = cursorOf(
    await agent.callTool({ name: "wait_for_activity", arguments: { file, timeout: 0 } }),
  );
  const started = Date.now();
  const waiting = agent.callTool({
    name: "wait_for_activity",
    arguments: { file, since, timeout: 20 },
  });
  await Bun.sleep(300);
  // An update quits Ponzu, and the updated one starts a moment later.
  launches = 0;
  await stopHost();
  await Bun.sleep(1000);
  await startHost();
  // The wait is back on the new Ponzu, which reopened the agent's design for it.
  while (!hostWs!.designs().length) await Bun.sleep(50);
  await Bun.sleep(300);
  personComments(hostWs!, "th_after_update");
  const r = text(await waiting);
  expect(r).toStartWith("Ponzu restarted while you waited");
  expect(r).toContain("new comment th_after_update");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(launches).toBe(0);
});

test("a write cut off mid-call isn't sent again", async () => {
  await startHost();
  const file = join(dir, "shop.design");
  await agent.callTool({ name: "get_basic_info", arguments: { file } });
  // The host has the call, then quits before answering.
  const ws = hostWs!;
  const resolve = ws.resolve.bind(ws);
  ws.resolve = async (f) => {
    await stopHost();
    await Bun.sleep(100);
    return resolve(f);
  };
  const result = await agent.callTool({
    name: "create_artboard",
    arguments: { file, name: "Hero", width: 400, height: 300 },
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("may or may not have applied");
  const info = text(await agent.callTool({ name: "get_basic_info", arguments: { file } }));
  expect(info).not.toContain("Hero");
});

test("when another Ponzu takes over, calls move to it", async () => {
  await startHost();
  const file = join(dir, "shop.design");
  await agent.callTool({ name: "get_basic_info", arguments: { file } });
  const first = hostWs!;
  // The desktop app opens while `ponzu serve` keeps running, and announces itself.
  const appWs = new LocalWorkspace({ cwd: dir });
  const app = serve(appWs, { port: 0 });
  announced = `http://127.0.0.1:${app.port}/mcp`;
  try {
    await agent.callTool({ name: "get_basic_info", arguments: { file } });
    expect(appWs.presence.list().map((p) => p.name)).toContain("Claude");
    // The old session ends, so the first host drops the agent.
    await Bun.sleep(100);
    expect(first.presence.list().map((p) => p.name)).not.toContain("Claude");
  } finally {
    announced = null;
    app.stop(true);
    await appWs.closeAll();
  }
});

test("calls racing a takeover all land on the new Ponzu", async () => {
  const file = join(dir, "shop.design");
  await agent.callTool({ name: "get_basic_info", arguments: { file } });
  const appWs = new LocalWorkspace({ cwd: dir });
  const app = serve(appWs, { port: 0 });
  announced = `http://127.0.0.1:${app.port}/mcp`;
  try {
    // Each call sees the takeover; the first to act retires the old host under the others.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        agent.callTool({ name: "get_basic_info", arguments: { file } }),
      ),
    );
    for (const r of results) {
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain("shop");
    }
    expect(appWs.presence.list().map((p) => p.name)).toContain("Claude");
  } finally {
    announced = null;
    app.stop(true);
    await appWs.closeAll();
  }
});

/** The person leaves a comment in the host's canvas. */
function personComments(ws: LocalWorkspace, id: string) {
  const design = ws.designs()[0]!.design;
  const now = Date.now();
  const person = { kind: "user" as const, name: "Sam" };
  design.apply(
    {
      op: "thread.create",
      thread: {
        id,
        pageId: design.doc.pages[0]!.id,
        x: 0,
        y: 0,
        status: "open",
        createdAt: now,
        updatedAt: now,
        messages: [{ id: `m_${id}`, author: person, text: "bigger", createdAt: now }],
      },
    },
    person,
  );
}

const cursorOf = (r: any) => Number(/cursor=(\d+)/.exec(text(r))![1]);

test("comments left while Ponzu restarts reach the agent watching", async () => {
  if (!host) await startHost();
  const file = join(dir, "shop.design");
  const before = cursorOf(
    await agent.callTool({ name: "wait_for_activity", arguments: { file, timeout: 0 } }),
  );
  // An update restarts Ponzu, and the person comments before the agent waits again.
  await stopHost();
  await startHost();
  await agent.callTool({ name: "get_basic_info", arguments: { file } });
  personComments(hostWs!, "th_restart");
  const r = text(
    await agent.callTool({
      name: "wait_for_activity",
      arguments: { file, since: before, timeout: 5 },
    }),
  );
  expect(r).toStartWith("Ponzu restarted since your last wait");
  expect(r).toContain("th_restart [open]");
});

test("a wait that ran in the bridge while the host was down doesn't skip the host's comments", async () => {
  const file = join(dir, "shop.design");
  const onHost = cursorOf(
    await agent.callTool({ name: "wait_for_activity", arguments: { file, timeout: 0 } }),
  );
  await stopHost();
  // The bridge's own Ponzu can't tell what the host had: it says so at once.
  const there = await agent.callTool({
    name: "wait_for_activity",
    arguments: { file, since: onHost, timeout: 5 },
  });
  expect(text(there)).toStartWith("Ponzu restarted since your last wait");
  const inBridge = cursorOf(there);
  await startHost();
  await agent.callTool({ name: "get_basic_info", arguments: { file } });
  personComments(hostWs!, "th_back");
  const r = text(
    await agent.callTool({
      name: "wait_for_activity",
      arguments: { file, since: inBridge, timeout: 5 },
    }),
  );
  expect(r).toContain("th_back [open]");
});

test("an agent keeps its file and its place on the canvas when its connection drops", async () => {
  if (!host) await startHost();
  const shop = join(dir, "shop.design");
  await agent.callTool({ name: "create_file", arguments: { path: join(dir, "cafe.design") } });
  await agent.callTool({ name: "get_basic_info", arguments: { file: shop } });
  expect(hostWs!.designs()).toHaveLength(2);
  const before = hostWs!.presence.list().filter((p) => p.name === "Claude");
  const connected: Record<string, unknown>[] = [];
  hostWs!.telemetry = {
    capture: (event, p) => event === "agent connected" && connected.push(p ?? {}),
    feedback: async () => false,
  };
  // The same Ponzu at another address: the bridge opens a new connection, as when its stream drops.
  announced = `http://127.0.0.1:${host!.port}/mcp?again`;
  try {
    const r = await agent.callTool({ name: "get_basic_info", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("shop");
    expect(connected).toEqual([expect.objectContaining({ resumed: true })]);
    await Bun.sleep(100);
    const after = hostWs!.presence.list().filter((p) => p.name === "Claude");
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
  } finally {
    announced = null;
  }
});

test("after Ponzu restarts, an agent keeps the files it was working in", async () => {
  await stopHost();
  await startHost();
  // The new Ponzu has another design open; the agent's next call doesn't name one.
  await hostWs!.open(join(dir, "cafe.design"));
  const r = await agent.callTool({ name: "get_basic_info", arguments: {} });
  expect(r.isError).toBeFalsy();
  expect(text(r)).toContain("shop");
  expect(hostWs!.designs()).toHaveLength(2);
});

test("a design the agent moves to while Ponzu is down is the one it's in when Ponzu is back", async () => {
  await stopHost();
  // The bridge runs this itself, and the agent is now in the café.
  await agent.callTool({ name: "get_basic_info", arguments: { file: join(dir, "cafe.design") } });
  await startHost();
  await hostWs!.open(join(dir, "shop.design"));
  const r = await agent.callTool({ name: "get_basic_info", arguments: {} });
  expect(r.isError).toBeFalsy();
  expect(text(r)).toContain("cafe");
});
