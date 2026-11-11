import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type Artboard,
  type Doc,
  emptyDoc,
  findArtboard,
  locate,
  MAX_NODES,
  MAX_OP_BYTES,
  parseHtml,
  type Scheduler,
  type SyncTransport,
  type Thread,
} from "@ponzu/core";
import type { Sequencer } from "@ponzu/core/testing";
import type { Renderer, RenderRequest } from "@ponzu/render";
import type { Telemetry } from "../context.ts";
import { jsonSchema, runTool } from "../define.ts";
import { type AgentFiles, FileError, localFiles, readGiven } from "../disk.ts";
import { tools as localTools } from "../local/tools.ts";
import { MAX_ASSET_BYTES } from "./asset.ts";
import { CLOUD_INSTRUCTIONS, cloudGuides } from "./guides.ts";
import { AGENT, type MemoryCloud, memoryCloud, memoryHost, memoryTransport } from "./testing.ts";
import { cloudTools, getCloudTool } from "./tools.ts";

const ada: Actor = { kind: "user", id: "user_ada", name: "Ada" };

function board(id: string, name: string, x: number, html: string): Artboard {
  const root = {
    kind: "el" as const,
    id,
    tag: "section",
    name,
    attrs: {},
    style: { width: "800px", height: "600px" },
    children: parseHtml(html).nodes,
  };
  return { id, name, x, y: 0, root };
}

/** One page with two artboards: Hero (a card holding a heading and a paragraph) and Pricing. */
function fern(): Doc {
  const doc = emptyDoc("Fern");
  doc.pages.push({
    id: "pg_home",
    name: "Home",
    artboards: [
      board(
        "ab_hero",
        "Hero",
        0,
        `<div data-id="n_card"><h1 data-id="n_h">Hi</h1><p data-id="n_p">There</p></div>`,
      ),
      board("ab_pricing", "Pricing", 880, `<p data-id="n_plan">Free</p>`),
    ],
  });
  return doc;
}

function comment(id: string, on: string, text: string): Thread {
  const message = { id: `m_${id}`, author: { kind: "user" as const, name: "Ada" }, text };
  return {
    id,
    artboardId: on,
    x: 10,
    y: 10,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ ...message, createdAt: 1 }],
  };
}

const open: MemoryCloud[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const cloud of open.splice(0)) cloud.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function setup(opts: Parameters<typeof memoryCloud>[1] = {}, doc = fern()) {
  const cloud = memoryCloud(doc, opts);
  open.push(cloud);
  const call = (name: string, args: unknown = {}) => runTool(getCloudTool(name)!, args, cloud.ctx);
  return { ...cloud, call };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-cloud-tools-"));
  dirs.push(dir);
  return dir;
}

/** The API behind a gate: no request is answered until `release`. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = (api: Sequencer): SyncTransport => {
    const direct = memoryTransport(api, AGENT);
    return {
      commit: async (ops) => gate.then(() => direct.commit(ops)),
      fetchOps: async (after) => gate.then(() => direct.fetchOps(after)),
      fetchDoc: async () => gate.then(() => direct.fetchDoc()),
    };
  };
  return { transport, release };
}

function fakeRenderer() {
  const calls: RenderRequest[] = [];
  const renderer: Renderer = {
    async render(req) {
      calls.push(req);
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mime: "image/png",
        width: 800,
        height: 600,
        contentHeight: 600,
        issues: [],
      };
    },
    close: async () => {},
  };
  return { renderer, calls };
}

/* ------------------------------------------------------------------ */
/* Reading and writing on a replica                                    */
/* ------------------------------------------------------------------ */

test("an edit reads back at once, before the API has heard of it, and is committed behind the tool", async () => {
  const api = gated();
  const { call, ws, ...cloud } = setup({ transport: api.transport });
  const made = await call("create_artboard", { name: "Sign in", html: `<h1>Welcome back</h1>` });
  const { id } = made.data as { id: string };
  expect(made.text).toContain(`Created artboard ${id} "Sign in" 1440px×900px at (1760, 0)`);
  await call("write_html", { target: id, html: `<button data-name="Continue">Continue</button>` });
  await call("update_styles", { updates: [{ ids: [id], style: { padding: 24 } }] });

  const html = (await call("get_html", { id })).text;
  expect(html).toContain("Welcome back");
  expect(html).toContain('data-name="Continue"');
  expect(html).toContain("padding:24px");
  expect((await call("get_basic_info")).text).toContain(`${id} "Sign in"`);
  // None of that waited: the API hasn't answered a single request.
  expect(cloud.api.seq).toBe(0);
  expect(await ws.design.settled(20)).toBe(false);

  api.release();
  expect(await ws.design.settled(2000)).toBe(true);
  expect(cloud.api.seq).toBe(3);
  expect(findArtboard(cloud.api.doc, id)?.artboard.root.style.padding).toBe("24px");
  expect(cloud.api.log.every((c) => c.actor.id === AGENT.id)).toBe(true);
});

test("a comment the agent leaves is the API's once committed: its author and its time", async () => {
  const { call, api, replica, synced } = setup();
  const made = await call("create_comment", { on: "n_h", text: "Sentence case here?" });
  const id = /Created thread (\S+)\./.exec(made.text)![1]!;
  await synced();
  const committed = api.doc.threads.find((t) => t.id === id)!;
  expect(committed.messages[0]!.author).toEqual({ kind: "agent", name: "Claude", id: AGENT.id });
  expect(replica.doc.threads.find((t) => t.id === id)).toEqual(committed);
  expect((await call("list_comments")).text).toContain(
    `${id} [open] on "Hero" › Hi (n_h): Claude: "Sentence case here?"`,
  );
  await call("reply", { thread: id, text: "Going with sentence case." });
  await call("set_comment_status", { thread: id, status: "resolved" });
  await synced();
  expect(api.doc.threads.find((t) => t.id === id)).toMatchObject({ status: "resolved" });
  expect((await call("list_comments")).text).toBe("No open comments.");
});

