import { afterEach, expect, test } from "bun:test";
import { FakeRunnerApi } from "./api/fake.ts";
import { serve } from "./server.ts";
import { ToolsRunner } from "./tools-mode.ts";

/*
 * The runner in tools mode (docs/cloud.md, "Driving a canvas"): no Claude Code, the canvas and
 * its tools for the agent driving it, through `POST /tool`, and the runner protocol a canvas
 * with no agent needs.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const DRIVER = { name: "Claude Code", client: "claude" };

async function started(api = new FakeRunnerApi()) {
  const tools = new ToolsRunner({ api: api.client(), log: () => {} });
  await tools.start();
  stops.push(() => tools.stop());
  return { api, tools };
}

async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("it opens the canvas, says it is idle and up, and runs the driving agent's tools on it", async () => {
  const { api, tools } = await started();
  expect(tools.health()).toEqual({ started: true, state: "idle", mode: "tools" });
  await until(() => api.states.length > 0);
  expect(api.states.at(-1)).toMatchObject({ state: "idle", claudeSessionId: null });

  const made = await tools.call(
    "create_artboard",
    { name: "Hero", html: "<div style='width:400px;height:200px'>Hi</div>" },
    DRIVER,
  );
  expect(made.isError).toBe(false);
  // The edit reaches the API as the runner's ops do.
  await until(() => api.doc.snapshot().doc.pages.some((page) => page.artboards.length > 0));
  const tree = await tools.call("get_tree", {}, DRIVER);
  expect(tree.content[0]).toMatchObject({ type: "text" });
  expect((tree.content[0] as { text: string }).text).toContain("Hero");
});

test("a comment it leaves reaches the canvas (the API names its author: the driver)", async () => {
  const { api, tools } = await started();
  await tools.call("create_artboard", { name: "Hero", html: "<p>Hi</p>" }, DRIVER);
  const board = () => api.doc.snapshot().doc.pages[0]?.artboards[0];
  await until(() => Boolean(board()));
  await tools.call("create_comment", { on: board()!.id, text: "Which blue?" }, DRIVER);
  await until(() => api.doc.snapshot().doc.threads.length > 0);
  expect(api.doc.snapshot().doc.threads[0]?.messages[0]?.text).toBe("Which blue?");
});

test("it claims only a stop and a push, and leaves what would begin a turn for whoever answers it", async () => {
  const api = new FakeRunnerApi();
  api.push({ kind: "edit", payload: {} } as never, { priority: "later" });
  api.push({ kind: "message", payload: { text: "Hello?" } });
  api.push({ kind: "push", payload: {} } as never);
  await started(api);
  const taken = (kind: string) =>
    api.events.find((held) => held.event.kind === kind)?.deliveredAt !== undefined;
  await until(() => taken("push"));
  expect([taken("edit"), taken("message")]).toEqual([false, false]);
});

test("a tool that doesn't exist is refused before anything runs", async () => {
  const { tools } = await started();
  expect(() => tools.call("open_pull_request", {}, DRIVER)).toThrow("no canvas tool");
});

test("its port runs a tool for whoever holds its bearer, and nobody else", async () => {
  const { tools } = await started();
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    portToken: "secret",
    poke: () => tools.poke(),
    health: () => tools.health(),
    tool: (name, args, driver) => tools.call(name, args, driver),
  });
  stops.push(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/tool`;
  const body = JSON.stringify({ name: "get_basic_info", args: {}, driver: DRIVER });
  expect((await fetch(url, { method: "POST", body })).status).toBe(401);
  const answered = await fetch(url, {
    method: "POST",
    body,
    headers: { authorization: "Bearer secret" },
  });
  expect(answered.status).toBe(200);
  expect(((await answered.json()) as { isError: boolean }).isError).toBe(false);
  const unknown = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ name: "nope", args: {}, driver: DRIVER }),
    headers: { authorization: "Bearer secret" },
  });
  expect(unknown.status).toBe(404);
});
