import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locate, threadPage } from "@ponzu/core";
import type { Renderer, RenderResult } from "@ponzu/render";
import { Design, MemoryAdapter } from "@ponzu/store";
import { EventHub, PresenceHub, type ToolContext, type Workspace, within } from "./context.ts";
import { FORMAT_EXAMPLE, GUIDES } from "./guides.ts";
import { getTool, runTool } from "./index.ts";
import { plural } from "./util.ts";

async function setup(tokens = 3, renderer?: Renderer) {
  const css = `:root {\n${Array.from({ length: tokens }, (_, i) => `  --t${i}: ${i}px;`).join("\n")}\n}\n`;
  return withFiles(
    {
      "design.json": JSON.stringify({
        ponzu: 1,
        name: "Fern",
        pages: [{ id: "pg_home", name: "Home" }],
      }),
      "tokens.css": css,
      "pages/home/hero.html": `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px">\n<div data-id="n_card"><h1 data-id="n_h">Hi</h1><p data-id="n_p">There</p></div>\n</section>\n`,
    },
    renderer,
  );
}

async function withFiles(files: Record<string, string>, renderer?: Renderer) {
  const design = await Design.open(new MemoryAdapter(files), { saveDelay: 0 });
  const ws: Workspace = {
    designs: () => [{ key: "fern", design }],
    resolve: async () => ({ key: "fern", design }),
    events: new EventHub(),
    presence: new PresenceHub(),
    renderer,
  };
  const ctx: ToolContext = { ws, caller: { id: "t", author: { kind: "agent", name: "test" } } };
  const call = (name: string, args: unknown) => runTool(getTool(name)!, args, ctx);
  return { design, call, ws };
}

test("plural adds -es after sibilants", () => {
  expect(plural(1, "match")).toBe("1 match");
  expect(plural(2, "match")).toBe("2 matches");
  expect(plural(0, "box")).toBe("0 boxes");
  expect(plural(3, "node")).toBe("3 nodes");
});

test("find_nodes counts matches", async () => {
  const { call } = await setup();
  const r = await call("find_nodes", { tag: "h1" });
  expect(r.text).toStartWith("1 match:");
  expect((await call("find_nodes", { within: "n_card" })).text).toMatch(/^\d+ matches/);
});

test("get_basic_info gives the link that opens the design in Ponzu, when there is one", async () => {
  const { call, ws } = await setup();
  expect((await call("get_basic_info", {})).text).not.toContain("Link:");
  ws.link = (key) => `https://ponzu.design/local#file=/d/${key}.design`;
  const text = (await call("get_basic_info", {})).text;
  expect(text).toContain(
    "Link: https://ponzu.design/local#file=/d/fern.design (give the person this",
  );
  expect(text).toContain("&artboard=<id>");
});

test("get_basic_info says how many tokens it left out and where to see them", async () => {
  const { call } = await setup(57);
  const r = await call("get_basic_info", {});
  expect(r.text).toContain("Tokens (57,");
  expect(r.text).toContain("… 17 more (get_tokens lists them all)");
  expect((await call("get_basic_info", {})).text).not.toContain("--t40:");
  const small = await setup(3);
  expect((await small.call("get_basic_info", {})).text).not.toContain("more (get_tokens");
});

test("duplicate returns the new top-level ids, not every descendant", async () => {
  const { call } = await setup();
  const r = await call("duplicate", { ids: ["n_card"] });
  const lines = r.text.split("\n");
  expect(lines[0]).toMatch(/^n_card → n_\w+$/);
  expect(lines[1]).toBe("3 nodes copied in all; get_tree on a copy lists their ids.");
  expect(lines).toHaveLength(2);
  expect(r.text).not.toContain("n_h→");
  const data = r.data as { ids: string[]; map: Record<string, string> };
  expect(data.ids).toEqual([data.map.n_card!]);
  expect(Object.keys(data.map)).toEqual(["n_card", "n_h", "n_p"]);
});

test("duplicated artboards land right of the row by default", async () => {
  const { design, call } = await setup();
  const r = await call("duplicate", { ids: ["ab_hero"] });
  expect(r.text).toContain('"Hero copy" at (880, 0)');
  expect(design.doc.pages[0]!.artboards).toHaveLength(2);
});