test("what a person does mid-session is in the agent's next read", async () => {
  const { call, commitAs, synced, ws } = setup();
  expect((await call("list_comments")).text).toBe("No open comments.");
  commitAs(ada, { op: "thread.create", thread: comment("th_ada", "ab_hero", "Tighter?") });
  commitAs(ada, { op: "artboard.update", id: "ab_pricing", x: 2400 });
  // Still the design as the agent last knew it: nobody has told the replica.
  expect((await call("list_comments")).text).toBe("No open comments.");
  await synced();

  expect((await call("list_comments")).text).toContain('th_ada [open] on "Hero": Ada: "Tighter?"');
  expect((await call("get_comment", { id: "th_ada" })).text).toContain("Ada (user)");
  expect((await call("get_basic_info")).text).toContain(
    'ab_pricing "Pricing" 800px×600px at (2400, 0)',
  );
  // A board made now is placed clear of where Ada put hers.
  const made = await call("create_artboard", { name: "Checkout", width: 800, height: 600 });
  expect(made.text).toContain("at (3280, 0)");

  const heard = ws.events.since(0, { excludeAuthor: AGENT.name }).map((e) => e.event);
  expect(heard).toMatchObject([
    {
      type: "comment.created",
      thread: "th_ada",
      artboard: "ab_hero",
      text: "Tighter?",
      author: "Ada",
    },
    { type: "change", origin: { kind: "user", name: "Ada" }, artboards: ["ab_pricing"] },
  ]);
});

test("the first artboard of a design with no pages brings its page with it", async () => {
  // A design whose pages were all deleted. (A new one starts with one empty page.)
  const { call, replica, api, synced } = setup({}, emptyDoc("Untitled"));
  expect((await call("get_basic_info")).text).toStartWith(
    "Design: Untitled\nNo pages yet. create_artboard makes the first one, or add one with create_page.",
  );
  const lost = await call("create_artboard", { name: "Sign in", page: "Flows" });
  expect(lost.text).toBe(
    "No page Flows: this design has no pages yet. Leave page out and the first one is made, or add it with create_page.",
  );

  const made = await call("create_artboard", { name: "Sign in", html: "<h1>Welcome back</h1>" });
  expect(made.isError).toBeFalsy();
  const { id } = made.data as { id: string };
  const page = replica.doc.pages[0]!;
  expect(made.text).toStartWith(
    `Created artboard ${id} "Sign in" 1440px×900px at (0, 0) on "Home" (${page.id}, made now: the design had no page).`,
  );
  expect(page).toMatchObject({ name: "Home", artboards: [{ id }] });
  // One edit, so the page never arrives without its artboard, or the other way round.
  await synced();
  expect(api.seq).toBe(1);
  expect(api.doc).toEqual(replica.doc);

  const next = await call("create_artboard", { name: "Sign up" });
  expect(next.text).toContain(`at (1520, 0) on "Home".`);
  expect(replica.doc.pages).toHaveLength(1);
});

test("a design whose last page a person deleted takes an artboard all the same", async () => {
  const { call, commitAs, synced, replica } = setup();
  commitAs(ada, { op: "page.delete", id: "pg_home" });
  await synced();
  expect(replica.doc.pages).toEqual([]);
  const made = await call("create_artboard", { name: "Start over" });
  expect(made.isError).toBeFalsy();
  expect(replica.doc.pages.map((p) => [p.name, p.artboards.map((a) => a.name)])).toEqual([
    ["Home", ["Start over"]],
  ]);
});

