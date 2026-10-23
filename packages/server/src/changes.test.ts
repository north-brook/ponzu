import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChange } from "@ponzu/core";
import { getTool, runTool, type ToolCaller } from "@ponzu/tools";
import { CatalogDb } from "./catalog-db.ts";
import { CHANGE_GAP, ChangeLog } from "./changes.ts";
import { LocalWorkspace, serve } from "./index.ts";

const claude: ToolCaller = {
  id: "agent_claude",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};
const person: ToolCaller = { id: "you", author: { kind: "user", name: "You" } };
const codex: ToolCaller = {
  id: "agent_codex",
  author: { kind: "agent", name: "Codex" },
  client: "openai",
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-changes-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A workspace with one design, and a change log on it with a clock the test moves. */
async function setUp(name: string, db = new CatalogDb()) {
  const ws = new LocalWorkspace({ cwd: dir });
  const { key, design } = await ws.open(join(dir, `${name}.design`));
  let now = 1_000_000;
  const log = new ChangeLog(
    db,
    () => ws.presence.list(),
    () => now,
  );
  design.onOp((e) => log.record(key, design.doc, e));
  const tool = (t: string, args: Record<string, unknown>, caller = claude) =>
    runTool(getTool(t)!, { file: key, ...args }, { ws, caller });
  const board = async (n: string, caller = claude) => {
    await tool("create_artboard", { name: n, width: 400, height: 300 }, caller);
    return design.doc.pages[0]!.artboards.find((a) => a.name === n)!.id;
  };
  return {
    ws,
    key,
    design,
    log,
    db,
    tool,
    board,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("an agent's run of edits in a design is one change, and another agent's is another", async () => {
  const t = await setUp("run");
  try {
    // One the person made: not a change.
    await t.board("Before", person);
    expect(t.log.list()).toEqual([]);
    const a = await t.board("Home");
    const b = await t.board("Pricing");
    let list = t.log.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      file: t.key,
      name: "run",
      agent: { name: "Claude", client: "claude" },
      kind: "added",
      artboards: [
        { id: a, name: "Home" },
        { id: b, name: "Pricing" },
      ],
    });

    // A minute on, filling one in: the same change, still new artboards.
    t.tick(60_000);
    await t.tool("write_html", { target: a, html: "<div>Hi</div>" });
    list = t.log.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("added");
    expect(list[0]!.at - list[0]!.start).toBe(60_000);
    expect(list[0]!.summary).toContain("Home");
    // Then one that was there before: "changed".
    const before = t.design.doc.pages[0]!.artboards.find((x) => x.name === "Before")!.id;
    await t.tool("write_html", { target: before, html: "<div>Edited</div>" });
    list = t.log.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("changed");
    expect(list[0]!.artboards.map((x) => x.name)).toEqual(["Home", "Pricing", "Before"]);

    // Another agent: its own change, newest first.
    t.tick(1000);
    await t.tool("write_html", { target: b, html: "<p>Plans</p>" }, codex);
    list = t.log.list();
    expect(list.map((c) => c.agent.name)).toEqual(["Codex", "Claude"]);
    expect(list[0]).toMatchObject({ kind: "changed", artboards: [{ id: b, name: "Pricing" }] });

    // Claude again, past the gap since its last edit: a new change.
    t.tick(CHANGE_GAP + 1);
    await t.tool("write_html", { target: a, html: "<div>Again</div>" });
    expect(t.log.list().map((c) => c.agent.name)).toEqual(["Claude", "Codex", "Claude"]);
    // And `since` leaves out what came before.
    expect(t.log.list({ since: list[0]!.at })).toHaveLength(1);
  } finally {
    await t.ws.closeAll();
  }
});

test("the person's edits and comments aren't agents' changes", async () => {
  const t = await setUp("person");
  try {
    const a = await t.board("Home");
    const before = t.log.list()[0]!;
    t.tick(1000);
    t.design.apply(
      { op: "style", id: a, style: { background: "red" } },
      { kind: "user", name: "You" },
    );
    await t.tool("create_comment", { on: a, text: "Looks good" });
    expect(t.log.list()).toEqual([before]);
  } finally {
    await t.ws.closeAll();
  }
});

test("artboards made and deleted in one run don't count; ones deleted read as removed", async () => {
  const t = await setUp("removed");
  try {
    const a = await t.board("Home");
    const scratch = await t.board("Scratch");
    await t.tool("delete", { ids: [scratch] });
    expect(t.log.list()[0]).toMatchObject({ kind: "added", artboards: [{ id: a }] });

    t.tick(CHANGE_GAP + 1);
    await t.tool("delete", { ids: [a] });
    expect(t.log.list()[0]).toMatchObject({
      kind: "removed",
      artboards: [{ id: a, name: "Home" }],
    });
  } finally {
    await t.ws.closeAll();
  }
});

test("changes outlive a restart, and every Ponzu on the Mac shares them", async () => {
  const file = join(dir, "shared.db");
  const t = await setUp("restart", new CatalogDb(file));
  try {
    await t.board("Home");
    const written = t.log.list();
    // Another process, or this one after a restart, reads them from the database.
    const other = new ChangeLog(new CatalogDb(file), () => []);
    expect(other.list()).toEqual(written);
    expect(other.list({ file: t.key })).toEqual(written);
    expect(other.list({ file: join(dir, "other.design") })).toEqual([]);
  } finally {
    await t.ws.closeAll();
  }
});

test("a run whose only artboard was made and deleted again leaves nothing", async () => {
  const t = await setUp("undone");
  try {
    const a = await t.board("Scratch");
    expect(t.log.list()).toHaveLength(1);
    await t.tool("delete", { ids: [a] });
    expect(t.log.list()).toEqual([]);
  } finally {
    await t.ws.closeAll();
  }
});

test("a design keeps its last 200 changes", async () => {
  const db = new CatalogDb();
  for (let i = 0; i < 205; i++)
    db.putChange({ id: `ch_${i}`, path: "/x.design", at: i + 1, body: "{}" }, 200);
  db.putChange({ id: "ch_y", path: "/y.design", at: 1, body: "{}" }, 200);
  const rows = db.changes({ path: "/x.design", limit: 500 });
  expect(rows).toHaveLength(200);
  expect(rows[0]!.id).toBe("ch_204");
  expect(rows.at(-1)!.id).toBe("ch_5");
  expect(db.changes({ path: "/y.design", limit: 10 })).toHaveLength(1);
});

test("GET /api/activity lists what agents changed, with thumbnails", async () => {
  const sub = await mkdtemp(join(dir, "route-"));
  const ws = new LocalWorkspace({ cwd: sub });
  const server = serve(ws, { port: 0, root: sub, spotlight: "roots" });
  try {
    await runTool(getTool("create_file")!, { path: "kiosk.design" }, { ws, caller: claude });
    await runTool(
      getTool("create_artboard")!,
      { name: "Hero", width: 400, height: 300 },
      { ws, caller: claude },
    );
    const res = await fetch(`http://127.0.0.1:${server.port}/api/activity?since=1`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: AgentChange[] };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "kiosk",
      agent: { name: "Claude", client: "claude" },
      kind: "added",
      artboards: [{ name: "Hero", thumb: expect.stringMatching(/^\/api\/thumb\?file=/) }],
    });
    const later = await fetch(
      `http://127.0.0.1:${server.port}/api/activity?since=${entries[0]!.at}`,
    );
    expect(((await later.json()) as { entries: AgentChange[] }).entries).toEqual([]);
  } finally {
    server.stop(true);
    await ws.closeAll();
  }
});
