import { describe, expect, test } from "bun:test";
import { type PElement, parseHtml } from "@ponzu/core";
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

  test("the file's icon is kept in design.json and read back", async () => {
    const mem = new MemoryAdapter(seed);
    const d = await Design.open(mem, { saveDelay: 0 });
    d.apply({ op: "file.icon", icon: "palette" }, { kind: "agent", name: "t" });
    await d.flush();
    expect(JSON.parse(mem.files["design.json"]!).icon).toBe("palette");
    expect((await Design.open(mem, { saveDelay: 0 })).doc.icon).toBe("palette");
    // Taken out by hand, it goes from the doc too.
    await mem.externalWrite("design.json", seed["design.json"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.doc.icon).toBeUndefined();
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

  test("the example flag survives saves and outside edits to design.json", async () => {
    const meta = JSON.parse(seed["design.json"]);
    const mem = new MemoryAdapter({
      ...seed,
      "design.json": JSON.stringify({ ...meta, example: true }),
    });
    const d = await Design.open(mem, { saveDelay: 0 });
    expect(d.doc.example).toBe(true);
    // A write of design.json for another reason keeps it.
    d.apply({ op: "file.rename", name: "Fern 2" }, { kind: "user", name: "t" });
    await d.flush();
    expect(JSON.parse(mem.files["design.json"]!)).toMatchObject({ name: "Fern 2", example: true });
    // Taken out by hand, it stays out on the next write.
    await mem.externalWrite("design.json", JSON.stringify({ ...meta, name: "Fern 3" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(d.doc.example).toBeUndefined();
    d.apply({ op: "file.rename", name: "Fern 4" }, { kind: "user", name: "t" });
    await d.flush();
    expect(JSON.parse(mem.files["design.json"]!).example).toBeUndefined();
    // Put back by hand, it's picked up.
    await mem.externalWrite("design.json", JSON.stringify({ ...meta, example: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(d.doc.example).toBe(true);
  });

  test("only `true` makes a design an example", async () => {
    const meta = JSON.parse(seed["design.json"]);
    for (const example of ["true", 1, false, null]) {
      const mem = new MemoryAdapter({
        ...seed,
        "design.json": JSON.stringify({ ...meta, example }),
      });
      const d = await Design.open(mem, { saveDelay: 0 });
      expect(d.doc.example).toBeUndefined();
    }
  });

  describe("files written outside Ponzu", () => {
    const design = {
      "design.json": JSON.stringify({
        ponzu: 1,
        name: "Big",
        pages: [{ id: "pg_c", name: "Components" }],
      }),
      "pages/components/diagram-one.html": `<section data-artboard data-name="Diagram one"><div><h1>Flow</h1><p>Alpha</p><p>Beta</p></div></section>\n`,
      "pages/components/diagram-two.html": `<section data-artboard data-name="Diagram two"><div><h1>Other</h1><p>Gamma</p><p>Delta</p></div></section>\n`,
    };
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const textIds = (d: Design, name: string) => {
      const ab = d.doc.pages[0]!.artboards.find((a) => a.name === name)!;
      const out: Record<string, string> = {};
      const visit = (el: PElement) => {
        for (const c of el.children) {
          if (c.kind !== "el") continue;
          const t = c.children.find((x) => x.kind === "text");
          out[t?.kind === "text" ? t.value : c.tag] = c.id;
          visit(c);
        }
      };
      visit(ab.root);
      return out;
    };

    test("every artboard and node gets its own id, the same on every open", async () => {
      const a = await Design.open(new MemoryAdapter(design), { watch: false });
      const b = await Design.open(new MemoryAdapter(design), { watch: false });
      const all = (d: Design) =>
        d.doc.pages[0]!.artboards.flatMap((ab) => [ab.id, ...Object.values(textIds(d, ab.name))]);
      expect(new Set(all(a)).size).toBe(all(a).length);
      expect(all(b)).toEqual(all(a));
    });

    test("an edit to one file leaves the other artboards' ids alone", async () => {
      const mem = new MemoryAdapter(design);
      const d = await Design.open(mem, { saveDelay: 0 });
      const ids = d.doc.pages[0]!.artboards.map((a) => a.id);
      const two = textIds(d, "Diagram two");
      await mem.externalWrite(
        "pages/components/diagram-one.html",
        design["pages/components/diagram-one.html"].replace("Beta", "Gamma"),
      );
      await settle();
      expect(d.doc.pages[0]!.artboards.map((a) => a.id)).toEqual(ids);
      expect(textIds(d, "Diagram two")).toEqual(two);
    });

    test("ids a tool saw keep pointing at their elements through edits and a reopen", async () => {
      const mem = new MemoryAdapter(design);
      const d = await Design.open(mem, { saveDelay: 0 });
      const seen = textIds(d, "Diagram one");

      // A script puts a banner above everything.
      await mem.externalWrite(
        "pages/components/diagram-one.html",
        design["pages/components/diagram-one.html"].replace(
          "<div>",
          "<header>Banner</header><div>",
        ),
      );
      await settle();
      expect(textIds(d, "Diagram one")).toMatchObject({
        Alpha: seen.Alpha,
        Beta: seen.Beta,
        Flow: seen.Flow,
      });
      // The ids are in the file now, so they survive anyone reading it fresh.
      expect(mem.files["pages/components/diagram-one.html"]).toContain(`data-id="${seen.Beta}"`);

      // The script writes the file again, from its own copy without ids.
      await mem.externalWrite(
        "pages/components/diagram-one.html",
        design["pages/components/diagram-one.html"]
          .replace("<div>", "<header>Banner</header><div>")
          .replace("</div>", "</div><table><tr><td>1</td></tr></table>"),
      );
      await settle();
      expect(textIds(d, "Diagram one")).toMatchObject({ Alpha: seen.Alpha, Beta: seen.Beta });
      d.apply(
        { op: "style", id: seen.Beta!, style: { color: "red" } },
        { kind: "agent", name: "t" },
      );
      await d.flush();
      await d.close();

      const again = await Design.open(new MemoryAdapter(mem.files), { watch: false });
      expect(textIds(again, "Diagram one")).toMatchObject({ Alpha: seen.Alpha, Beta: seen.Beta });
      expect(mem.files["pages/components/diagram-one.html"]).toContain(
        `<p data-id="${seen.Beta}" style="color:red">Beta</p>`,
      );
    });

    test("an edit that leaves every id in place doesn't touch the file", async () => {
      const mem = new MemoryAdapter(design);
      const d = await Design.open(mem, { saveDelay: 0 });
      const edited = design["pages/components/diagram-one.html"].replace(
        "</div>",
        "</div><p>More</p>",
      );
      await mem.externalWrite("pages/components/diagram-one.html", edited);
      await settle();
      await d.flush();
      expect(mem.files["pages/components/diagram-one.html"]).toBe(edited);
    });
  });
});
