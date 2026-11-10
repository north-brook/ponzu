import { afterEach, expect, test } from "bun:test";
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
  MAX_OP_BYTES,
  parseHtml,
  type SyncTransport,
  type Thread,
} from "@ponzu/core";
import type { Sequencer } from "@ponzu/core/testing";
import type { Renderer, RenderRequest } from "@ponzu/render";
import { jsonSchema, runTool } from "../define.ts";
import { tools as localTools } from "../local/tools.ts";
import { CLOUD_INSTRUCTIONS, cloudGuides } from "./guides.ts";
import { AGENT, type MemoryCloud, memoryCloud, memoryHost, memoryTransport } from "./testing.ts";
import { cloudTools, getCloudTool, MAX_ASSET_BYTES } from "./tools.ts";

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

function setup(opts: Parameters<typeof memoryCloud>[1] = {}) {
  const cloud = memoryCloud(fern(), opts);
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

/* ------------------------------------------------------------------ */
/* Files in the sandbox                                                */
/* ------------------------------------------------------------------ */

test("add_asset hands a sandbox file to the host and returns the reference markup uses", async () => {
  const { call, host, replica } = setup();
  const dir = await tempDir();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
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
  await writeFile(join(dir, "ok.png"), "png");

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
    "huge.mp4 is 20 MB; the most is 20 MB. Make it smaller first",
  );
  expect(host.assets.size).toBe(0);
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
  expect(tooBig.text).toContain("big.html is 1 MB; the most is 1 MB. Split the HTML into parts");
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

  // The extension says the format, unless the call does.
  await call("export", { id: "ab_hero", path: join(dir, "hero.JPG") });
  await call("export", { id: "ab_hero", path: join(dir, "hero.pdf"), format: "png" });
  expect(calls.slice(1).map((c) => c.format)).toEqual(["jpeg", "png"]);
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
  expect(made.text).toBe(`Created artboard ${id} "Sign in" 1440px×900px at (1760, 0) on "Home".`);
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
  // The limit the guide quotes is the one write_html enforces.
  expect(cloudGuides.basics).toContain("One call takes a file of up to 1 MB.");
  expect(MAX_OP_BYTES).toBe(1024 * 1024);
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