test("every kind of edit the tools make is one the API takes, and both sides end up the same", async () => {
  const { call, api, replica, synced, ws } = setup();
  const ok = async (name: string, args: unknown) => {
    const r = await call(name, args);
    expect(r.isError, `${name}: ${r.text}`).toBeFalsy();
    return r;
  };
  const made = await ok("create_artboard", {
    name: "Sign in",
    width: 390,
    height: "fit-content",
    style: { display: "flex", gap: 12 },
    html: `<form data-name="Form"><input placeholder="Email"><button>Go</button></form>`,
  });
  const { id } = made.data as { id: string };
  await ok("write_html", {
    target: id,
    mode: "prepend",
    html: `<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`,
  });
  await ok("write_html", { target: "n_p", mode: "replace", html: `<p data-id="n_q">Now</p>` });
  await ok("update_styles", { updates: [{ ids: ["n_h", "n_q"], style: { color: "red" } }] });
  await ok("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  await ok("set_attributes", { id: "n_h", attrs: { title: "Greeting", lang: null } });
  const copies = await ok("duplicate", { ids: ["ab_hero", "n_q"], names: ["Hero / B", "Again"] });
  await ok("move_nodes", { moves: [{ id: "n_q", before: "n_h" }] });
  await ok("rename", {
    updates: [
      { id: "n_card", name: "Card" },
      { id: "ab_hero", name: "Hero / A" },
    ],
  });
  await ok("create_page", { name: "Flows", icon: "flow" });
  await ok("update_artboard", { id, page: "Flows", width: 400, name: "Log in" });
  await ok("update_page", { page: "Flows", name: "Flow", index: 0, icon: null });
  await ok("archive", { ids: ["ab_pricing"] });
  await ok("set_tokens", { tokens: { "--ink": "#111" } });
  await ok("write_note", { name: "brief", content: "A calmer hero." });
  await ok("write_note", { name: "brief", content: null });
  const thread = /Created thread (\S+)\./.exec(
    (await ok("create_comment", { on: "n_h", text: "Keep the greeting?" })).text,
  )![1]!;
  await ok("reply", { thread, text: "Kept.", resolve: true });
  await ok("set_comment_status", { thread, status: "open" });
  await ok("update_design", { name: "Fern app", icon: "phone" });
  await ok("delete", { ids: [...(copies.data as { ids: string[] }).ids, "n_h"] });

  await synced();
  expect(ws.notices?.()).toEqual([]);
  expect(api.seq).toBe(replica.seq);
  expect(api.seq).toBeGreaterThanOrEqual(21);
  expect(replica.doc).toEqual(api.doc);
  expect(api.doc.pages.map((p) => [p.name, p.artboards.map((a) => a.name)])).toEqual([
    ["Flow", ["Log in"]],
    ["Home", ["Hero / A"]],
    ["Archive", ["Pricing"]],
  ]);
});

test("the agent's own edits are told once each, however the API echoes them", async () => {
  const { call, synced, ws } = setup();
  await call("create_comment", { on: "ab_hero", text: "Which photo?" });
  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  // The API stamps the comment, so the replica hears its own op a second time, as an echo.
  await synced();
  expect(ws.events.since(0).map((e) => e.event.type)).toEqual(["comment.created", "change"]);
});

/* ------------------------------------------------------------------ */
/* Edits that don't last                                               */
/* ------------------------------------------------------------------ */

test("an edit the API refuses is reported in the next tool result, once", async () => {
  const api = gated();
  const { call, commitAs, synced, replica } = setup({ transport: api.transport });
  // Ada deletes the board. The agent, not having heard, writes into it.
  commitAs(ada, { op: "artboard.delete", id: "ab_hero" });
  const wrote = await call("write_html", { target: "n_card", html: "<p>More</p>" });
  expect(wrote.isError).toBeFalsy();
  expect(wrote.text).toContain("Wrote 1 element");
  expect(wrote.text).not.toContain("Undone");

  api.release();
  await synced();
  expect(locate(replica.doc, "n_card")).toBeNull();
  const next = await call("get_tree", { id: "ab_pricing" });
  expect(next.isError).toBeFalsy();
  expect(next.text).toStartWith('ab_pricing "Pricing"');
  expect(next.text).toContain(
    "\n\nUndone: an edit you made earlier is not in the design, though the tool said it was.\n- added to n_card: Ponzu refused it (",
  );
  expect(next.text).toContain("Look at what is there now (get_tree, get_html)");
  // Told once.
  expect((await call("get_tree", { id: "ab_pricing" })).text).not.toContain("Undone");
});

test("an edit that stops fitting before it is sent is reported too, with the edits that survived", async () => {
  const api = gated();
  const { call, commitAs, replica, ...cloud } = setup({ transport: api.transport });
  commitAs(ada, { op: "artboard.delete", id: "ab_pricing" });
  // The first edit is out with the API; the second waits its turn behind it.
  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  await call("write_html", { target: "n_plan", html: "<b>Pro</b>" });
  // Ada's delete arrives under both.
  const ahead = cloud.api.opsAfter(0);
  if (ahead === "gone") throw new Error("the log is all there");
  replica.ingest(ahead.ops);

  const next = await call("get_html", { id: "n_h" });
  expect(next.text).toStartWith('<h1 data-id="n_h">Hello</h1>\n\nUndone: an edit you made earlier');
  expect(next.text).toContain(
    "- added to n_plan: it no longer fit once someone else's change landed first (",
  );
  api.release();
  expect(await cloud.ws.design.settled(2000)).toBe(true);
  expect(locate(cloud.api.doc, "n_h")?.node.children).toEqual([{ kind: "text", value: "Hello" }]);
  expect(cloud.api.log).toHaveLength(2);
});

test("a failed call still carries what was undone", async () => {
  const api = gated();
  const { call, commitAs, synced } = setup({ transport: api.transport });
  commitAs(ada, { op: "artboard.delete", id: "ab_hero" });
  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  api.release();
  await synced();
  const failed = await call("get_node", { id: "n_h" });
  expect(failed.isError).toBe(true);
  expect(failed.text).toStartWith("No node with id n_h.\n\nUndone: an edit you made earlier");
});

test("an edit the API would never take is refused before it shows", async () => {
  const { call, replica } = setup();
  const big = await call("set_attributes", { id: "n_h", attrs: { title: "x".repeat(300_000) } });
  expect(big.isError).toBe(true);
  expect(big.text).toStartWith("That edit can't be saved: op.attrs.title is longer than");
  expect(locate(replica.doc, "n_h")?.node.attrs).toEqual({});
  expect(replica.pending).toEqual([]);
});

test("what the API would strip from an edit never shows, and the result says what went", async () => {
  const api = gated();
  const { call, replica, synced, ws, ...cloud } = setup({ transport: api.transport });
  const removed = (what: string) => `\n\nRemoved (designs can't run code): ${what}.`;

  const styled = await call("update_styles", {
    updates: [{ ids: ["n_h"], style: { background: "url(javascript:alert(1))", color: "red" } }],
  });
  expect(styled.text).toBe(`Updated 1 node.${removed("script in background")}`);
  expect(locate(replica.doc, "n_h")?.node.style).toEqual({ color: "red" });

  const linked = await call("set_attributes", {
    id: "n_p",
    attrs: { href: " vbscript:x", title: "ok" },
  });
  expect(linked.text).toBe(`Updated attributes on n_p.${removed("javascript: URL in href")}`);
  expect(locate(replica.doc, "n_p")?.node.attrs).toEqual({ title: "ok" });

  const tokens = await call("set_tokens", { tokens: { "--x": "expression(alert(1))" } });
  expect(tokens.text).toBe(`Tokens: 1 defined.${removed("script in the tokens")}`);
  expect(replica.doc.tokens).not.toContain("expression");

  const made = await call("create_artboard", {
    name: "Sign in",
    style: { backgroundImage: "url( 'javascript:alert(1)' )" },
  });
  expect(made.text).toEndWith(removed("script in background-image on <section>"));
  // Clean edits say nothing of it.
  expect((await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] })).text).toBe(
    "Set text on 1 node.",
  );

  // What the agent read and screenshot before the commit is what everyone gets after it.
  const before = structuredClone(replica.doc);
  expect(JSON.stringify(before)).not.toMatch(/script:|expression/);
  api.release();
  await synced();
  expect(replica.doc).toEqual(before);
  expect(cloud.api.doc).toEqual(before);
  expect(ws.notices()).toEqual([]);
});

test("an edit that didn't apply reports nothing as removed from it", () => {
  const { ws } = setup();
  expect(() =>
    ws.design.apply({ op: "style", id: "n_gone", style: { width: "expression(1)" } }),
  ).toThrow();
  expect(ws.notices()).toEqual([]);
});

test("set_attributes refuses what an attribute can't be, before anything shows", async () => {
  const { call, replica } = setup();
  for (const [name, why] of [
    ["data-name", "A layer's name isn't an attribute. Set it with rename."],
    ["layer-name", "A layer's name isn't an attribute. Set it with rename."],
    ["srcdoc", "Designs can't hold a document inside an attribute; srcdoc is not allowed."],
    ["data-id", "Ids are managed by Ponzu."],
    ["onclick", "Designs can't run code; event handlers are not allowed."],
  ] as const) {
    const r = await call("set_attributes", { id: "n_h", attrs: { [name]: "x", title: "ok" } });
    expect(r.isError, name).toBe(true);
    expect(r.text).toBe(why);
  }
  expect(locate(replica.doc, "n_h")?.node.attrs).toEqual({});
  expect(replica.pending).toEqual([]);
});

test("waiting for edits doesn't sit out the replica's retry wait once the API is back", async () => {
  let down = true;
  // The replica's own retry never comes here, as when it is seconds or half a minute away.
  const never: Scheduler = () => () => {};
  const { call, ws, ...cloud } = setup({
    schedule: never,
    transport: (api) => {
      const direct = memoryTransport(api, AGENT);
      return {
        ...direct,
        commit: async (ops) => {
          if (down) throw new Error("ECONNRESET");
          return direct.commit(ops);
        },
      };
    },
  });
  await call("write_note", { name: "brief", content: "A fitness app." });
  expect(await ws.design.settled(30)).toBe(false);
  expect(cloud.replica.offline).toBe(true);

  // Back before the host asks: the wait starts with a try.
  down = false;
  expect(await ws.design.settled(2000)).toBe(true);
  expect(cloud.api.doc.notes.brief).toBe("A fitness app.");

  // Back while the host waits: it keeps trying.
  down = true;
  await call("write_note", { name: "brief", content: "A running app." });
  const waiting = ws.design.settled(2000);
  setTimeout(() => {
    down = false;
  }, 50);
  expect(await waiting).toBe(true);
  expect(cloud.api.doc.notes.brief).toBe("A running app.");
});

