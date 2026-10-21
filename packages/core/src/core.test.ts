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

  test("bare numbers get px where CSS needs a length, as numbers or strings", () => {
    expect(
      mergeStyle(
        {},
        {
          width: "1440",
          height: " 900 ",
          padding: "16 24",
          margin: "0 auto",
          gap: "0",
          top: "-8.5",
          opacity: "0.5",
          zIndex: "2",
          flex: "1",
          lineHeight: "1.4",
          WebkitLineClamp: "3",
          "--gap": "8",
          fontSize: "1.5rem",
        },
      ),
    ).toEqual({
      width: "1440px",
      height: "900px",
      padding: "16px 24px",
      margin: "0 auto",
      gap: "0",
      top: "-8.5px",
      opacity: "0.5",
      "z-index": "2",
      flex: "1",
      "line-height": "1.4",
      "-webkit-line-clamp": "3",
      "--gap": "8",
      "font-size": "1.5rem",
    });
    expect(mergeStyle({}, { WebkitLineClamp: 3 })).toEqual({ "-webkit-line-clamp": "3" });
  });

  test("inline styles with bare numbers parse with px", () => {
    expect(parseStyle("width:1440;height:900;opacity:1;--n:4")).toEqual({
      width: "1440px",
      height: "900px",
      opacity: "1",
      "--n": "4",
    });
    const { artboard } = parseArtboardFile(
      `<section data-artboard data-id="ab_1" style="width:1440;height:900"></section>`,
      { id: "ab_1", name: "A" },
    );
    expect(artboard.root.style).toEqual({ width: "1440px", height: "900px" });
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

  test("thread ops invert, edits included", () => {
    const d = doc();
    const before = JSON.stringify(d);
    const message = {
      id: "m_1",
      author: { kind: "user" as const, name: "You" },
      text: "a",
      createdAt: 1,
    };
    const ops = [
      {
        op: "thread.create",
        thread: {
          id: "th_1",
          artboardId: "ab_1",
          x: 1,
          y: 2,
          status: "open",
          createdAt: 1,
          updatedAt: 1,
          messages: [message],
        },
      },
      { op: "thread.edit", id: "th_1", messageId: "m_1", text: "b", editedAt: 5 },
      { op: "thread.edit", id: "th_1", messageId: "m_1", text: "c", editedAt: 6 },
      { op: "thread.update", id: "th_1", x: 9, y: 9, nodeId: "n_2" },
      { op: "thread.update", id: "th_1", artboardId: null, nodeId: null, pageId: "pg_1" },
      { op: "thread.delete", id: "th_1" },
    ] as const;
    const inverses = ops.map((op) => applyOp(d, structuredClone(op) as any));
    for (const inv of inverses.reverse()) applyOp(d, inv);
    expect(JSON.stringify(d)).toBe(before);
  });

  test("an edit marks the message and undoing it clears the mark", () => {
    const d = doc();
    const message = {
      id: "m_1",
      author: { kind: "user" as const, name: "You" },
      text: "a",
      createdAt: 1,
    };
    d.threads.push({
      id: "th_1",
      artboardId: "ab_1",
      x: 0,
      y: 0,
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      messages: [message],
    });
    const inverse = applyOp(d, {
      op: "thread.edit",
      id: "th_1",
      messageId: "m_1",
      text: "b",
      editedAt: 5,
    });
    expect(d.threads[0]!.messages[0]).toMatchObject({ text: "b", editedAt: 5 });
    applyOp(d, inverse);
    expect(d.threads[0]!.messages[0]).toEqual(message);
    expect(() =>
      applyOp(d, { op: "thread.edit", id: "th_1", messageId: "m_x", text: "b", editedAt: 5 }),
    ).toThrow();
  });

  test("can't move into itself", () => {
    const d = doc();
    expect(() => applyOp(d, { op: "move", id: "n_1", parent: "n_2", index: 0 })).toThrow();
  });
});
