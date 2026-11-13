import { describe, expect, test } from "bun:test";
import { type FileHandle, mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PElement, parseArtboardFile, parseHtml } from "@ponzu/core";
import { FsAdapter } from "./fs.ts";
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
      private started: () => void = () => {};
      /** Settles once a save has begun its first write. */
      readonly writing = new Promise<void>((r) => {
        this.started = r;
      });
      override async write(path: string, content: string) {
        this.started();
        await new Promise((r) => setTimeout(r, 15));
        await super.write(path, content);
      }
    }
    const who = { kind: "agent", name: "t" } as const;
    for (const saveDelay of [0, 120]) {
      const mem = new SlowDisk(seed);
      const d = await Design.open(mem, { saveDelay });
      // How long the watcher takes to bring the outside edit in depends on the
      // save it waits behind, so wait for the edit itself rather than a while.
      const fromDisk = new Promise<void>((r) => d.onOp((e) => e.origin.kind === "disk" && r()));
      d.apply({ op: "file.rename", name: "Fern 2" }, who);
      d.apply({ op: "style", id: "n_h", style: { color: "red" } }, who);
      // With no delay the save starts at once: the outside edit lands once it's writing.
      if (!saveDelay) await mem.writing;
      await mem.externalWrite("tokens.css", ":root {\n  --ink: #111;\n}\n");
      await fromDisk;
      await d.flush();
      expect(d.doc.tokens).toContain("#111");
      expect(d.doc.name).toBe("Fern 2");
      expect(mem.files["pages/home/hero.html"]).toContain("color:red");
    }
  });

  test("an edit made while a design closes is written before it's closed", async () => {
    // Writes take a while, so the close is still waiting on a save when the edit comes.
    class SlowDisk extends MemoryAdapter {
      private started: () => void = () => {};
      /** Settles once a save has begun its first write. */
      readonly writing = new Promise<void>((r) => {
        this.started = r;
      });
      override async write(path: string, content: string) {
        this.started();
        await new Promise((r) => setTimeout(r, 15));
        await super.write(path, content);
      }
    }
    const who = { kind: "agent", name: "t" } as const;
    const mem = new SlowDisk(seed);
    const d = await Design.open(mem, { saveDelay: 1000 });
    d.apply({ op: "file.rename", name: "Fern 2" }, who);
    void d.flush();
    // The rename's save is writing, so the next edit is one it doesn't have.
    await mem.writing;
    const closing = d.close();
    d.apply({ op: "style", id: "n_h", style: { color: "red" } }, who);
    await closing;
    expect(JSON.parse(mem.files["design.json"]!).name).toBe("Fern 2");
    expect(mem.files["pages/home/hero.html"]).toContain("color:red");
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

    test("a page moved from the canvas goes out as the order it makes, and undoes", async () => {
      const mem = new MemoryAdapter(
        files(
          [
            { id: "pg_a", name: "One" },
            { id: "pg_b", name: "Two" },
            { id: "pg_c", name: "Three" },
          ],
          { "pages/one/board.html": board("ab_a"), "pages/two/board.html": board("ab_b") },
        ),
      );
      const d = await Design.open(mem, { saveDelay: 0 });
      const sent: unknown[] = [];
      d.onOp((e) => sent.push(e.op));
      d.apply({ op: "page.move", id: "pg_a", index: 2 }, who);
      expect(sent).toEqual([{ op: "page.order", ids: ["pg_b", "pg_c", "pg_a"] }]);
      await d.flush();
      expect(await reopened(mem)).toEqual([
        ["Two", ["ab_b"]],
        ["Three", []],
        ["One", ["ab_a"]],
      ]);
      d.undo(who);
      expect(sent[1]).toEqual({ op: "page.order", ids: ["pg_a", "pg_b", "pg_c"] });
      await d.flush();
      expect((await reopened(mem)).map(([name]) => name)).toEqual(["One", "Two", "Three"]);
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

    test("a pin's place in its node is read back, and one that isn't two numbers is dropped", async () => {
      const at = 1767225600000;
      const thread = (id: string, offset: unknown) => ({
        id,
        artboardId: "ab_hero",
        nodeId: "n_title",
        offset,
        x: 10,
        y: 10,
        status: "open",
        createdAt: at,
        updatedAt: at,
        messages: [{ id: "m_1", author: { kind: "user", name: "Sam" }, text: "Hi", createdAt: at }],
      });
      const d = await Design.open(
        new MemoryAdapter({
          ...seed,
          "comments.json": JSON.stringify({
            threads: [thread("th_ok", { x: 4, y: 2 }), thread("th_bad", { x: "4" })],
          }),
        }),
        { watch: false, saveDelay: 0 },
      );
      expect(d.doc.threads.map((t) => [t.id, t.offset])).toEqual([
        ["th_ok", { x: 4, y: 2 }],
        ["th_bad", undefined],
      ]);
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

describe("an artboard file caught while something is still writing it", () => {
  const path = "pages/home/hero.html";
  const edited = seed[path].replace(">Hi<", ">Hello<").replace('data-x="0"', 'data-x="900"');
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const open = async (files: Record<string, string> = seed, holdDelay = 2000) => {
    const mem = new MemoryAdapter(files);
    const d = await Design.open(mem, { saveDelay: 0, holdDelay });
    const ops: string[] = [];
    d.onOp((e) => ops.push(e.op.op === "batch" ? e.op.ops.map((o) => o.op).join() : e.op.op));
    return { mem, d, ops };
  };
  const hero = (d: Design) => d.doc.pages[0]!.artboards[0]!;

  test("keeps its artboard as last read whole until it's finished", async () => {
    const { mem, d, ops } = await open();
    // A script empties the file, then writes it in pieces.
    for (const partial of ["", seed[path].slice(0, 30), edited.slice(0, edited.indexOf("</h1>"))]) {
      await mem.externalWrite(path, partial);
      await settle();
      expect(hero(d)).toMatchObject({ id: "ab_hero", name: "Hero", x: 0 });
      expect(hero(d).root.style).toMatchObject({ width: "800px", height: "600px" });
      expect(d.heldFiles).toEqual([path]);
    }
    expect(ops).toEqual([]);
    await mem.externalWrite(path, edited);
    await settle();
    expect(hero(d)).toMatchObject({ id: "ab_hero", x: 900 });
    expect(d.heldFiles).toEqual([]);
    // Changed in place: never deleted and made again under another id.
    expect(ops.join()).not.toMatch(/artboard\.(delete|create)/);
    expect(ops.join()).toContain("children");
  });

  test("an edit made meanwhile doesn't write over the file, and the finished file wins", async () => {
    const { mem, d } = await open();
    await mem.externalWrite(path, "");
    await settle();
    d.apply({ op: "artboard.update", id: "ab_hero", x: 50, y: 50 }, { kind: "user", name: "p" });
    await d.flush();
    await settle();
    expect(mem.files[path]).toBe("");
    await mem.externalWrite(path, edited);
    await settle();
    await d.flush();
    expect(hero(d)).toMatchObject({ id: "ab_hero", x: 900, y: 0 });
    expect(mem.files[path]).toContain(">Hello</h1>");
    expect(mem.files[path]).toContain('data-x="900"');
  });

  test("a file that ends up as it was lets go, and saves what was edited meanwhile", async () => {
    const { mem, d } = await open();
    await mem.externalWrite(path, "");
    await settle();
    d.apply({ op: "style", id: "n_h", style: { color: "red" } }, { kind: "agent", name: "t" });
    await d.flush();
    expect(mem.files[path]).toBe("");
    await mem.externalWrite(path, seed[path]);
    await settle();
    await d.flush();
    expect(d.heldFiles).toEqual([]);
    expect(mem.files[path]).toContain('style="color:red"');
  });

  test("an edit waiting on a held file survives more reads before it's finished", async () => {
    const { mem, d } = await open();
    await mem.externalWrite(path, "");
    await settle();
    d.apply({ op: "style", id: "n_h", style: { color: "red" } }, { kind: "agent", name: "t" });
    await d.flush();
    // More of the file, and an edit to another file, both read while it's still held.
    await mem.externalWrite(path, seed[path].slice(0, 30));
    await settle();
    await mem.externalWrite("tokens.css", ":root {\n  --ink: #111;\n}\n");
    await settle();
    expect(d.doc.tokens).toContain("#111");
    const h1 = hero(d).root.children.find((n): n is PElement => n.kind === "el")!;
    expect(h1.style).toMatchObject({ color: "red" });
    await mem.externalWrite(path, seed[path]);
    await settle();
    await d.flush();
    expect(mem.files[path]).toContain('style="color:red"');
  });

  test("closing with a file still held finishes, and leaves the file to its writer", async () => {
    const { mem, d } = await open();
    await mem.externalWrite(path, "");
    await settle();
    d.apply({ op: "style", id: "n_h", style: { color: "red" } }, { kind: "agent", name: "t" });
    await d.close();
    expect(mem.files[path]).toBe("");
  });

  test("a file left without its section is taken as written once it stops changing", async () => {
    const { mem, d } = await open(seed, 60);
    await mem.externalWrite(path, "");
    await settle();
    expect(hero(d).id).toBe("ab_hero");
    // Nothing more comes from the watcher: the wait running out is enough.
    await settle(150);
    expect(d.heldFiles).toEqual([]);
    expect(hero(d).id).not.toBe("ab_hero");
  });

  test("a new file isn't an artboard until it's finished", async () => {
    const { mem, d } = await open();
    const more = `<section data-artboard data-id="ab_more" data-name="More" data-x="900" data-y="0" style="width:400px;height:300px">\n<p>More</p>\n</section>\n`;
    await mem.externalWrite("pages/home/more.html", more.slice(0, 20));
    await settle();
    expect(d.doc.pages[0]!.artboards.map((a) => a.id)).toEqual(["ab_hero"]);
    await mem.externalWrite("pages/home/more.html", more);
    await settle();
    expect(d.doc.pages[0]!.artboards.map((a) => a.id)).toEqual(["ab_hero", "ab_more"]);
  });

  test("ids handed out keep pointing at their elements through a rewrite that empties the file first", async () => {
    const bare = `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px"><h1>Title</h1><p>Body</p></section>\n`;
    const { mem, d } = await open({ ...seed, [path]: bare });
    const p = hero(d).root.children.find(
      (n): n is PElement => n.kind === "el" && n.tag === "p",
    )!.id;
    await mem.externalWrite(path, "");
    await settle();
    await mem.externalWrite(path, bare.replace("<h1>", "<div>Banner</div><h1>"));
    await settle();
    const now = hero(d).root.children.find((n): n is PElement => n.kind === "el" && n.tag === "p")!;
    expect(now.id).toBe(p);
  });

  test("on disk, an emptied file being written slowly keeps its artboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "ponzu-midwrite-"));
    // Closed whatever happens: a file handle left to the garbage collector throws there, into
    // whichever test is running then.
    let fh: FileHandle | undefined;
    let d: Design | undefined;
    try {
      const fs = new FsAdapter(root);
      for (const [p, text] of Object.entries(seed)) await fs.write(p, text);
      // The folder is read from disk as it is, but the test says when it changed. The system's
      // watcher can report a write seconds late on a busy Mac, and this test is about what a
      // read of a half-written file does, not about when the watcher gets round to it.
      let tell: ((paths: string[]) => void) | undefined;
      fs.watch = (onChange) => {
        tell = onChange;
        return () => {
          tell = undefined;
        };
      };
      let onRead: (() => void) | undefined;
      const readAll = fs.readAll.bind(fs);
      fs.readAll = async () => {
        const bag = await readAll();
        onRead?.();
        return bag;
      };
      // Report the change and wait until the design has read the folder and dealt with what it
      // read: the rest of that runs as soon as the read is back, before the next turn of the loop.
      const heard = async () => {
        const read = new Promise<void>((r) => (onRead = r));
        tell!([path]);
        await read;
        onRead = undefined;
        await new Promise((r) => setImmediate(r));
      };
      // Long enough never to run out here: letting go of a file that stays half-written is
      // "a file left without its section is taken as written once it stops changing".
      d = await Design.open(fs, { holdDelay: 3_600_000 });
      // Everything up to the section's closing tag is half a file; the closing tag finishes it.
      const end = edited.lastIndexOf("</section>");
      const pieces = edited.slice(0, end).match(/[\s\S]{1,40}/g)!;
      fh = await openFile(join(root, path), "w");
      for (const piece of ["", ...pieces]) {
        await fh.write(piece);
        await heard();
        expect(d.heldFiles).toEqual([path]);
        expect(hero(d)).toMatchObject({ id: "ab_hero", name: "Hero", x: 0 });
      }
      await fh.write(edited.slice(end));
      await fh.close();
      fh = undefined;
      await heard();
      expect(d.heldFiles).toEqual([]);
      expect(hero(d)).toMatchObject({ id: "ab_hero", name: "Hero", x: 900 });
    } finally {
      await fh?.close();
      await d?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("opening assets", () => {
  const bytes = new Uint8Array(Array.from({ length: 200 }, (_, i) => i));

  test("memory assets open as blobs that slice", async () => {
    const mem = new MemoryAdapter();
    await mem.writeAsset("assets/clip.webm", bytes);
    const blob = (await mem.openAsset("assets/clip.webm"))!;
    expect(blob.size).toBe(200);
    expect([...new Uint8Array(await blob.slice(10, 13).arrayBuffer())]).toEqual([10, 11, 12]);
    expect(await mem.openAsset("assets/none.webm")).toBeNull();
  });

  test("files on disk open as blobs, and nothing outside the design does", async () => {
    const root = await mkdtemp(join(tmpdir(), "ponzu-assets-"));
    try {
      const fs = new FsAdapter(root);
      await fs.writeAsset("assets/clip.webm", bytes);
      const blob = (await fs.openAsset("assets/clip.webm"))!;
      expect(blob.size).toBe(200);
      expect([...new Uint8Array(await blob.slice(197).arrayBuffer())]).toEqual([197, 198, 199]);
      expect(await fs.openAsset("assets/none.webm")).toBeNull();
      expect(await fs.openAsset("assets")).toBeNull();
      expect(await fs.openAsset("../outside.webm")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