test("the host can wait for edits to be committed, and gives up when the API can't be reached", async () => {
  let down = true;
  const { call, ws, ...cloud } = setup({
    transport: (api) => {
      const direct = memoryTransport(api, AGENT);
      return {
        ...direct,
        commit: async (ops) => {
          if (down) throw new Error("ECONNRESET");
          return direct.commit(ops);
        },
      };
    },
  });
  expect(await ws.design.settled(0)).toBe(true);
  await call("write_note", { name: "brief", content: "A fitness app." });
  expect(await ws.design.settled(30)).toBe(false);
  expect(cloud.replica.offline).toBe(true);
  // Still in the agent's view, and still pending: it is sent again once the API answers.
  expect((await call("read_notes", { name: "brief" })).text).toBe("A fitness app.");
  down = false;
  expect(await ws.design.settled(5000)).toBe(true);
  expect(cloud.api.doc.notes.brief).toBe("A fitness app.");
});

/* ------------------------------------------------------------------ */
/* Status and presence                                                 */
/* ------------------------------------------------------------------ */

test("the host hears what the agent is working on, and only when it changes", async () => {
  const { call, host, commitAs, synced } = setup();
  await call("get_basic_info");
  await call("get_tree");
  expect(host.statuses).toEqual([]);

  await call("set_status", {
    status: "tightening the hero",
    intent: " A calmer hero. ",
    artboards: ["ab_hero"],
  });
  expect(host.statuses).toEqual([{ artboards: ["ab_hero"], status: "tightening the hero" }]);
  expect(host.intents).toEqual(["A calmer hero."]);

  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  await call("get_html", { id: "n_h" });
  expect(host.statuses).toHaveLength(1);
  await call("set_text", { updates: [{ id: "n_plan", text: "Pro" }] });
  expect(host.statuses.at(-1)).toEqual({
    artboards: ["ab_hero", "ab_pricing"],
    status: "tightening the hero",
  });
  expect((await call("get_basic_info")).text).toContain(
    "Working now: Claude on ab_hero, ab_pricing",
  );

  // Ada deletes a board the agent was on: it isn't working on it any more.
  await synced();
  commitAs(ada, { op: "artboard.delete", id: "ab_pricing" });
  await synced();
  expect(host.statuses.at(-1)).toEqual({ artboards: ["ab_hero"], status: "tightening the hero" });
});

test("a host that fails to take a status or an intent fails no tool, and nothing in the replica", async () => {
  const host = memoryHost();
  host.status = () => {
    throw new Error("status endpoint 500");
  };
  host.intent = async () => {
    throw new Error("intent endpoint 500");
  };
  const failed: unknown[] = [];
  const telemetry: Telemetry = {
    capture: (event, properties) => {
      if (event === "host call failed") failed.push(properties?.call);
    },
    feedback: async () => false,
  };
  const { call, commitAs, synced, replica } = setup({ host, telemetry });

  // The edit lands, so the call says it did: an agent told it failed would make it twice.
  const edit = await call("set_text", { updates: [{ id: "n_plan", text: "Pro" }] });
  expect(edit).toEqual({ text: "Set text on 1 node." });
  expect(locate(replica.doc, "n_plan")?.node.children).toEqual([{ kind: "text", value: "Pro" }]);
  const status = await call("set_status", { status: "pricing tiers", intent: "Add a Pro plan." });
  expect(status).toEqual({ text: "Status: pricing tiers." });

  // A person deletes the board the agent was on. The host is told from inside the replica's
  // own listeners, where a throw would leave as an unhandled rejection.
  await synced();
  commitAs(ada, { op: "artboard.delete", id: "ab_pricing" });
  await synced();
  expect(failed).toEqual(["status", "status", "intent", "status"]);
});

test("a board that went while the agent was away stops showing as worked on, however the news came", async () => {
  // In a whole fetched document, where no op says so.
  const away = setup();
  await away.call("set_status", { status: "pricing tiers", artboards: ["ab_hero", "ab_pricing"] });
  away.commitAs(ada, { op: "artboard.delete", id: "ab_pricing" });
  away.api.forget();
  await away.synced();
  expect(away.host.statuses.at(-1)).toEqual({ artboards: ["ab_hero"], status: "pricing tiers" });

  // With the agent's own edit, when the API takes it back.
  const api = gated();
  const undone = setup({ transport: api.transport });
  undone.commitAs(ada, { op: "page.delete", id: "pg_home" });
  const made = await undone.call("create_artboard", { name: "Sign in", page: "pg_home" });
  const { id } = made.data as { id: string };
  expect(undone.host.statuses.at(-1)).toEqual({ artboards: [id] });
  api.release();
  await undone.synced();
  expect(undone.host.statuses.at(-1)).toEqual({ artboards: [] });
});

/* ------------------------------------------------------------------ */
/* Files in the sandbox                                                */
/* ------------------------------------------------------------------ */

/** A file of each kind add_asset takes, as far in as says what it is. */
const ASSET_HEADS: Record<string, string> = {
  png: "\x89PNG\r\n\x1a\n",
  jpg: "\xff\xd8\xff\xe0",
  jpeg: "\xff\xd8\xff\xe1",
  gif: "GIF89a",
  webp: "RIFF\x24\0\0\0WEBPVP8 ",
  avif: "\0\0\0\x1cftypmif1\0\0\0\0mif1avifmiaf",
  svg: '<?xml version="1.0"?>\n<!-- The logo. -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  woff2: "wOF2\0\x01\0\0",
  woff: "wOFF\0\x01\0\0",
  ttf: "\0\x01\0\0\0\x0c",
  otf: "OTTO\0\x0c",
  mp4: "\0\0\0\x18ftypisom\0\0\x02\0isommp42",
  webm: "\x1a\x45\xdf\xa3",
};

const bytesOf = (head: string) => new Uint8Array(Buffer.from(head, "latin1"));

