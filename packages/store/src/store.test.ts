import { describe, expect, test } from "bun:test";
import { type PElement, parseArtboardFile, parseHtml } from "@ponzu/core";
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

  test("scratch is kept in design.json, and undone like any edit", async () => {
    const mem = new MemoryAdapter(seed);
    const d = await Design.open(mem, { saveDelay: 0 });
    d.apply({ op: "file.scratch", scratch: true }, { kind: "agent", name: "t" });
    await d.flush();
    expect(JSON.parse(mem.files["design.json"]!).scratch).toBe(true);
    expect((await Design.open(mem, { saveDelay: 0 })).doc.scratch).toBe(true);
    d.undo({ kind: "agent", name: "t" });
    await d.flush();
    expect(JSON.parse(mem.files["design.json"]!).scratch).toBeUndefined();
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

  test("an outside edit to another file keeps an edit not yet saved, or being saved", async () => {
    // Writes take a while, as on a busy disk: the outside edit lands mid-save.
    class SlowDisk extends MemoryAdapter {
      override async write(path: string, content: string) {
        await new Promise((r) => setTimeout(r, 15));
        await super.write(path, content);
      }
    }
    const who = { kind: "agent", name: "t" } as const;
    for (const saveDelay of [0, 120]) {
      const mem = new SlowDisk(seed);
      const d = await Design.open(mem, { saveDelay });
      d.apply({ op: "file.rename", name: "Fern 2" }, who);
      d.apply({ op: "style", id: "n_h", style: { color: "red" } }, who);
      if (!saveDelay) await new Promise((r) => setTimeout(r, 5));
      await mem.externalWrite("tokens.css", ":root {\n  --ink: #111;\n}\n");
      await new Promise((r) => setTimeout(r, 60));
      await d.flush();
      expect(d.doc.tokens).toContain("#111");
      expect(d.doc.name).toBe("Fern 2");
      expect(mem.files["pages/home/hero.html"]).toContain("color:red");
    }
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

  describe("page folders", () => {
    const who = { kind: "agent", name: "t" } as const;
    const board = (id: string, text = "x") =>
      `<section data-artboard data-id="${id}" data-name="Board" data-x="0" data-y="0" style="width:100px;height:100px"><p>${text}</p></section>\n`;
    const files = (pages: { id: string; name: string }[], boards: Record<string, string>) => ({
      "design.json": JSON.stringify({ ponzu: 1, name: "Fern", pages }),
      "tokens.css": ":root {\n}\n",
      ...boards,
    });
    /** Each page's name and artboards, as a fresh read of the files finds them. */
    const reopened = async (mem: MemoryAdapter) => {
      const d = await Design.open(new MemoryAdapter({ ...mem.files }), { watch: false });
      return d.doc.pages.map((p) => [p.name, p.artboards.map((a) => a.id)]);
    };
    const folders = (mem: MemoryAdapter) =>
      [
        ...new Set(
          Object.keys(mem.files)
            .filter((p) => p.startsWith("pages/"))
            .map((p) => p.split("/")[1]),
        ),
      ].sort();

    test("renaming a page to the start of its old name moves its folder", async () => {
      const mem = new MemoryAdapter(
        files([{ id: "pg_b", name: "Home v2" }], { "pages/home-v2/hero.html": board("ab_hero") }),
      );
      const d = await Design.open(mem, { saveDelay: 0 });
      d.apply({ op: "page.update", id: "pg_b", name: "Home" }, who);
      await d.flush();
      expect(folders(mem)).toEqual(["home"]);
      expect(d.folderOf("pg_b")).toBe("pages/home/");
      expect(await reopened(mem)).toEqual([["Home", ["ab_hero"]]]);
    });

    test("a page renamed to a deleted page's name takes edits written into its folder", async () => {
      const mem = new MemoryAdapter(
        files(
          [
            { id: "pg_a", name: "Home" },
            { id: "pg_b", name: "Home v2" },
          ],
          { "pages/home-v2/hero.html": board("ab_hero") },
        ),
      );
      const d = await Design.open(mem, { saveDelay: 0 });
      d.apply({ op: "page.delete", id: "pg_a" }, who);
      d.apply({ op: "page.update", id: "pg_b", name: "Home" }, who);
      await d.flush();
      expect(d.pathOf("ab_hero")).toBe("pages/home/board.html");
      await mem.externalWrite("pages/home/board.html", board("ab_hero", "edited"));
      await mem.externalWrite(`${d.folderOf("pg_b")}more.html`, board("ab_more"));
      await new Promise((r) => setTimeout(r, 30));
      expect(d.doc.pages.map((p) => [p.id, p.artboards.map((a) => a.id)])).toEqual([
        ["pg_b", ["ab_hero", "ab_more"]],
      ]);
      expect(JSON.stringify(d.doc)).toContain("edited");
      await d.close();
      expect(await reopened(mem)).toEqual([["Home", ["ab_hero", "ab_more"]]]);
    });

    test("pages sharing a name keep their artboards through a reorder and a delete", async () => {
      const seeded = () =>
        new MemoryAdapter(
          files(
            [
              { id: "pg_a", name: "Home" },
              { id: "pg_b", name: "Home" },
            ],
            { "pages/home/a.html": board("ab_a"), "pages/home-2/b.html": board("ab_b") },
          ),
        );
      const mem = seeded();
      const d = await Design.open(mem, { saveDelay: 0 });
      d.apply({ op: "page.order", ids: ["pg_b", "pg_a"] }, who);
      await d.flush();
      expect(await reopened(mem)).toEqual([
        ["Home", ["ab_b"]],
        ["Home", ["ab_a"]],
      ]);

      const gone = seeded();
      const e = await Design.open(gone, { saveDelay: 0 });
      e.apply({ op: "page.delete", id: "pg_a" }, who);
      await e.flush();
      expect(folders(gone)).toEqual(["home"]);
      expect(await reopened(gone)).toEqual([["Home", ["ab_b"]]]);
    });

    test("swapping two pages' names keeps each page's artboards", async () => {
      const mem = new MemoryAdapter(
        files(
          [
            { id: "pg_a", name: "One" },
            { id: "pg_b", name: "Two" },
          ],
          { "pages/one/board.html": board("ab_a"), "pages/two/board.html": board("ab_b") },
        ),
      );
      const d = await Design.open(mem, { saveDelay: 0 });
      d.apply(
        {
          op: "batch",
          ops: [
            { op: "page.update", id: "pg_a", name: "Two" },
            { op: "page.update", id: "pg_b", name: "One" },
          ],
        },
        who,
      );
      await d.flush();
      expect(await reopened(mem)).toEqual([
        ["Two", ["ab_a"]],
        ["One", ["ab_b"]],
      ]);
    });

    test("what Ponzu writes reads back as the same pages", async () => {
      const lists = [
        ["Home", "Home", "Home 2"],
        ["Home v2", "Home", "Home-v2"],
        ["", "Page", "Page"],
        ["Ünïcode", "unicode", "Flow"],
      ];
      for (const names of lists) {
        const pages = names.map((name, i) => ({ id: `pg_${i}`, name }));
        const mem = new MemoryAdapter(files(pages, {}));
        const d = await Design.open(mem, { saveDelay: 0 });
        pages.forEach((p, i) => {
          const { artboard } = parseArtboardFile(board(`ab_${i}`), {
            id: `ab_${i}`,
            name: "Board",
          });
          d.apply({ op: "artboard.create", page: p.id, index: 0, artboard }, who);
        });
        await d.flush();
        expect(await reopened(mem)).toEqual(names.map((n, i) => [n, [`ab_${i}`]]));
      }
    });
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

    test("deleting the last comment removes comments.json, as a design that never had one", async () => {
      const at = 1767225600000;
      const mem = new MemoryAdapter(seed);
      const d = await Design.open(mem, { saveDelay: 0 });
      const thread = {
        id: "th_1",
        pageId: "pg_home",
        x: 10,
        y: 10,
        status: "open" as const,
        createdAt: at,
        updatedAt: at,
        messages: [
          { id: "m_1", author: { kind: "user" as const, name: "Sam" }, text: "Hi", createdAt: at },
        ],
      };
      d.apply({ op: "thread.create", thread }, { kind: "user", name: "t" });
      await d.flush();
      expect(JSON.parse(mem.files["comments.json"]!).threads).toHaveLength(1);
      d.apply({ op: "thread.delete", id: "th_1" }, { kind: "user", name: "t" });
      await d.flush();
      expect(mem.files["comments.json"]).toBeUndefined();
    });

    test("a comment thread missing fields is reported and kept in the file, not shown", async () => {
      const at = 1767225600000;
      const whole = {
        id: "th_ok",
        artboardId: "ab_hero",
        x: 10,
        y: 10,
        status: "open",
        createdAt: at,
        updatedAt: at,
        messages: [{ id: "m_1", author: { kind: "user", name: "Sam" }, text: "Hi", createdAt: at }],
      };
      // A page pin written without a status or message times.
      const broken = {
        id: "th_bad",
        pageId: "pg_home",
        x: 400,
        y: 80,
        createdAt: at,
        updatedAt: at,
        messages: [{ id: "m_2", author: { kind: "agent", name: "a" }, text: "Next" }],
      };
      const mem = new MemoryAdapter({
        ...seed,
        "comments.json": JSON.stringify({ threads: [whole, broken] }),
      });
      const d = await Design.open(mem, { saveDelay: 0 });
      expect(d.doc.threads.map((t) => t.id)).toEqual(["th_ok"]);
      expect(d.problems).toEqual([
        {
          path: "comments.json",
          what: 'thread th_bad not shown, needs status "open" or "resolved", messages, each with id, author { kind, name }, text and createdAt',
        },
      ]);

      // Resolving the good one rewrites comments.json; the broken one is still there to fix.
      d.apply(
        { op: "thread.update", id: "th_ok", status: "resolved" },
        { kind: "user", name: "t" },
      );
      await d.flush();
      const saved = JSON.parse(mem.files["comments.json"]!).threads;
      expect(saved.map((t: { id: string }) => t.id)).toEqual(["th_ok", "th_bad"]);

      // Fixed by hand, it shows and the report clears.
      saved[1].status = "open";
      saved[1].messages[0].createdAt = at;
      await mem.externalWrite("comments.json", JSON.stringify({ threads: saved }));
      await settle();
      expect(d.doc.threads.map((t) => t.id)).toEqual(["th_ok", "th_bad"]);
      expect(d.problems).toEqual([]);
    });

    test("a page without an id, and files that aren't JSON, are reported", async () => {
      const d = await Design.open(
        new MemoryAdapter({
          ...seed,
          "design.json": JSON.stringify({ ponzu: 1, name: "Fern", pages: [{ name: "Home" }] }),
          "comments.json": "{ threads: [",
        }),
        { watch: false, saveDelay: 0 },
      );
      expect(d.problems).toEqual([
        { path: "design.json", what: 'page "Home" has no id' },
        { path: "comments.json", what: "not valid JSON" },
      ]);
      // Once Ponzu writes design.json, every page has its id there.
      d.apply({ op: "file.rename", name: "Fern 2" }, { kind: "user", name: "t" });
      await d.flush();
      expect(JSON.parse((d.storage as MemoryAdapter).files["design.json"]!).pages[0].id).toBe(
        d.doc.pages[0]!.id,
      );
      expect(d.problems).toEqual([{ path: "comments.json", what: "not valid JSON" }]);
    });

    test("an empty design.json or comments.json is reported, not taken for a missing one", async () => {
      const d = await Design.open(
        new MemoryAdapter({ ...seed, "design.json": "", "comments.json": "" }),
        { watch: false },
      );
      expect(d.problems).toEqual([
        { path: "design.json", what: "not valid JSON" },
        { path: "comments.json", what: "not valid JSON" },
      ]);
      const missing = await Design.open(new MemoryAdapter(seed), { watch: false });
      expect(missing.problems).toEqual([]);
    });
  });
});
