import { describe, expect, test } from "bun:test";
import { parseHtml } from "@ponzu/core";
import { Design, MemoryAdapter } from "./index.ts";

const seed = {
  "design.json": JSON.stringify({
    ponzu: 1,
    name: "Fern",
    pages: [{ id: "pg_home", name: "Home" }],
  }),
  "tokens.css": ":root {\n  --ink: #000;\n}\n",
  "pages/home/hero.html": `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px">\n<h1 data-id="n_h">Hi</h1>\n</section>\n`,
};

describe("design", () => {
  test("loads, edits and saves only what changed", async () => {
    const mem = new MemoryAdapter(seed);
    const d = await Design.open(mem, { saveDelay: 0 });
    expect(d.doc.pages[0]!.artboards[0]!.id).toBe("ab_hero");
    d.apply({ op: "style", id: "n_h", style: { color: "red" } }, { kind: "agent", name: "t" });
    await d.flush();
    expect(mem.files["pages/home/hero.html"]).toContain('style="color:red"');
    expect(mem.files["design.json"]).toBe(seed["design.json"]);
  });

  test("renaming an artboard renames its file", async () => {
    const mem = new MemoryAdapter(seed);
    const d = await Design.open(mem, { saveDelay: 0 });
    d.apply({ op: "artboard.update", id: "ab_hero", name: "Landing" }, { kind: "user", name: "t" });
    await d.flush();
    expect(mem.files["pages/home/landing.html"]).toContain('data-name="Landing"');
    expect(mem.files["pages/home/hero.html"]).toBeUndefined();
  });

  test("outside edits become ops", async () => {
    const mem = new MemoryAdapter(seed);
    const d = await Design.open(mem, { saveDelay: 0 });
    const seen: string[] = [];
    d.onOp((e) => seen.push(e.origin.kind));
    await mem.externalWrite(
      "pages/home/hero.html",
      seed["pages/home/hero.html"].replace("Hi", "Hello"),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["disk"]);
    expect(JSON.stringify(d.doc)).toContain("Hello");
  });

  test("undo and redo", async () => {
    const d = await Design.open(new MemoryAdapter(seed), { saveDelay: 0 });
    const who = { kind: "user", name: "t" } as const;
    d.apply({ op: "insert", parent: "ab_hero", index: 1, nodes: parseHtml("<p>x</p>").nodes }, who);
    expect(d.doc.pages[0]!.artboards[0]!.root.children.length).toBe(4);
    d.undo(who);
    expect(d.doc.pages[0]!.artboards[0]!.root.children.length).toBe(3);
    d.redo(who);
    expect(d.doc.pages[0]!.artboards[0]!.root.children.length).toBe(4);
  });
});