test("add_asset hands a sandbox file to the host and returns the reference markup uses", async () => {
  const { call, host, replica } = setup();
  const dir = await tempDir();
  const png = bytesOf(`${ASSET_HEADS.png}pixels`);
  await writeFile(join(dir, "Team photo (1).PNG"), png);

  const added = await call("add_asset", { path: join(dir, "Team photo (1).PNG") });
  expect(added.text).toStartWith("Added assets/Team-photo-1-.PNG (1 KB).");
  expect(added.data).toEqual({ ref: "assets/Team-photo-1-.PNG" });
  expect(host.assets.get("assets/Team-photo-1-.PNG")).toEqual({
    name: "Team-photo-1-.PNG",
    bytes: png,
    mime: "image/png",
  });

  const named = await call("add_asset", {
    path: join(dir, "Team photo (1).PNG"),
    name: "team.png",
  });
  expect(named.data).toEqual({ ref: "assets/team.png" });
  await call("write_html", {
    target: "n_card",
    html: `<img src="assets/team.png" alt="The team">`,
  });
  expect(JSON.stringify(replica.doc)).toContain('"src":"assets/team.png"');
});

test("add_asset says plainly what it won't take", async () => {
  const { call, host } = setup();
  const dir = await tempDir();
  await writeFile(join(dir, "notes.txt"), "hello");
  await writeFile(join(dir, "empty.png"), "");
  await writeFile(join(dir, "huge.mp4"), "");
  await truncate(join(dir, "huge.mp4"), MAX_ASSET_BYTES + 1);
  await writeFile(join(dir, "ok.png"), bytesOf(ASSET_HEADS.png!));

  const fails = async (args: unknown) => {
    const r = await call("add_asset", args);
    expect(r.isError).toBe(true);
    return r.text;
  };
  expect(await fails({ path: "logo.png" })).toBe(
    "logo.png is a relative path. Pass an absolute path.",
  );
  expect(await fails({ path: join(dir, "missing.png") })).toBe(
    `There is no file at ${join(dir, "missing.png")}.`,
  );
  expect(await fails({ path: dir, name: "dir.png" })).toBe(`${dir} is not a file.`);
  expect(await fails({ path: join(dir, "notes.txt") })).toContain(
    "notes.txt isn't a kind of file a design can hold. Assets are images, fonts and video: png, jpg,",
  );
  expect(await fails({ path: join(dir, "ok.png"), name: "../ok.png" })).toContain(
    `"../ok.png" can't be an asset's name.`,
  );
  expect(await fails({ path: join(dir, "ok.png"), name: "ok" })).toContain("isn't a kind of file");
  expect(await fails({ path: join(dir, "empty.png") })).toBe(`${join(dir, "empty.png")} is empty.`);
  expect(await fails({ path: join(dir, "huge.mp4") })).toContain(
    "huge.mp4 is more than 20 MB, the most it takes. Make it smaller first",
  );
  expect(host.assets.size).toBe(0);
});

test("add_asset takes each kind of file it names, and only a file that is what its name says", async () => {
  const { call, host } = setup();
  const dir = await tempDir();
  for (const [ext, head] of Object.entries(ASSET_HEADS)) {
    await writeFile(join(dir, `real.${ext}`), bytesOf(head));
    const added = await call("add_asset", { path: join(dir, `real.${ext}`) });
    expect(added.isError, `${ext}: ${added.text}`).toBeFalsy();
    // The same bytes under another kind's name are not that kind.
    const other = ext === "png" ? "gif" : "png";
    const renamed = await call("add_asset", {
      path: join(dir, `real.${ext}`),
      name: `fake.${other}`,
    });
    expect(renamed.isError, `${ext} as ${other}`).toBe(true);
  }
  expect([...host.assets.keys()]).toEqual(Object.keys(ASSET_HEADS).map((e) => `assets/real.${e}`));
  expect(getCloudTool("add_asset")!.description).toContain(Object.keys(ASSET_HEADS).join(", "));

  // Any file in the sandbox, asked for under an image's name.
  await writeFile(join(dir, ".env"), "API_KEY=sk-live-1234");
  const secret = await call("add_asset", { path: join(dir, ".env"), name: "pixel.png" });
  expect(secret.isError).toBe(true);
  expect(secret.text).toBe(
    `${join(dir, ".env")} isn't a PNG image, whatever its name: it doesn't start the way one does. If you downloaded it, look at what came back. If it is another kind of image, font or video, name it with that kind's extension.`,
  );
  // The page a failed download left behind.
  await writeFile(join(dir, "hero.jpg"), "<!doctype html><title>404 Not Found</title>");
  const page = await call("add_asset", { path: join(dir, "hero.jpg") });
  expect(page.text).toStartWith(`${join(dir, "hero.jpg")} isn't a JPEG image`);
  expect(host.assets.size).toBe(Object.keys(ASSET_HEADS).length);
});

test("add_asset takes a file of exactly the size it says is the most", async () => {
  const { call, host } = setup();
  const dir = await tempDir();
  const film = join(dir, "film.mp4");
  await writeFile(film, bytesOf(ASSET_HEADS.mp4!));
  await truncate(film, MAX_ASSET_BYTES);
  const added = await call("add_asset", { path: film });
  expect(added.text).toStartWith("Added assets/film.mp4 (20 MB).");
  expect(host.assets.get("assets/film.mp4")?.bytes.length).toBe(MAX_ASSET_BYTES);
  expect(getCloudTool("add_asset")!.description).toContain("Up to 20 MB.");
});

// A file under /proc says it is empty and isn't, so only the read itself can keep to a limit.
test.skipIf(process.platform !== "linux")(
  "a file is read no further than the limit, whatever size it reports",
  async () => {
    const environ = "/proc/self/environ";
    expect((await readFile(environ)).length).toBeGreaterThan(64);
    await expect(readGiven(localFiles, environ, 64, "Use less.")).rejects.toThrow(
      `${environ} is more than 1 KB, the most it takes. Use less.`,
    );
    expect((await readGiven(localFiles, environ, MAX_ASSET_BYTES, "")).length).toBeGreaterThan(64);
  },
);

test("every path the agent names goes through the host's files, which say what the agent may reach", async () => {
  const asked: string[] = [];
  const files: AgentFiles = {
    async read(path) {
      asked.push(`read ${path}`);
      if (path.endsWith("secret.html")) throw new FileError("denied", "Permission denied");
      if (path.endsWith("gone.png")) throw new FileError("missing", path);
      return new TextEncoder().encode("<p>From the agent's side</p>");
    },
    async write(path) {
      asked.push(`write ${path}`);
      throw new FileError("denied", "Permission denied");
    },
  };
  const { renderer } = fakeRenderer();
  const { call, host } = setup({ files, renderer });

  const denied = await call("create_artboard", { name: "Notes", path: "/work/secret.html" });
  expect(denied.isError).toBe(true);
  expect(denied.text).toBe("You can't read /work/secret.html: Permission denied");
  const read = await call("write_html", { target: "ab_hero", path: "/work/ok.html" });
  expect(read.isError).toBeFalsy();
  expect((await call("get_html", { id: "ab_hero" })).text).toContain("From the agent's side");
  const gone = await call("add_asset", { path: "/work/gone.png" });
  expect(gone.text).toBe("There is no file at /work/gone.png.");
  const exported = await call("export", { id: "ab_hero", path: "/home/user/board.png" });
  expect(exported.text).toBe("You can't write /home/user/board.png: Permission denied");
  expect(host.published).toEqual([]);
  expect(asked).toEqual([
    "read /work/secret.html",
    "read /work/ok.html",
    "read /work/gone.png",
    "write /home/user/board.png",
  ]);
});

