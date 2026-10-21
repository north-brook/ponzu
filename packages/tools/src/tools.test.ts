import { expect, test } from "bun:test";
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
