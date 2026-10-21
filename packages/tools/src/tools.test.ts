import { expect, test } from "bun:test";
import { locate } from "@ponzu/core";
import { Design, MemoryAdapter } from "@ponzu/store";
import { EventHub, PresenceHub, type ToolContext, type Workspace } from "./context.ts";
import { getTool, runTool } from "./index.ts";
import { plural } from "./util.ts";

async function setup(tokens = 3) {
  const css = `:root {\n${Array.from({ length: tokens }, (_, i) => `  --t${i}: ${i}px;`).join("\n")}\n}\n`;
  const design = await Design.open(
    new MemoryAdapter({
      "design.json": JSON.stringify({
        ponzu: 1,
        name: "Fern",
        pages: [{ id: "pg_home", name: "Home" }],
      }),
      "tokens.css": css,
      "pages/home/hero.html": `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px">\n<div data-id="n_card"><h1 data-id="n_h">Hi</h1><p data-id="n_p">There</p></div>\n</section>\n`,
    }),
    { saveDelay: 0 },
  );
  const ws: Workspace = {
    designs: () => [{ key: "fern", design }],
    resolve: async () => ({ key: "fern", design }),
    selection: () => ({ ids: [] }) as never,
    events: new EventHub(),
    presence: new PresenceHub(),
  };
  const ctx: ToolContext = { ws, caller: { id: "t", author: { kind: "agent", name: "test" } } };
  const call = (name: string, args: unknown) => runTool(getTool(name)!, args, ctx);
  return { design, call };
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
