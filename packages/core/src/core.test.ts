import { describe, expect, test } from "bun:test";
import {
  applyOp,
  type Doc,
  emptyDoc,
  mergeStyle,
  type PElement,
  parseArtboardFile,
  parseHtml,
  parseStyle,
  parseTokens,
  serializeArtboardFile,
  serializeNodes,
  setTokens,
  toKebab,
} from "./index.ts";

describe("css", () => {
  test("keeps semicolons inside url() and strings", () => {
    const s = parseStyle("background:url(data:image/png;base64,AAA);content:'a;b'; color : red");
    expect(s).toEqual({
      background: "url(data:image/png;base64,AAA)",
      content: "'a;b'",
      color: "red",
    });
  });

  test("camelCase and numbers", () => {
    expect(toKebab("backgroundColor")).toBe("background-color");
    expect(toKebab("WebkitLineClamp")).toBe("-webkit-line-clamp");
    expect(mergeStyle({ color: "red" }, { fontSize: 16, opacity: 0.5, color: null })).toEqual({
      "font-size": "16px",
      opacity: "0.5",
    });
  });

  test("tokens round trip", () => {
    let css = ":root {\n  --ink: #000;\n}\n";
    css = setTokens(css, { "--ink": "#111", "--paper": "#fff" });
    expect(parseTokens(css)).toEqual([
      { name: "--ink", value: "#111" },
      { name: "--paper", value: "#fff" },
    ]);
    css = setTokens(css, { "--ink": null });
    expect(parseTokens(css)).toEqual([{ name: "--paper", value: "#fff" }]);
  });
});

describe("html", () => {
  test("strips scripts, handlers and javascript urls", () => {
    const { nodes, dropped } = parseHtml(
      `<div onclick="x()"><script>alert(1)</script><a href=" javascript:alert(1)">hi</a><iframe src="x"></iframe></div>`,
    );
    const html = serializeNodes(nodes, { omitIds: true });
    expect(html).toBe("<div><a>hi</a></div>");
    expect(dropped.map((d) => d.what)).toEqual([
      "onclick on <div>",
      "<script>",
      "javascript: URL in href on <a>",
      "<iframe>",
    ]);
  });

  test("keeps svg casing and self-closes empty svg children", () => {
    const { nodes } = parseHtml(`<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>`);
    expect(serializeNodes(nodes, { omitIds: true })).toBe(
      `<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>`,
    );
  });

  test("names come from data-name or layer-name", () => {
    const { nodes } = parseHtml(`<div layer-name="Hero"></div>`);
    expect((nodes[0] as PElement).name).toBe("Hero");
  });

  test("artboard files round trip", () => {
    const src = `<section data-artboard data-id="ab_1" data-name="Hero" data-x="10" data-y="20" style="width:800px;height:600px">\n<h1 data-id="n_a" style="color:red">Hello &amp; welcome</h1>\n</section>\n`;
    const { artboard } = parseArtboardFile(src, { id: "ab_x", name: "x" });
    expect(artboard.id).toBe("ab_1");
    expect(artboard.x).toBe(10);
    expect(serializeArtboardFile(artboard)).toBe(src);
  });

  test("hand-written files get stable ids", () => {
    const src = `<section data-artboard data-name="A"><p>one</p><p>two</p></section>`;
    const a = parseArtboardFile(src, { id: "ab_1", name: "A" }).artboard;
    const b = parseArtboardFile(src, { id: "ab_1", name: "A" }).artboard;
    expect(serializeArtboardFile(a)).toBe(serializeArtboardFile(b));
    expect(a.id).toBe("ab_1");
  });
});

describe("ops", () => {
  function doc(): Doc {
    const d = emptyDoc("t");
    d.pages.push({ id: "pg_1", name: "Home", artboards: [] });
    const { artboard } = parseArtboardFile(
      `<section data-artboard data-id="ab_1" data-name="A"><div data-id="n_1"><p data-id="n_2">x</p></div></section>`,
      { id: "ab_1", name: "A" },
    );
    d.pages[0]!.artboards.push(artboard);
    return d;
  }

  test("every op inverts", () => {
    const d = doc();
    const before = JSON.stringify(d);
    const ops = [
      { op: "style", id: "n_1", style: { color: "red" } },
      { op: "insert", parent: "n_1", index: 0, nodes: parseHtml("<span>a</span>").nodes },
      { op: "move", id: "n_2", parent: "ab_1", index: 0 },
      { op: "remove", id: "n_1" },
      { op: "artboard.update", id: "ab_1", x: 50, name: "B" },
      { op: "page.update", id: "pg_1", name: "Other" },
      { op: "tokens", css: ":root{--a:1}" },
    ] as const;
    const inverses = ops.map((op) => applyOp(d, structuredClone(op) as any));
    for (const inv of inverses.reverse()) applyOp(d, inv);
    expect(JSON.stringify(d)).toBe(before);
  });

  test("failed batch rolls back", () => {
    const d = doc();
    const before = JSON.stringify(d);
    expect(() =>
      applyOp(d, {
        op: "batch",
        ops: [
          { op: "style", id: "n_1", style: { color: "red" } },
          { op: "remove", id: "n_missing" },
        ],
      }),
    ).toThrow();
    expect(JSON.stringify(d)).toBe(before);
  });

  test("can't move into itself", () => {
    const d = doc();
    expect(() => applyOp(d, { op: "move", id: "n_1", parent: "n_2", index: 0 })).toThrow();
  });
});