test("write_html and create_artboard take a file of HTML by path, cleaned like any other", async () => {
  const { call, replica, synced, api } = setup();
  const dir = await tempDir();
  const rows = Array.from({ length: 400 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join("");
  const table = join(dir, "table.html");
  await writeFile(table, `<table data-name="Ledger">${rows}</table><script>alert(1)</script>`);

  const wrote = await call("write_html", {
    target: "ab_hero",
    path: table,
    mode: "replace-children",
  });
  expect(wrote.isError).toBeFalsy();
  expect(wrote.text).toContain('Wrote 1 element in ab_hero "Hero".');
  expect(wrote.text).toContain("Removed (designs can't run code): <script>.");
  const html = (await call("get_html", { id: "ab_hero" })).text;
  expect(html).toContain("Row 399");
  expect(html).not.toContain("alert");

  const made = await call("create_artboard", { name: "Ledger", path: table });
  const { id } = made.data as { id: string };
  expect(findArtboard(replica.doc, id)?.artboard.root.children).toHaveLength(1);
  await synced();
  expect(JSON.stringify(api.doc)).not.toContain("alert");

  const both = await call("write_html", { target: "ab_hero", html: "<p>x</p>", path: table });
  expect(both.text).toBe("Pass html or path, not both.");
  const neither = await call("write_html", { target: "ab_hero" });
  expect(neither.text).toBe("Pass html, or the path of a file that holds it.");
  const relative = await call("write_html", { target: "ab_hero", path: "table.html" });
  expect(relative.text).toBe("table.html is a relative path. Pass an absolute path.");
  const big = join(dir, "big.html");
  await writeFile(big, "");
  await truncate(big, MAX_OP_BYTES + 1);
  const tooBig = await call("write_html", { target: "ab_hero", path: big });
  expect(tooBig.isError).toBe(true);
  expect(tooBig.text).toContain(
    "big.html is more than 1 MB, the most it takes. Split the HTML into parts",
  );
  // A path that isn't HTML at all: a picture, say.
  const picture = join(dir, "logo.png");
  await writeFile(picture, bytesOf(ASSET_HEADS.png!));
  const notText = await call("write_html", { target: "ab_hero", path: picture });
  expect(notText.text).toBe(`${picture} isn't text. HTML is read as UTF-8.`);
});

test("one call takes what the guide and the tools say it does, by path as in the call", async () => {
  const limits = "about 10,000 elements and pieces of text";
  expect(cloudGuides.basics).toContain(
    `A file doesn't raise what one call takes: ${limits} (a table row of four cells is nine), and 1 MB as stored`,
  );
  for (const name of ["write_html", "create_artboard"]) {
    const schema = jsonSchema(getCloudTool(name)!) as {
      properties: { path: { description: string } };
    };
    expect(schema.properties.path.description).toContain(`${limits}, and 1 MB as stored.`);
  }
  expect(getCloudTool("write_html")!.description).toContain(`${limits}, and 1 MB as stored.`);
  expect([MAX_NODES, MAX_OP_BYTES]).toEqual([10_000, 1024 * 1024]);

  const { call, api, synced } = setup();
  const dir = await tempDir();
  const write = async (name: string, html: string) => {
    await writeFile(join(dir, name), html);
    return call("write_html", { target: "ab_hero", path: join(dir, name) });
  };
  const split =
    " It is too much for one edit, and nothing of it was written: make it as several smaller edits.";

  // Nine to a row, as the guide counts, and the table and its body: 1,110 rows are 9,992.
  const row = "<tr><td>a</td><td>b</td><td>c</td><td>d</td></tr>";
  const table = (rows: number) => `<table><tbody>${row.repeat(rows)}</tbody></table>`;
  expect((await write("fits.html", table(1110))).isError).toBeFalsy();
  const rows = await write("rows.html", table(1111));
  expect(rows.isError).toBe(true);
  expect(rows.text).toEndWith(`holds more nodes than an op may (10000).${split}`);

  // A megabyte as stored, of little but text: about as much again as HTML.
  const text = (paragraphs: number) => `<p>${"x".repeat(10_000)}</p>`.repeat(paragraphs);
  expect((await write("long.html", text(100))).isError).toBeFalsy();
  await synced();
  const stored = JSON.stringify(api.log.at(-1)!.op).length;
  expect(stored).toBeGreaterThan(1_000_000);
  expect(stored).toBeLessThan(MAX_OP_BYTES);
  const longer = await write("longer.html", text(104));
  expect(longer.isError).toBe(true);
  expect(longer.text).toEndWith(`bytes; the most is 1048576.${split}`);

  // One value that is too long is as long in a smaller edit: no advice to split it.
  const url = `data:image/png;base64,${"A".repeat(300_000)}`;
  const inlined = await call("set_attributes", { id: "n_h", attrs: { src: url } });
  expect(inlined.text).toBe(
    "That edit can't be saved: op.attrs.src is longer than 262144 characters.",
  );
  expect(cloudGuides.basics).toContain("a long data URL is refused");
});

test("export writes where the agent says, and links to the copy the host published", async () => {
  const { renderer, calls } = fakeRenderer();
  const { call, host } = setup({ renderer });
  const dir = await tempDir();
  const path = join(dir, "docs", "design", "hero.png");

  const out = await call("export", { id: "ab_hero", path });
  expect(out.text).toBe(
    `Wrote ${path} (800×600 at 2x, 1 KB).\nLink: https://exports.ponzu.test/hero.png`,
  );
  expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3]));
  expect(host.published).toEqual([
    { name: "hero.png", bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
  ]);
  // The render loads the design's assets from where the host keeps them.
  expect(calls[0]).toMatchObject({ format: "png", scale: 2, assetBase: host.assetBase() });

  const relative = await call("export", { id: "ab_hero", path: "hero.png" });
  expect(relative.text).toBe("hero.png is a relative path. Pass an absolute path.");
  expect((await call("export", { id: "ab_hero" })).text).toStartWith(
    "Invalid arguments for export: path:",
  );
  expect(calls).toHaveLength(1);

  // The path's ending says the format.
  await call("export", { id: "ab_hero", path: join(dir, "hero.JPG") });
  await call("export", { id: "ab_hero", path: join(dir, "hero.pdf") });
  await call("export", { id: "ab_hero", path: join(dir, "hero.jpeg"), format: "jpeg" });
  expect(calls.slice(1).map((c) => c.format)).toEqual(["jpeg", "pdf", "jpeg"]);
});