test("duplicate places artboard copies at x/y, lined up left to right", async () => {
  const { design, call } = await setup();
  const r = await call("duplicate", {
    ids: ["ab_hero", "ab_hero"],
    names: ["Hero / A", "Hero / B"],
    x: 0,
    y: 1000,
  });
  expect(r.text).toContain('"Hero / A" at (0, 1000)');
  expect(r.text).toContain('"Hero / B" at (880, 1000)');
  const [, a, b] = design.doc.pages[0]!.artboards;
  expect([a!.x, a!.y, b!.x, b!.y]).toEqual([0, 1000, 880, 1000]);
});

test("duplicate with only y starts a new row in a free spot", async () => {
  const { call } = await setup();
  const r = await call("duplicate", { ids: ["ab_hero"], y: 2000 });
  expect(r.text).toContain("at (880, 2000)");
});

/** A phone screen with three stacked sections, and a frame to copy them into. */
async function phone() {
  const s = await setup();
  await s.call("write_html", {
    target: "ab_hero",
    mode: "replace-children",
    html: `<div data-id="n_screen"><div data-id="n_status" data-name="Status bar"></div><div data-id="n_content" data-name="Content"></div><div data-id="n_tabs" data-name="Tab bar"></div></div><div data-id="n_frame"><span data-id="n_old">old</span></div>`,
  });
  const names = (id: string) => {
    const hit = locate(s.design.doc, id)!;
    return hit.node.children.map((c) => (c.kind === "el" ? (c.name ?? c.id) : "#text"));
  };
  return { ...s, names };
}

test("duplicate into a parent keeps the sources' document order", async () => {
  const { call, names } = await phone();
  const r = await call("duplicate", {
    ids: ["n_status", "n_content", "n_tabs"],
    parent: "n_frame",
  });
  expect(names("n_frame")).toEqual(["n_old", "Status bar", "Content", "Tab bar"]);
  expect((r.data as { ids: string[] }).ids).toHaveLength(3);

  // Listed out of order, the copies still follow the document; names follow the ids.
  const again = await phone();
  const r2 = await again.call("duplicate", {
    ids: ["n_tabs", "n_status", "n_content"],
    names: ["Tabs 2", "Status 2", "Content 2"],
    parent: "n_frame",
  });
  expect(again.names("n_frame")).toEqual(["n_old", "Status 2", "Content 2", "Tabs 2"]);
  expect(r2.text.split("\n")[0]).toStartWith("n_tabs → ");
});

test("duplicating siblings puts each copy right after its original", async () => {
  const { call, names } = await phone();
  await call("duplicate", {
    ids: ["n_status", "n_content", "n_tabs"],
    names: ["Status 2", "Content 2", "Tabs 2"],
  });
  expect(names("n_screen")).toEqual([
    "Status bar",
    "Status 2",
    "Content",
    "Content 2",
    "Tab bar",
    "Tabs 2",
  ]);
});

test("duplicating several artboards keeps their order", async () => {
  const { design, call } = await setup();
  await call("duplicate", { ids: ["ab_hero"], names: ["Second"] });
  const second = design.doc.pages[0]!.artboards[1]!.id;
  const r = await call("duplicate", { ids: ["ab_hero", second], names: ["Hero 2", "Second 2"] });
  const boards = design.doc.pages[0]!.artboards;
  expect(boards.map((a) => a.name)).toEqual(["Hero", "Second", "Hero 2", "Second 2"]);
  expect(boards[3]!.x).toBeGreaterThan(boards[2]!.x);
  expect((r.data as { ids: string[] }).ids).toEqual([boards[2]!.id, boards[3]!.id]);

  // Listed out of order, the copies still follow the page.
  await call("duplicate", { ids: [second, "ab_hero"], names: ["Second 3", "Hero 3"] });
  expect(design.doc.pages[0]!.artboards.map((a) => a.name).slice(4)).toEqual([
    "Hero 3",
    "Second 3",
  ]);
});

