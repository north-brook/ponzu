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
      findHost: async () => announced ?? (host ? `http://127.0.0.1:${host.port}/mcp` : null),
      cwd: dir,
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

test("a long poll moves to the bridge when its host quits mid-wait", async () => {
  const file = join(dir, "shop.design");
  const waiting = agent.callTool({
    name: "wait_for_activity",
    arguments: { file, timeout: 2 },
  });
  await Bun.sleep(300);
  await stopHost();
  const started = Date.now();
  // Read-only, so it's retried locally: a fresh 2s wait, not a hang.
  expect(text(await waiting)).toContain("Nothing new");
  expect(Date.now() - started).toBeLessThan(4000);
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
