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
});