test("moving several nodes to one spot keeps the order they were given", async () => {
  const anchors = [
    { after: "n_old" },
    { parent: "n_frame", index: 0 },
    { parent: "n_frame", index: 1 },
    { parent: "n_frame" },
    { before: "n_old" },
  ];
  for (const anchor of anchors) {
    const { call, names } = await phone();
    await call("move_nodes", {
      moves: ["n_status", "n_content", "n_tabs"].map((id) => ({ id, ...anchor })),
    });
    expect(names("n_frame").filter((n) => n !== "n_old")).toEqual([
      "Status bar",
      "Content",
      "Tab bar",
    ]);
    expect(names("n_screen")).toEqual([]);
  }

  // Within their own parent.
  const { call, names } = await phone();
  await call("move_nodes", {
    moves: [
      { id: "n_content", after: "n_tabs" },
      { id: "n_status", after: "n_tabs" },
    ],
  });
  expect(names("n_screen")).toEqual(["Tab bar", "Content", "Status bar"]);

  // A node that moves on stops anchoring its old spot.
  const later = await phone();
  await later.call("move_nodes", {
    moves: [
      { id: "n_status", after: "n_old" },
      { id: "n_status", parent: "n_screen", index: 0 },
      { id: "n_content", after: "n_old" },
    ],
  });
  expect(later.names("n_frame")).toEqual(["n_old", "Content"]);
  expect(later.names("n_screen")).toEqual(["Status bar", "Tab bar"]);

  // When the end of a run moves on, the next move joins what's left of it.
  const tail = await phone();
  await tail.call("move_nodes", {
    moves: [
      { id: "n_status", after: "n_old" },
      { id: "n_content", after: "n_old" },
      { id: "n_content", parent: "n_screen" },
      { id: "n_tabs", after: "n_old" },
    ],
  });
  expect(tail.names("n_frame")).toEqual(["n_old", "Status bar", "Tab bar"]);
  expect(tail.names("n_screen")).toEqual(["Content"]);

  // When the anchor itself moves, later moves follow it, not the old run.
  const anchor = await phone();
  await anchor.call("move_nodes", {
    moves: [
      { id: "n_status", after: "n_old" },
      { id: "n_old", parent: "n_screen", index: 0 },
      { id: "n_tabs", after: "n_old" },
    ],
  });
  expect(anchor.names("n_screen")).toEqual(["n_old", "Tab bar", "Content"]);
  expect(anchor.names("n_frame")).toEqual(["Status bar"]);

  // Another move landing inside a run doesn't break it.
  const mixed = await phone();
  await mixed.call("move_nodes", {
    moves: [
      { id: "n_status", after: "n_old" },
      { id: "n_content", before: "n_status" },
      { id: "n_tabs", after: "n_old" },
    ],
  });
  expect(mixed.names("n_frame")).toEqual(["n_old", "Content", "Status bar", "Tab bar"]);

  // A member sent on to another spot leaves the run, even if it lands nearby.
  const away = await phone();
  await away.call("move_nodes", {
    moves: [
      { id: "n_tabs", parent: "n_frame" },
      { id: "n_status", after: "n_old" },
      { id: "n_status", after: "n_tabs" },
      { id: "n_content", after: "n_old" },
    ],
  });
  expect(away.names("n_frame")).toEqual(["n_old", "Content", "Tab bar", "Status bar"]);
});

test("update_file renames the file and sets or clears its icon", async () => {
  const { design, call } = await setup();
  await call("update_file", { name: "Fern app", icon: "phone" });
  expect(design.doc).toMatchObject({ name: "Fern app", icon: "phone" });
  await call("update_file", { icon: null });
  expect(design.doc.icon).toBeUndefined();
  expect(design.doc.name).toBe("Fern app");
});

/** A renderer that answers every render with `out`, and counts its calls. */
function fakeRenderer(out: Partial<RenderResult>) {
  const calls: unknown[] = [];
  const renderer = {
    render: async (req: unknown) => {
      calls.push(req);
      return {
        bytes: new Uint8Array([1]),
        mime: "image/png",
        width: 800,
        height: 600,
        contentHeight: 600,
        issues: [],
        ...out,
      } as RenderResult;
    },
    close: async () => {},
  } as Renderer;
  return { renderer, calls };
}

test("screenshot returns lint when only the image failed", async () => {
  const { renderer } = fakeRenderer({
    bytes: new Uint8Array(),
    issues: [{ id: "n_h", kind: "clipped-text", message: "text is clipped" }],
    captureError: "The render stalled capturing the image (stopped after 20s).",
  });
  const { call } = await setup(3, renderer);
  const r = await call("screenshot", { id: "ab_hero" });
  expect(r.isError).toBe(true);
  expect(r.images).toBeUndefined();
  expect(r.text).toContain("Couldn't capture the image of ab_hero");
  expect(r.text).toContain("n_h: text is clipped");
  expect("failure" in r).toBe(false);
});

