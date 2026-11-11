import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInline, parseMarkdown, safeHref } from "./markdown.ts";
import { Prose } from "./prose.tsx";

const html = (text: string) => renderToStaticMarkup(<Prose text={text} />);
/** Every element the markup opens, by tag. */
const tags = (markup: string) => [...markup.matchAll(/<([a-z0-9]+)[\s>]/g)].map((m) => m[1]);

test("raw HTML from the model or GitHub stays text", () => {
  const out = html(
    'Hi <script>alert(1)</script> <img src="https://evil.test/beacon.gif" onerror="x()"> <iframe src="x"></iframe> <a href="javascript:alert(1)">go</a> <style>*{}</style>',
  );
  expect(tags(out)).toEqual(["div", "p"]);
  expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<a");
});

test("a link survives only to http, https or mailto", () => {
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative",
    "ponzu://design/1",
  ]) {
    expect(safeHref(href)).toBeNull();
    const out = html(`[click](${href})`);
    expect(out).not.toContain("<a");
    expect(out).toContain("click");
  }
  expect(html("[docs](https://ponzu.design/docs)")).toContain('href="https://ponzu.design/docs"');
  expect(html("[mail](mailto:hi@ponzu.design)")).toContain('href="mailto:hi@ponzu.design"');
});

test("an image never loads: it becomes a link named by its alt text", () => {
  const out = html("Look ![a beacon](https://evil.test/pixel.gif?who=you) here");
  expect(out).not.toContain("<img");
  expect(out).toContain('<a href="https://evil.test/pixel.gif?who=you"');
  expect(out).toContain(">a beacon</a>");
  // An unsafe image is its alt text alone.
  expect(html("![x](javascript:alert(1))")).not.toContain("<a");
});

test("autolinks take the address and leave the sentence's punctuation", () => {
  expect(parseInline("See https://github.com/north-brook/fernwood/pull/412.")).toEqual([
    { kind: "text", text: "See " },
    {
      kind: "link",
      href: "https://github.com/north-brook/fernwood/pull/412",
      children: [{ kind: "text", text: "https://github.com/north-brook/fernwood/pull/412" }],
    },
    { kind: "text", text: "." },
  ]);
});

test("inline code, emphasis and links", () => {
  expect(parseInline("tokens get a `--hero-measure`, **bold** and *em*")).toEqual([
    { kind: "text", text: "tokens get a " },
    { kind: "code", text: "--hero-measure" },
    { kind: "text", text: ", " },
    { kind: "strong", children: [{ kind: "text", text: "bold" }] },
    { kind: "text", text: " and " },
    { kind: "em", children: [{ kind: "text", text: "em" }] },
  ]);
  // Code keeps what would otherwise be markup.
  expect(parseInline("`<b>**not bold**</b>`")).toEqual([
    { kind: "code", text: "<b>**not bold**</b>" },
  ]);
  expect(parseInline("*a **b** c*")).toEqual([
    {
      kind: "em",
      children: [
        { kind: "text", text: "a " },
        { kind: "strong", children: [{ kind: "text", text: "b" }] },
        { kind: "text", text: " c" },
      ],
    },
  ]);
});

test("what only looks like emphasis stays as written", () => {
  expect(parseInline("snake_case_name and 2 * 3 * 4")).toEqual([
    { kind: "text", text: "snake_case_name and 2 * 3 * 4" },
  ]);
  expect(parseInline("an **unclosed bold")).toEqual([{ kind: "text", text: "an **unclosed bold" }]);
  expect(parseInline("\\*literal\\*")).toEqual([{ kind: "text", text: "*literal*" }]);
});

test("blocks: paragraphs, short lists, fenced code, quotes and headings", () => {
  const blocks = parseMarkdown(
    "## Plan\n\nI'll do three things:\n\n1. Read the hero\n2. Draw **B**\n   and C\n\n- one\n- two\n\n```ts\nconst a = 1;\n\nconst b = <div />;\n```\n> quoted\n> still\n\n---\nlast line\nsecond line",
  );
  expect(blocks.map((b) => b.kind)).toEqual([
    "heading",
    "paragraph",
    "list",
    "list",
    "code",
    "quote",
    "rule",
    "paragraph",
  ]);
  const ordered = blocks[2] as Extract<(typeof blocks)[number], { kind: "list" }>;
  expect(ordered.ordered).toBe(true);
  expect(ordered.items).toHaveLength(2);
  expect(ordered.items[1]).toEqual([
    { kind: "text", text: "Draw " },
    { kind: "strong", children: [{ kind: "text", text: "B" }] },
    { kind: "break" },
    { kind: "text", text: "and C" },
  ]);
  expect(blocks[4]).toEqual({ kind: "code", text: "const a = 1;\n\nconst b = <div />;" });
  // A line break inside a paragraph is kept, as people write in a chat.
  expect(html("last line\nsecond line")).toContain("last line<br/>second line");
});

test("an unclosed fence while text streams is code to the end", () => {
  expect(parseMarkdown("Writing:\n```\nconst a")).toEqual([
    { kind: "paragraph", children: [{ kind: "text", text: "Writing:" }] },
    { kind: "code", text: "const a" },
  ]);
});

test("pull request templates' HTML comments are dropped", () => {
  expect(html("<!-- describe your change -->\nFixes the hero")).not.toContain("describe");
});
