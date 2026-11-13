import { describe, expect, test } from "bun:test";
import type { Nodes, Root } from "mdast";
import * as mac from "../../studio/src/cloud/ui/markdown";
import { PROSE_LIMIT, parseable, parseProse, plainText, safeHref, settled } from "./prose";

/*
 * Ponzu's replies are untrusted text. The phone draws them by the Mac's rules: these hold it to
 * them (the Mac's own module is read here to compare), and to what may be pressed.
 */

/** Every node of a type in a tree. */
function all(node: Nodes, type: string): Nodes[] {
  const here = node.type === type ? [node] : [];
  const children = "children" in node ? (node.children as Nodes[]) : [];
  return [...here, ...children.flatMap((child) => all(child, type))];
}
const links = (tree: Root | null) =>
  all(tree!, "link").map((l) => (l as Extract<Nodes, { type: "link" }>).url);

describe("what a link may go to", () => {
  test.each([
    "https://ponzu.design/canvases/cnv_1",
    "http://example.com/a?b=c#d",
    "HTTPS://Example.com",
    "mailto:hello@ponzu.design",
  ])("%s goes", (href) => {
    expect(safeHref(href)).toBe(href);
    expect(mac.safeHref(href)).not.toBeNull();
  });

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "file:///etc/passwd",
    "file://localhost/Users",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "ponzu-dev://canvas/cnv_1",
    "/relative/path",
    "#top",
    "//example.com",
    "https:///nohost",
    "https://exa mple.com",
    "",
  ])("%j never goes", (href) => {
    expect(safeHref(href)).toBeNull();
  });

  test("every scheme the Mac refuses, the phone refuses too", () => {
    for (const href of [
      "javascript:x",
      "file:///x",
      "data:x",
      "blob:https://x/y",
      "about:blank",
      "tel:123",
    ]) {
      expect(mac.safeHref(href)).toBeNull();
      expect(safeHref(href)).toBeNull();
    }
  });
});

describe("a reply, parsed", () => {
  test("a Markdown link to javascript: or file: is its words, with nothing to press", () => {
    const tree = parseProse("Go [here](javascript:alert(1)) or [there](file:///etc/passwd).");
    expect(links(tree)).toEqual([]);
    expect(plainText(tree!)).toBe("Go here or there.");
  });

  test("a reference link to javascript: is words too; a safe one is a link", () => {
    const tree = parseProse(
      "[bad][x] and [good][y]\n\n[x]: javascript:alert(1)\n[y]: https://ponzu.design",
    );
    expect(links(tree)).toEqual(["https://ponzu.design"]);
    expect(all(tree!, "definition")).toEqual([]);
  });

  test("a bare address is a link (GitHub's flavour); a bare javascript: is not", () => {
    expect(links(parseProse("See https://ponzu.design/pricing for more"))).toEqual([
      "https://ponzu.design/pricing",
    ]);
    expect(links(parseProse("javascript:alert(1)"))).toEqual([]);
  });

  test("an image never loads: it is a link named by its alt text, or its words in a link", () => {
    const tree = parseProse(
      "![the hero](https://x.test/a.png) [![logo](https://x.test/l.png)](https://ponzu.design)",
    );
    expect(all(tree!, "image")).toEqual([]);
    expect(links(tree)).toEqual(["https://x.test/a.png", "https://ponzu.design"]);
    expect(plainText(tree!)).toBe("the hero logo");
    // An image of a file: is its alt text alone.
    const local = parseProse("![secret](file:///etc/passwd)");
    expect(links(local)).toEqual([]);
    expect(plainText(local!)).toBe("secret");
  });

  test("HTML stays text, and comments go", () => {
    const tree = parseProse('<img src=x onerror="alert(1)">\n\nHi <b>there</b><!-- hidden -->');
    expect(all(tree!, "html")).toEqual([]);
    expect(plainText(tree!)).toContain('<img src=x onerror="alert(1)">');
    expect(plainText(tree!)).toContain("<b>there</b>");
    expect(plainText(tree!)).not.toContain("hidden");
  });

  test("quotes nest three deep; past that the text reads as written", () => {
    const tree = parseProse("> > > > deep");
    expect(all(tree!, "blockquote").length).toBe(3);
    expect(plainText(tree!)).toContain("> deep");
  });

  test("emphasis and links nest four deep; past that the markers read as written", () => {
    const tree = parseProse("*a **b ~~c [d *e*](https://x.test)~~***");
    const nested = ["emphasis", "strong", "delete", "link"].reduce(
      (n, t) => n + all(tree!, t).length,
      0,
    );
    expect(nested).toBe(4);
    expect(plainText(tree!)).toContain("*e*");
  });

  test("tables, task lists and strikethrough, as GitHub draws them", () => {
    const tree = parseProse("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] not\n\n~~gone~~");
    expect(all(tree!, "table").length).toBe(1);
    expect(all(tree!, "listItem").map((i) => (i as { checked?: boolean | null }).checked)).toEqual([
      true,
      false,
    ]);
    expect(all(tree!, "delete").length).toBe(1);
  });

  test("footnotes read as written", () => {
    const tree = parseProse("A claim[^1]\n\n[^1]: The note");
    expect(all(tree!, "footnoteReference")).toEqual([]);
    expect(plainText(tree!)).toContain("[^1]");
  });

  test("past the limit, or shaped to be slow, it is plain text", () => {
    expect(parseProse("a".repeat(PROSE_LIMIT + 1))).toBeNull();
    expect(parseProse("*_".repeat(20))).toBeNull();
    expect(parseProse("> > > > > > deep")).toBeNull();
  });

  test("streaming, half a link reads as its words", () => {
    expect(settled("See [the Plans bo")).toBe("See the Plans bo");
    expect(settled("See [the Plans](https://ponzu.des")).toBe("See the Plans");
    expect(plainText(parseProse("See [the Plans](https://ponzu.des", { streaming: true })!)).toBe(
      "See the Plans",
    );
  });
});

describe("the phone parses what the Mac parses", () => {
  const corpus = [
    "Plain words.",
    "a".repeat(PROSE_LIMIT),
    "a".repeat(PROSE_LIMIT + 1),
    "*_".repeat(9),
    "*_".repeat(20),
    "> > > > nested",
    "> > > > > nested",
    "- - - - - list",
    `${" ".repeat(70)}- deep`,
    Array.from({ length: 1200 }, () => "> q").join("\n"),
    Array.from({ length: 1100 }, () => "line").join("\n"),
    "```\n" + Array.from({ length: 1100 }, () => "code").join("\n") + "\n```",
    "|".repeat(2100),
    `${"a\n=\n".repeat(210)}`,
    `${"[".repeat(5)}x${"]".repeat(5)}`,
    `<div>\n\`\`\`\n${Array.from({ length: 1100 }, () => "x").join("\n")}\n</div>`,
  ];
  test.each(corpus.map((text, i) => [i, text] as const))("text %i", (_i, text) => {
    expect(parseable(text)).toBe(mac.parseable(text));
  });
  test("prepare and settled agree", () => {
    for (const text of ["a<!-- b -->c\r\nd", "See [x](https://a", "`[x`", "```\n[x"]) {
      expect(settled(text)).toBe(mac.settled(text));
    }
  });
});
