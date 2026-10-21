import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getTool, runTool, type ToolCaller } from "@ponzu/tools";
import { LocalWorkspace, serve } from "./index.ts";

// Agents working with many designs open at once: which file does a call without `file` reach?

const EXAMPLES = join(import.meta.dir, "../../../examples");
const captured: Record<string, unknown>[] = [];
let dir: string;
let ws: LocalWorkspace;
let server: ReturnType<typeof serve>;
const clients: Client[] = [];

const text = (r: any) =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function connect(name = "claude-code-test") {
  const client = new Client({ name, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)),
  );
  clients.push(client);
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: tool, arguments: args });
    return { text: text(r), isError: Boolean(r.isError) };
  };
}

const keyOf = (name: string) => join(dir, `${name}.design`);
const firstArtboard = (name: string) => ws.get(keyOf(name))!.doc.pages[0]!.artboards[0]!.id;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-resolve-"));
  ws = new LocalWorkspace({
    cwd: dir,
    telemetry: {
      capture: (event, properties) => {
        if (event === "tool called") captured.push(properties ?? {});
      },
      feedback: async () => false,
    },
  });
  for (const name of ["halon", "kettle", "weft"]) {
    await cp(join(EXAMPLES, `${name}.design`), keyOf(name), { recursive: true });
    await ws.open(keyOf(name));
  }
  server = serve(ws, { port: 0 });
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await ws.closeAll();
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("after create_file, calls without file go to the new file", async () => {
  const call = await connect();
  const created = await call("create_file", { path: "fresh.design" });
  const page = /(pg_\w+)/.exec(created.text)![1]!;

  const ab = await call("create_artboard", { page, name: "Hero", width: 400, height: 300 });
  expect(ab.isError).toBe(false);
  expect(ws.get(keyOf("fresh"))!.doc.pages[0]!.artboards.map((a) => a.name)).toEqual(["Hero"]);

  // Calls that carry no id at all, as a session's first look around does.
  for (const tool of ["get_basic_info", "read_notes", "list_comments", "get_tokens"]) {
    const r = await call(tool);
    expect(r.isError).toBe(false);
  }
  expect((await call("get_basic_info")).text).toContain(`Path: ${keyOf("fresh")}`);
  expect((await call("list_files")).text).toContain(
    `${keyOf("fresh")} (1 page, 1 artboard) (current)`,
  );
});

test("an id finds its file, and the session moves there and says so", async () => {
  const call = await connect();
  await call("get_basic_info", { file: "halon" });
  const kettleBoard = firstArtboard("kettle");

  const tree = await call("get_tree", { id: kettleBoard });
  expect(tree.isError).toBe(false);
  expect(tree.text).toContain('Now in "Kettle"; calls without file use it.');

  // No note once the agent is already there.
  expect((await call("get_tree", { id: kettleBoard })).text).not.toContain("Now in");
  expect((await call("get_basic_info")).text).toContain(`Path: ${keyOf("kettle")}`);
});

test("ids from two files in one call change nothing", async () => {
  const call = await connect();
  await call("get_basic_info", { file: "halon" });
  const halon = ws.get(keyOf("halon"))!.doc.pages[0]!.artboards[0]!;
  const [first, second] = halon.root.children.filter((c) => c.kind === "el");
  const weft = firstArtboard("weft");
  const before = JSON.stringify(halon.root);

  const r = await call("move_nodes", {
    moves: [
      { id: second!.id, before: first!.id },
      { id: weft, parent: halon.id },
    ],
  });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(`${weft} is in "Weft", not "Halon"`);
  expect(JSON.stringify(ws.get(keyOf("halon"))!.doc.pages[0]!.artboards[0]!.root)).toBe(before);
  expect((await call("get_basic_info")).text).toContain(`Path: ${keyOf("halon")}`);
});

test("two agents keep their own current file", async () => {
  const a = await connect("agent-a");
  const b = await connect("agent-b");
  await a("get_basic_info", { file: "halon" });
  await b("get_basic_info", { file: "weft" });
  expect((await a("get_basic_info")).text).toContain(`Path: ${keyOf("halon")}`);
  expect((await b("get_basic_info")).text).toContain(`Path: ${keyOf("weft")}`);
});

test("with nothing to go on, the error is short", async () => {
  const call = await connect();
  // Four files open so far; more than five makes the list a count.
  const r = await call("get_basic_info");
  expect(r.isError).toBe(true);
  expect(r.text).toStartWith("Several files are open; pass file.");
  for (const extra of ["one", "two"]) await ws.open(join(dir, `${extra}.design`));
  const many = await call("read_notes");
  expect(many.isError).toBe(true);
  expect(many.text).toBe("6 files are open; pass file (a path, or a name from list_files).");
  expect((await call("list_files", { query: "KETT" })).text.split("\n")).toEqual([
    expect.stringContaining(keyOf("kettle")),
  ]);
  for (const extra of ["one", "two"]) await ws.close(join(dir, `${extra}.design`));
});

test("copies of one design: ids and names are ambiguous unless the session says which", async () => {
  const copy = join(dir, "worktree/kettle.design");
  await cp(keyOf("kettle"), copy, { recursive: true });
  await ws.open(copy);
  try {
    const call = await connect();
    const board = firstArtboard("kettle");
    const both = await call("get_tree", { id: board });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("is in 2 open files");
    expect(both.text).toContain(copy);

    const byName = await call("get_basic_info", { file: "Kettle" });
    expect(byName.isError).toBe(true);
    expect(byName.text).toContain('"Kettle" matches 2 open files; pass the path');

    await call("get_basic_info", { file: copy });
    const mine = await call("get_node", { id: board });
    expect(mine.isError).toBe(false);
    expect(mine.text).not.toContain("Now in");
    expect((await call("get_basic_info")).text).toContain(`Path: ${copy}`);

    // An id only the original has outweighs the shared one, even with the copy current.
    const original = ws.get(keyOf("kettle"))!.doc;
    const own = original.pages[1]!.id;
    await ws.get(copy)!.apply({ op: "page.delete", id: own }, { kind: "agent", name: "test" });
    const moved = await call("update_artboard", { id: board, page: own });
    expect(moved.isError).toBe(false);
    expect(moved.text).toContain(`Now in "Kettle" (${keyOf("kettle")})`);
    expect(original.pages[1]!.artboards.some((a) => a.id === board)).toBe(true);
  } finally {
    await ws.close(copy);
  }
});

test("a closed current file falls back instead of failing on a stale key", async () => {
  const call = await connect();
  await call("create_file", { path: "brief.design" });
  await ws.close(keyOf("brief"));
  const r = await call("get_basic_info");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("Several files are open");
  expect((await call("get_tree", { id: firstArtboard("weft") })).isError).toBe(false);
});

test("telemetry says how the file was found and why it wasn't, never which", async () => {
  captured.length = 0;
  const caller: ToolCaller = { id: "t", author: { kind: "agent", name: "Claude" } };
  await runTool(getTool("get_basic_info")!, {}, { ws, caller });
  await runTool(getTool("get_basic_info")!, { file: "no-such" }, { ws, caller });
  await runTool(getTool("get_tree")!, { id: firstArtboard("halon") }, { ws, caller, session: {} });
  expect(captured.map((c) => [c.outcome, c.error, c.file_from])).toEqual([
    ["mistake", "file_ambiguous", undefined],
    ["mistake", "file_not_found", undefined],
    ["ok", undefined, "ids"],
  ]);
  expect(JSON.stringify(captured)).not.toContain(dir);
});