test("export writes a file only under a name that says what it is", async () => {
  const { renderer, calls } = fakeRenderer();
  const { call, host } = setup({ renderer });
  const dir = await tempDir();
  // An existing source file, which a PNG must not replace.
  await writeFile(join(dir, "index.ts"), "export {};\n");
  for (const [name, ending] of [
    ["hero.webp", "ends in .webp"],
    ["hero.svg", "ends in .svg"],
    ["index.ts", "ends in .ts"],
    ["hero", "has no extension"],
  ] as const) {
    const r = await call("export", { id: "ab_hero", path: join(dir, name) });
    expect(r.isError, name).toBe(true);
    expect(r.text).toBe(
      `${join(dir, name)} ${ending}. An export is a PNG, a JPEG or a PDF: end the path in .png, .jpg or .pdf.`,
    );
  }
  const clash = await call("export", { id: "ab_hero", path: join(dir, "hero.pdf"), format: "png" });
  expect(clash.isError).toBe(true);
  expect(clash.text).toBe(
    `format is png, but ${join(dir, "hero.pdf")} ends in .pdf. An export is a PNG, a JPEG or a PDF, and the path's ending says which (.png, .jpg or .pdf): change the path, or leave format out.`,
  );
  // Refused before anything is rendered, written or published.
  expect(calls).toEqual([]);
  expect(host.published).toEqual([]);
  expect(await readFile(join(dir, "index.ts"), "utf8")).toBe("export {};\n");
  for (const name of ["hero.webp", "hero.svg", "hero", "hero.pdf"])
    expect(existsSync(join(dir, name)), name).toBe(false);
});

test("export still writes the file when the host can't publish, or fails to", async () => {
  const { renderer } = fakeRenderer();
  const dir = await tempDir();
  const unpublished = memoryHost();
  delete unpublished.publish;
  const plain = setup({ renderer, host: unpublished });
  const one = join(dir, "one.png");
  expect((await plain.call("export", { id: "ab_hero", path: one })).text).toBe(
    `Wrote ${one} (800×600 at 2x, 1 KB).`,
  );

  const failing = memoryHost();
  failing.publish = async () => {
    throw new Error("storage is full");
  };
  const flaky = setup({ renderer, host: failing });
  const two = join(dir, "two.png");
  const out = await flaky.call("export", { id: "ab_hero", path: two });
  expect(out.isError).toBeFalsy();
  expect(out.text).toBe(
    `Wrote ${two} (800×600 at 2x, 1 KB).\nNo link: it couldn't be published (storage is full).`,
  );
  expect((await readFile(two)).length).toBe(3);
});

test("screenshot renders in the theme and from the assets the host names", async () => {
  const { renderer, calls } = fakeRenderer();
  const { call, host } = setup({ renderer });
  await call("set_tokens", { tokens: { "--paper": "light-dark(#fff, #111)" } });
  host.canvasTheme = "dark";
  const shot = await call("screenshot", { id: "ab_hero" });
  expect(shot.images).toHaveLength(1);
  expect(shot.text).toContain("Shown in dark, the theme the person's canvas is in.");
  expect(calls[0]).toMatchObject({ colorScheme: "dark", assetBase: host.assetBase(), lint: true });
  expect((await call("get_basic_info")).text).toContain("The person's canvas is in dark mode");
});

test("the tools that need a renderer say so when there is none", async () => {
  const { call } = setup();
  for (const [name, args] of [
    ["screenshot", { id: "ab_hero" }],
    ["record", { id: "ab_hero" }],
    ["export", { id: "ab_hero", path: "/tmp/never-written.png" }],
  ] as const) {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `No renderer is available here, so ${name} can't run. Carry on without it, and tell the person the work hasn't been checked on screen.`,
    );
  }
  // Everything else works from declared sizes.
  expect((await call("get_node", { id: "ab_hero" })).isError).toBeFalsy();
});

/* ------------------------------------------------------------------ */
/* The cloud tool set                                                  */
/* ------------------------------------------------------------------ */

const cloudNames = new Set(cloudTools.map((t) => t.name));
const localOnly = localTools.map((t) => t.name).filter((name) => !cloudNames.has(name));

test("the cloud set is the local one without files and waiting, plus what a sandbox needs", () => {
  expect(localOnly.sort()).toEqual([
    "create_file",
    "list_files",
    "update_file",
    "wait_for_activity",
  ]);
  const localNames = new Set(localTools.map((t) => t.name));
  expect([...cloudNames].filter((name) => !localNames.has(name)).sort()).toEqual([
    "add_asset",
    "update_design",
  ]);
  expect(cloudNames.size).toBe(cloudTools.length);
});

test("no cloud tool takes a file argument", () => {
  for (const def of cloudTools) {
    const schema = jsonSchema(def) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}), def.name).not.toContain("file");
  }
});

test("update_design names the design and sets its icon", async () => {
  const { call, synced, api } = setup();
  const named = await call("update_design", { name: "Fern checkout", icon: "cart" });
  expect(named.text).toBe('The design is "Fern checkout", with the cart icon.');
  expect((await call("update_design", { icon: null })).text).toBe('The design is "Fern checkout".');
  expect((await call("update_design", { icon: "sparkles" })).isError).toBe(true);
  expect((await call("get_basic_info")).text).toStartWith("Design: Fern checkout\n");
  await synced();
  expect(api.doc).toMatchObject({ name: "Fern checkout" });
  expect(api.doc.icon).toBeUndefined();
});

test("no cloud tool result names a place inside a .design folder", async () => {
  const { renderer } = fakeRenderer();
  const { call } = setup({ renderer });
  const made = await call("create_artboard", { name: "Sign in" });
  const { id } = made.data as { id: string };
  const results = [
    made,
    await call("get_basic_info"),
    await call("get_tree"),
    await call("get_node", { id }),
    await call("get_node", { id: "n_h" }),
    await call("write_note", { name: "brief", content: "A calmer hero." }),
    await call("read_notes"),
    await call("write_note", { name: "brief", content: null }),
    await call("get_tokens"),
    await call("set_tokens", { tokens: { "--ink": "#111" } }),
    await call("update_page", { page: "pg_home", name: "Start" }),
    await call("rename", { updates: [{ id, name: "Log in" }] }),
    await call("screenshot", { id }),
    await call("delete", { ids: [id] }),
  ];
  for (const r of results) {
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).not.toMatch(DESIGN_PATH);
    expect(r.text).not.toMatch(/\bfile\b|\bPath:/);
  }
  expect(made.text).toBe(
    `Created artboard ${id} "Sign in" 1440px×900px at (1760, 0) on "Home".\nLink: https://ponzu.test/designs/dsn_test?artboard=${id}`,
  );
});