test("screenshot says when fonts or images ran out of time", async () => {
  const { renderer } = fakeRenderer({ assetsTimedOut: true });
  const { call } = await setup(3, renderer);
  const r = await call("screenshot", { id: "ab_hero" });
  expect(r.isError).toBeFalsy();
  expect(r.text).toContain("still loading when time ran out");
});

test("screenshot checks hover, focus and press ids before rendering", async () => {
  const { renderer, calls } = fakeRenderer({});
  const { call } = await setup(3, renderer);
  const r = await call("screenshot", { id: "ab_hero", hover: "n_nope" });
  expect(r.isError).toBe(true);
  expect(r.text).toBe("No node n_nope to hover in ab_hero. Ids come from get_tree.");
  expect(calls).toHaveLength(0);
  expect((await call("screenshot", { id: "ab_hero", press: "n_p" })).isError).toBeFalsy();
});

test("renders default to the person's theme and say so when the design has one", async () => {
  const { renderer, calls } = fakeRenderer({});
  const { call, ws, design } = await setup(3, renderer);
  const scheme = () => (calls.at(-1) as { colorScheme?: string }).colorScheme;

  // Tokens that don't change with the theme look the same on either canvas: light, and nothing to say.
  ws.theme = "dark";
  const plain = await call("screenshot", { id: "ab_hero" });
  expect(scheme()).toBeUndefined();
  expect(plain.text).not.toContain("Shown in");
  expect((await call("get_basic_info", {})).text).toContain(
    "These tokens don't change with the theme",
  );

  // A theme in the markup counts as much as one in the tokens.
  await call("update_styles", {
    updates: [{ ids: ["n_h"], style: { color: "light-dark(#111, #eee)" } }],
  });
  expect((await call("get_basic_info", {})).text).toContain("canvas is in dark mode, so they see");
  await call("update_styles", { updates: [{ ids: ["n_h"], style: { color: null } }] });

  await call("set_tokens", { tokens: { "--paper": "light-dark(#fff, #111)" } });
  const shot = await call("screenshot", { id: "ab_hero" });
  expect(scheme()).toBe("dark");
  expect(shot.text).toContain("Shown in dark, the theme the person's canvas is in.");
  expect(shot.text).toContain('pass colorScheme: "light" to see it');
  expect((await call("get_basic_info", {})).text).toContain(
    "The person's canvas is in dark mode, so they see this design's light-dark() colors in dark.",
  );
  await call("screenshot", { id: "ab_hero", colorScheme: "light" });
  expect(scheme()).toBe("light");

  // Without a canvas open, light, as before.
  ws.theme = undefined;
  const none = await call("screenshot", { id: "ab_hero" });
  expect(scheme()).toBe("light");
  expect(none.text).toContain("Shown in light.");
  expect((await call("get_basic_info", {})).text).not.toContain("canvas is in");

  // Export takes a theme too, and names the file after it.
  const dir = await mkdtemp(join(tmpdir(), "ponzu-export-"));
  try {
    const out = await call("export", {
      id: "ab_hero",
      colorScheme: "dark",
      path: join(dir, "hero.png"),
    });
    expect(scheme()).toBe("dark");
    expect(out.text).toContain(", dark,");
    (design.storage as { root?: string }).root = dir;
    ws.theme = "dark";
    expect((await call("export", { id: "ab_hero" })).text).toContain(
      `${dir}/exports/hero-dark.png`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agents learn that the person's canvas plays a load animation once", () => {
  // The canvas never replays a finite load on hover, so agents mustn't promise it.
  expect(GUIDES.motion).toContain("plays once when the artboard appears");
  expect(GUIDES.motion).toContain("doesn't replay it");
  expect(GUIDES.motion).toContain("looping copy");
  expect(getTool("record")!.description).toContain("plays the load once");
});

test("the format guide's example files load as it describes", async () => {
  for (const text of Object.values(FORMAT_EXAMPLE)) expect(GUIDES.format).toContain(text);
  const { design, call } = await withFiles(FORMAT_EXAMPLE);
  const { doc } = design;
  expect(design.problems).toEqual([]);
  expect(doc.pages.map((p) => [p.id, p.name, p.icon])).toEqual([["pg_flow", "Flow", "flow"]]);
  const cart = doc.pages[0]!.artboards[0]!;
  expect([cart.id, cart.name, cart.x, cart.y]).toEqual(["ab_cart", "Cart", 0, 0]);
  expect(cart.root.style).toMatchObject({ width: "390px", height: "844px" });
  const [pinned, canvas] = doc.threads;
  expect(locate(doc, pinned!.nodeId!)?.artboard.id).toBe("ab_cart");
  expect(canvas!.artboardId).toBeUndefined();
  expect(threadPage(doc, canvas!)?.id).toBe("pg_flow");
  const listed = (await call("list_comments", {})).text;
  expect(listed).toContain('th_title [open] on "Cart" › ');
  expect(listed).toContain('th_next [open] on the canvas of page "Flow" at 480, 120');
  expect((await call("get_basic_info", {})).text).toContain('Page pg_flow "Flow" · pages/flow/');
});

test("update_page renames a page's folder, and get_basic_info shows where it went", async () => {
  const { design, call } = await withFiles({
    "design.json": JSON.stringify({
      ponzu: 1,
      name: "Fern",
      pages: [
        { id: "pg_old", name: "Home" },
        { id: "pg_new", name: "Home v2" },
      ],
    }),
    "tokens.css": ":root {\n}\n",
    "pages/home-v2/hero.html": `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px"></section>\n`,
  });
  await call("update_page", { page: "pg_old", delete: true });
  await call("update_page", { page: "pg_new", name: "Home" });
  await design.flush();
  expect((await call("get_basic_info", {})).text).toContain('Page pg_new "Home" · pages/home/');
  const files = (design.storage as MemoryAdapter).files;
  expect(Object.keys(files).filter((p) => p.startsWith("pages/"))).toEqual([
    "pages/home/hero.html",
  ]);
  const again = await Design.open(new MemoryAdapter({ ...files }), { watch: false });
  expect(again.doc.pages.map((p) => [p.id, p.artboards.map((a) => a.id)])).toEqual([
    ["pg_new", ["ab_hero"]],
  ]);
});

test("get_basic_info lists what in the files Ponzu couldn't use", async () => {
  const { call } = await withFiles({
    ...FORMAT_EXAMPLE,
    "comments.json": JSON.stringify({ threads: [{ id: "th_x", pageId: "pg_flow", x: 1, y: 1 }] }),
  });
  const text = (await call("get_basic_info", {})).text;
  expect(text).toContain("Not used as written");
  expect(text).toContain("comments.json: thread th_x not shown, needs status");
  const clean = await setup();
  expect((await clean.call("get_basic_info", {})).text).not.toContain("Not used as written");
});

test("an artboard given display: flex with no direction says it stays a column", async () => {
  const { call } = await setup();
  const flexed = await call("update_styles", {
    updates: [{ ids: ["ab_hero"], style: { display: "flex" } }],
  });
  expect(flexed.text).toContain("Note: ab_hero sets display: flex with no flex-direction");
  const tree = await call("get_tree", { id: "ab_hero" });
  expect(tree.text).toContain('<section> ab_hero "Hero" [flex column');

  const row = await call("update_styles", {
    updates: [{ ids: ["ab_hero"], style: { flexDirection: "row" } }],
  });
  expect(row.text).not.toContain("flex-direction");
  expect((await call("get_tree", { id: "ab_hero" })).text).toContain("[flex row");

  // A node inside an artboard is plain CSS: display: flex is a row there.
  const card = await call("update_styles", {
    updates: [{ ids: ["n_card"], style: { display: "flex" } }],
  });
  expect(card.text).not.toContain("Note:");
  expect((await call("get_tree", { id: "ab_hero" })).text).toContain("n_card [flex row]");

  const created = await call("create_artboard", { name: "App", style: { display: "flex" } });
  expect(created.text).toMatch(/Note: ab_\w+ sets display: flex with no flex-direction/);
  const plain = await call("create_artboard", { name: "Page" });
  expect(plain.text).not.toContain("Note:");
});

test("an agent shows as working on what it changes until it goes quiet", async () => {
  const { call, ws } = await setup();
  ws.presence = new PresenceHub(100);
  const me = () => ws.presence.list().find((p) => p.id === "t")!;

  await call("get_tree", {});
  expect(me().working).toEqual([]);

  await call("set_text", { updates: [{ id: "n_h", text: "Hello" }] });
  expect(me()).toMatchObject({ working: ["ab_hero"], file: "fern" });
  const created = await call("create_artboard", { name: "Card" });
  const card = /ab_\w+/.exec(created.text)![0];
  expect(me().working).toEqual(["ab_hero", card]);

  await call("set_status", { status: "tightening the hero" });
  expect(me()).toMatchObject({ working: ["ab_hero", card], status: "tightening the hero" });
  await call("set_status", { status: "just the card", artboards: [card] });
  expect(me().working).toEqual([card]);

  // Deleting the artboard drops it rather than claiming it.
  await call("delete", { ids: [card] });
  expect(me().working).toEqual([]);
  expect(me().status).toBe("just the card");

  // A read keeps it going; a minute of nothing (100ms here) clears it.
  await call("set_text", { updates: [{ id: "n_h", text: "Hi" }] });
  await Bun.sleep(60);
  await call("get_tree", {});
  await Bun.sleep(60);
  expect(me().working).toEqual(["ab_hero"]);
  await Bun.sleep(80);
  expect(me()).toMatchObject({ working: [] });
  expect(me().status).toBeUndefined();
});

test("waiting for activity ends a pass", async () => {
  const { call, ws } = await setup();
  const me = () => ws.presence.list().find((p) => p.id === "t")!;
  await call("set_status", { status: "making it blue", artboards: ["ab_hero"] });
  expect(me().working).toEqual(["ab_hero"]);
  await call("wait_for_activity", { timeout: 0 });
  expect(me().working).toEqual([]);
  expect(me().status).toBeUndefined();
});

test("an agent that writes the files itself shows as working on them", async () => {
  const { call, ws } = await setup();
  const me = () => ws.presence.list().find((p) => p.id === "t")!;
  // A read is enough to place it in the design.
  await call("get_tree", {});
  ws.presence.wroteOnDisk("fern", { artboards: ["ab_hero"], gone: [] });
  expect(me()).toMatchObject({ working: ["ab_hero"], file: "fern" });
  ws.presence.wroteOnDisk("fern", { artboards: [], gone: ["ab_hero"] });
  expect(me().working).toEqual([]);

  // In another design, or waiting for the person's edits: not its doing.
  ws.presence.wroteOnDisk("other", { artboards: ["ab_x"], gone: [] });
  expect(me().working).toEqual([]);
  await call("wait_for_activity", { timeout: 0.05 });
  const waiting = call("wait_for_activity", { timeout: 0.2 });
  await Bun.sleep(20);
  ws.presence.wroteOnDisk("fern", { artboards: ["ab_hero"], gone: [] });
  expect(me().working).toEqual([]);
  await waiting;
});

test("an edit on disk counts for the agent working in that project", () => {
  const presence = new PresenceHub();
  const caller = {
    id: "a",
    author: { kind: "agent" as const, name: "Claude" },
    origin: { cwd: "/code/shop" },
  };
  presence.touch(caller);
  presence.wroteOnDisk("/code/shop/design/app.design", { artboards: ["ab_1"], gone: [] });
  expect(presence.list()[0]).toMatchObject({
    working: ["ab_1"],
    file: "/code/shop/design/app.design",
  });
  // A sibling folder that merely shares the prefix isn't its project.
  presence.wroteOnDisk("/code/shopfront/x.design", { artboards: ["ab_2"], gone: [] });
  expect(presence.list()[0]!.working).toEqual(["ab_1"]);
});

test("a project folder holds what's under it, however it's spelled", () => {
  expect(within("/code/shop/app.design", "/code/shop")).toBe(true);
  expect(within("/code/shop/app.design", "/code/shop/")).toBe(true);
  expect(within("/code/app.design", "/")).toBe(true);
  expect(within("C:\\code\\shop\\app.design", "C:\\code\\shop")).toBe(true);
  expect(within("/code/shopfront/app.design", "/code/shop")).toBe(false);
});

test("deleting an artboard takes it from another agent working on it", async () => {
  const { call, ws } = await setup();
  const other: ToolContext = { ws, caller: { id: "o", author: { kind: "agent", name: "other" } } };
  const them = () => ws.presence.list().find((p) => p.id === "o")!;
  await runTool(getTool("set_text")!, { updates: [{ id: "n_h", text: "Mine" }] }, other);
  expect(them().working).toEqual(["ab_hero"]);
  await call("delete", { ids: ["ab_hero"] });
  expect(them().working).toEqual([]);
});

/** Two artboards on one page, the second at (x, y) with the given style. */
async function twoBoards(x: number, y: number, style: string) {
  return withFiles({
    "design.json": JSON.stringify({
      ponzu: 1,
      name: "Fern",
      pages: [{ id: "pg_home", name: "Home" }],
    }),
    "tokens.css": ":root {}\n",
    "pages/home/a.html": `<section data-artboard data-id="ab_a" data-name="A" data-x="0" data-y="0" style="width:800px;height:600px">\n<p>a</p>\n</section>\n`,
    "pages/home/b.html": `<section data-artboard data-id="ab_b" data-name="B" data-x="${x}" data-y="${y}" style="${style}">\n<p>b</p>\n</section>\n`,
  });
}

test("get_basic_info lists artboards that overlap, and where the lower one clears", async () => {
  const { call } = await twoBoards(400, 500, "width:800px;height:600px");
  const r = await call("get_basic_info", {});
  expect(r.text).toContain(
    'ab_a "A" and ab_b "B" overlap by 400×100px; ab_b clears it at y 680 (update_artboard).',
  );
  const apart = await twoBoards(880, 0, "width:800px;height:600px");
  expect((await apart.call("get_basic_info", {})).text).not.toContain("overlap");
});

test("moving an artboard onto another says so, and moving it off clears it", async () => {
  const { call } = await twoBoards(880, 0, "width:800px;height:600px");
  const onto = await call("update_artboard", { id: "ab_b", x: 700, y: 300 });
  expect(onto.text).toContain("Overlap: ab_a");
  expect(onto.text).toContain("ab_b clears it at y 680");
  const off = await call("update_artboard", { id: "ab_b", x: 700, y: 680 });
  expect(off.text).not.toContain("Overlap");
});

test("create_artboard at an explicit spot on top of another reports the overlap", async () => {
  const { call } = await setup();
  const r = await call("create_artboard", {
    name: "Over",
    width: 400,
    height: 400,
    x: 100,
    y: 100,
  });
  expect(r.text).toContain('Overlap: ab_hero "Hero" and');
  const free = await call("create_artboard", { name: "Free", width: 400, height: 400 });
  expect(free.text).not.toContain("Overlap");
});

test("a fit-content artboard is checked at its rendered height", async () => {
  const s = await twoBoards(0, 700, "width:800px;height:fit-content");
  // Without a renderer it reads as 900 tall and starts below A: clear.
  expect((await s.call("get_basic_info", {})).text).not.toContain("overlap");
  const measured: string[] = [];
  const tall = await twoBoards(0, -1400, "width:800px;height:fit-content");
  tall.ws.renderer = {
    render: async () => {
      throw new Error("unused");
    },
    measure: async (req) => {
      measured.push(req.artboard.id);
      return {
        boxes: { [req.artboard.id]: { x: 0, y: 0, width: 800, height: 1500 } },
        contentHeight: 1500,
      };
    },
    close: async () => {},
  };
  const r = await tall.call("get_basic_info", {});
  expect(r.text).toContain('ab_b "B" and ab_a "A" overlap by 800×100px; ab_a clears it at y 180');
  expect(measured).toEqual(["ab_b"]);
  // Unchanged since: not rendered again.
  await tall.call("get_basic_info", {});
  expect(measured).toEqual(["ab_b"]);
});

test("two unmeasured artboards that only meet at their rendered sizes are both measured", async () => {
  // A wide fit-content-width board and a tall fit-content-height board: at the
  // 1440×900 fallback they miss each other; rendered, they cross.
  const s = await withFiles({
    "design.json": JSON.stringify({
      ponzu: 1,
      name: "Fern",
      pages: [{ id: "pg_home", name: "Home" }],
    }),
    "tokens.css": ":root {}\n",
    "pages/home/wide.html": `<section data-artboard data-id="ab_wide" data-name="Wide" data-x="0" data-y="2000" style="width:fit-content;height:400px">\n<p>w</p>\n</section>\n`,
    "pages/home/tall.html": `<section data-artboard data-id="ab_tall" data-name="Tall" data-x="2000" data-y="0" style="width:400px;height:fit-content">\n<p>t</p>\n</section>\n`,
  });
  const sizes: Record<string, [number, number]> = { ab_wide: [3000, 400], ab_tall: [400, 3000] };
  s.ws.renderer = {
    render: async () => {
      throw new Error("unused");
    },
    measure: async (req) => {
      const [width, height] = sizes[req.artboard.id]!;
      return { boxes: { [req.artboard.id]: { x: 0, y: 0, width, height } }, contentHeight: height };
    },
    close: async () => {},
  };
  const r = await s.call("get_basic_info", {});
  expect(r.text).toContain('ab_tall "Tall" and ab_wide "Wide" overlap by 400×400px');
});

test("duplicating to an explicit spot doesn't render distant artboards", async () => {
  // ab_b grows down from y 5000; the copy goes far above it, so its size can't matter.
  // Its own padding, so no earlier test's measurement of ab_b is cached for it.
  const s = await twoBoards(0, 5000, "width:800px;height:fit-content;padding:7px");
  const measured: string[] = [];
  s.ws.renderer = {
    render: async () => {
      throw new Error("unused");
    },
    measure: async (req) => {
      measured.push(req.artboard.id);
      return {
        boxes: { [req.artboard.id]: { x: 0, y: 0, width: 800, height: 300 } },
        contentHeight: 300,
      };
    },
    close: async () => {},
  };
  const r = await s.call("duplicate", { ids: ["ab_a"], x: 0, y: -5000 });
  expect(r.text).toContain("at (0, -5000)");
  expect(measured).toEqual([]);
});

test("a copy in an empty row clears the page's widest artboard at its rendered width", async () => {
  // Nothing sits in row -5000, so the copy goes right of everything; ab_b is
  // far below that row but renders 3000px wide.
  const s = await withFiles({
    "design.json": JSON.stringify({
      ponzu: 1,
      name: "Fern",
      pages: [{ id: "pg_home", name: "Home" }],
    }),
    "tokens.css": ":root {}\n",
    "pages/home/a.html": `<section data-artboard data-id="ab_a" data-name="A" data-x="0" data-y="0" style="width:400px;height:10000px">\n<p>a</p>\n</section>\n`,
    "pages/home/b.html": `<section data-artboard data-id="ab_b" data-name="B" data-x="800" data-y="4000" style="width:fit-content;height:400px;padding:3px">\n<p>b</p>\n</section>\n`,
  });
  s.ws.renderer = {
    render: async () => {
      throw new Error("unused");
    },
    measure: async (req) => ({
      boxes: { [req.artboard.id]: { x: 0, y: 0, width: 3000, height: 400 } },
      contentHeight: 400,
    }),
    close: async () => {},
  };
  const r = await s.call("duplicate", { ids: ["ab_a"], y: -5000 });
  expect(r.text).toContain("at (3880, -5000)");
});

test("record says when fonts or images ran out of time", async () => {
  const { renderer } = fakeRenderer({});
  renderer.record = async () => ({
    bytes: new Uint8Array([1]),
    mime: "image/png",
    width: 10,
    height: 10,
    steps: [{ label: "0ms" }, { label: "1s" }] as never,
    motion: { trigger: "load", animations: [], settled: 0, loops: false, cycle: 0 } as never,
    issues: [],
    assetsTimedOut: true,
  });
  const { call } = await setup(3, renderer);
  const r = await call("record", { id: "ab_hero" });
  expect(r.isError).toBeFalsy();
  expect(r.text).toContain("still loading when time ran out");
});

test("update_file marks a file as scratch and back", async () => {
  const { design, call } = await setup();
  await call("update_file", { scratch: true });
  expect(design.doc.scratch).toBe(true);
  await call("update_file", { scratch: false });
  expect(design.doc.scratch).toBeUndefined();
});

test("list_files filters by name or path", async () => {
  const { call } = await setup();
  expect((await call("list_files", { query: "FER" })).text).toContain("Fern — fern");
  expect((await call("list_files", { query: "kettle" })).text).toBe(
    'No open file matches "kettle" (1 file open).',
  );
});

test("timelapse films the file and says where it went", async () => {
  const { ws, call } = await setup();
  const asked: unknown[] = [];
  ws.timelapse = async (key, req) => {
    asked.push({ key, ...req });
    return {
      path: "/x/exports/timelapse-2026-10-22.mp4",
      codec: "avc1.640028",
      duration: 30,
      bytes: 4_200_000,
    };
  };
  const r = await call("timelapse", {});
  expect(r.text).toBe("Wrote /x/exports/timelapse-2026-10-22.mp4 (30s, H.264, 4.0 MB).");
  expect(asked).toEqual([{ key: "fern", shape: "16:9", range: undefined, theme: "light" }]);
  expect((await call("timelapse", { from: 5, to: 2 })).isError).toBe(true);
  ws.timelapse = undefined;
  expect((await call("timelapse", {})).text).toContain("can't make them");
});