test("every page and board the agent learns of comes with its own link, ready to paste", async () => {
  const { call } = setup();
  const link = (at: string) => `https://ponzu.test/designs/dsn_test?${at}`;
  const made = await call("create_artboard", { name: "Note: Pricing" });
  const { id } = made.data as { id: string };
  expect(made.text).toContain(`\nLink: ${link(`artboard=${id}`)}`);
  const page = await call("create_page", { name: "Mobile" });
  const pageId = /page (pg_\w+)/.exec(page.text)![1]!;
  expect(page.text).toBe(`Created page ${pageId} "Mobile".\nLink: ${link(`page=${pageId}`)}`);
  const copy = await call("duplicate", { ids: [id], names: ["Note: Pricing / B"] });
  const copyId = (copy.data as { ids: string[] }).ids[0]!;
  expect(copy.text).toContain(`"Note: Pricing / B" at `);
  expect(copy.text).toContain(` · link: ${link(`artboard=${copyId}`)}`);
  // The summary lists each beside its id, and says what the design's own Link is for.
  const info = (await call("get_basic_info")).text;
  for (const line of [
    `Page pg_home "Home" · link: ${link("page=pg_home")}`,
    `${id} "Note: Pricing" 1440px×900px at (1760, 0) · link: ${link(`artboard=${id}`)}`,
    `Page ${pageId} "Mobile" (empty) · link: ${link(`page=${pageId}`)}`,
  ])
    expect(info).toContain(line);
  expect(info).toContain("Link: https://ponzu.test/designs/dsn_test (opens this design in Ponzu");
  expect((await call("get_tree")).text).toContain(` · link: ${link(`artboard=${id}`)}`);
  expect((await call("get_tree", { id })).text).toStartWith(
    `${id} "Note: Pricing" 1440px×900px at (1760, 0) · page "Home" · link: ${link(`artboard=${id}`)}\n`,
  );
});

/* ------------------------------------------------------------------ */
/* What the agent is told                                              */
/* ------------------------------------------------------------------ */

/** A place inside a .design folder, or the folder itself. `assets/…` is how markup names an asset. */
const DESIGN_PATH =
  /\.design\b|design\.json|comments\.json|tokens\.css|\b(?:pages|notes|exports)\/|\.ponzu\b/;
/** Ways of telling an agent to say which design: there is one. */
const FILE_ARGUMENT = /`file`|\bfile argument\b|\b(?:pass|passing|without|omit) file\b|\bfile=/i;
/** The local world: a Mac app that pairs with agents, which watch the canvas in a loop. */
const LOCAL_WORLD = /\bMac app\b|\bpair(?:ing|ed)\b|\bwatch(?:ing)? the canvas\b|\bwatch loop\b/i;

/** Everything a cloud agent reads that isn't a tool result, by where it is. */
function told(): [string, string][] {
  const texts: [string, string][] = [["CLOUD_INSTRUCTIONS", CLOUD_INSTRUCTIONS]];
  for (const [topic, text] of Object.entries(cloudGuides)) texts.push([`guide ${topic}`, text]);
  for (const def of cloudTools) {
    texts.push([`${def.name} description`, def.description]);
    // Argument descriptions, enums and all.
    texts.push([`${def.name} schema`, JSON.stringify(jsonSchema(def))]);
  }
  return texts;
}

test("nothing a cloud agent is told names a tool, an argument or a place the cloud doesn't have", () => {
  const topics = new Set(Object.keys(cloudGuides));
  for (const [where, text] of told()) {
    for (const name of localOnly) expect(text, where).not.toContain(name);
    expect(text, where).not.toMatch(DESIGN_PATH);
    expect(text, where).not.toMatch(FILE_ARGUMENT);
    for (const [, topic] of text.matchAll(/get_guide\('([^']*)'\)/g))
      expect(topics.has(topic!), `${where}: get_guide('${topic}')`).toBe(true);
    if (where.endsWith(" schema")) continue;
    // Whatever is written like a tool's name is a tool the agent has. (n_a and ab_x are ids.)
    const named = new Set(text.match(/\b(?!(?:n|ab|pg|th)_)[a-z]+(?:_[a-z]+)+\b/g));
    for (const name of named) expect(cloudNames.has(name), `${where}: ${name}`).toBe(true);
  }
});

test("the guides written for the cloud leave the local world out", () => {
  for (const [where, text] of told()) {
    if (where.endsWith(" schema")) continue;
    expect(text, where).not.toMatch(LOCAL_WORLD);
  }
  expect(cloudGuides.comments).toContain("reaches you as a new turn");
  expect(CLOUD_INSTRUCTIONS).toContain("reach you as new turns");
  expect(cloudGuides.code).toContain("rebuild it on the canvas faithfully before you change");
  expect(CLOUD_INSTRUCTIONS).toContain(
    "rebuild it on the canvas faithfully from the running dev server",
  );
});

test("the basics guide describes add_asset, big HTML and undone edits as the tools behave", async () => {
  expect(cloudGuides.basics).toContain("pass that file's absolute path as path instead of html");
  expect(cloudGuides.basics).toContain(
    "add_asset takes the absolute path of a file in the sandbox",
  );
  // The heading the guide tells the agent to look for is the one a notice has.
  expect(cloudGuides.basics).toContain('a note that starts "Undone:"');
  const api = gated();
  const { call, commitAs, synced, ws } = setup({ transport: api.transport });
  commitAs(ada, { op: "artboard.delete", id: "ab_hero" });
  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  api.release();
  await synced();
  expect(ws.notices?.()[0]).toStartWith("Undone:");
});

test("get_guide serves the cloud's guides", async () => {
  const { call } = setup();
  expect((await call("get_guide", { topic: "comments" })).text).toBe(cloudGuides.comments);
  expect((await call("get_guide", { topic: "watch" })).isError).toBe(true);
  expect((await call("get_guide", { topic: "format" })).isError).toBe(true);
  const about = getCloudTool("get_guide")!.description;
  for (const topic of Object.keys(cloudGuides)) expect(about).toContain(topic);
});
