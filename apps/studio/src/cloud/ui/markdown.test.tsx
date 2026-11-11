import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import {
  blocks,
  PROSE_LIMIT,
  parseable,
  parts,
  remarkGfm,
  remarkUntrusted,
  safeHref,
} from "./markdown.ts";
import { Prose } from "./prose.tsx";

const html = (text: string) => renderToStaticMarkup(<Prose text={text} />);
/** Every element the markup opens, by tag. */
const tags = (markup: string) => [...markup.matchAll(/<([a-z0-9]+)[\s>/]/g)].map((m) => m[1]);
/** The markup without its classes, to read its shape. */
const shape = (markup: string) => markup.replaceAll(/ (class|dir)="[^"]*"/g, "");

test("raw HTML from the model or GitHub stays text", () => {
  const out = html(
    'Hi <script>alert(1)</script> <img src="https://evil.test/beacon.gif" onerror="x()"> <iframe src="x"></iframe> <a href="javascript:alert(1)">go</a> <style>*{}</style>',
  );
  expect(tags(out)).toEqual(["div", "p"]);
  expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<a");
  // As a block of its own, too.
  const block = html('<div onclick="x()">\n<script>alert(1)</script>\n</div>');
  expect(tags(block)).not.toContain("script");
  expect(block).toContain("&lt;script&gt;");
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
  // Written as an autolink, or a reference.
  expect(html("<javascript:alert(1)>")).not.toContain("<a");
  expect(html("[go][x]\n\n[x]: javascript:alert(1)")).not.toContain("<a");
  expect(html("[docs](https://ponzu.design/docs)")).toContain('href="https://ponzu.design/docs"');
  expect(html("[mail](mailto:hi@ponzu.design)")).toContain('href="mailto:hi@ponzu.design"');
});

test("a link opens outside the app, and tells it nothing", () => {
  const out = html("[docs](https://ponzu.design/docs)");
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
});

test("an image never loads: it becomes a link named by its alt text", () => {
  const out = html("Look ![a beacon](https://evil.test/pixel.gif?who=you) here");
  expect(out).not.toContain("<img");
  expect(out).toContain('<a href="https://evil.test/pixel.gif?who=you"');
  expect(out).toContain(">a beacon</a>");
  // An unsafe image is its alt text alone.
  expect(html("![x](javascript:alert(1))")).not.toContain("<a");
  // A picture inside a link is its alt text, inside the one link.
  const linked = html("[![badge](https://evil.test/b.svg)](https://ci.test)");
  expect(linked.match(/<a /g)).toHaveLength(1);
  expect(linked).not.toContain("<img");
  expect(html("![x][p]\n\n[p]: https://evil.test/p.gif")).not.toContain("<img");
});

test("autolinks take the address and leave the sentence's punctuation", () => {
  expect(shape(html("See https://github.com/north-brook/fernwood/pull/412."))).toContain(
    '<p>See <a href="https://github.com/north-brook/fernwood/pull/412" target="_blank" rel="noopener noreferrer">https://github.com/north-brook/fernwood/pull/412</a>.</p>',
  );
});

test("inline code, emphasis and links", () => {
  expect(shape(html("tokens get a `--hero-measure`, **bold** and *em*"))).toBe(
    "<div><p>tokens get a <code>--hero-measure</code>, <strong>bold</strong> and <em>em</em></p></div>",
  );
  // Code keeps what would otherwise be markup.
  expect(shape(html("`<b>**not bold**</b>`"))).toBe(
    "<div><p><code>&lt;b&gt;**not bold**&lt;/b&gt;</code></p></div>",
  );
  expect(shape(html("*a **b** c*"))).toBe("<div><p><em>a <strong>b</strong> c</em></p></div>");
});

test("what only looks like emphasis stays as written", () => {
  expect(shape(html("snake_case_name and 2 * 3 * 4"))).toBe(
    "<div><p>snake_case_name and 2 * 3 * 4</p></div>",
  );
  expect(shape(html("an **unclosed bold"))).toBe("<div><p>an **unclosed bold</p></div>");
  expect(shape(html("\\*literal\\*"))).toBe("<div><p>*literal*</p></div>");
});

test("blocks: paragraphs, lists, fenced code, quotes and headings", () => {
  const out = html(
    "## Plan\n\nI'll do three things:\n\n1. Read the hero\n2. Draw **B**\n   and C\n\n- one\n- two\n\n```ts\nconst a = 1;\n\nconst b = <div />;\n```\n> quoted\n> still\n\n---\nlast line\nsecond line",
  );
  const blocks = tags(out).filter((t) => ["p", "ol", "ul", "pre", "blockquote", "hr"].includes(t!));
  expect(blocks).toEqual(["p", "p", "ol", "ul", "pre", "blockquote", "p", "hr", "p"]);
  expect(shape(out)).toContain("<li>Draw <strong>B</strong><br/>\nand C</li>");
  expect(shape(out)).toContain("<pre>const a = 1;\n\nconst b = &lt;div /&gt;;</pre>");
  // A line break inside a paragraph is kept, as people write in a chat and GitHub draws it.
  expect(html("last line\nsecond line")).toContain("last line<br/>\nsecond line");
  expect(html("3. three\n4. four")).toContain('start="3"');
});

test("an unclosed fence while text streams is code to the end", () => {
  expect(shape(html("Writing:\n```\nconst a"))).toBe(
    "<div><p>Writing:</p>\n<pre>const a</pre></div>",
  );
});

test("cut into blocks, text draws as it does whole, so streaming redraws only the last", () => {
  const whole = (text: string) =>
    renderToStaticMarkup(
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkUntrusted]}>{text}</Markdown>,
    );
  const apart = (text: string) => blocks(text).map(whole).join("\n");
  for (const text of [
    "One.\n\nTwo **bold**.\n\n- a\n- b\n\nThree.",
    "- loose\n\n- list\n\n  continued\n\n1. one\n\n2. two",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter.",
    "> quote\n\n> another\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n    indented code\n\n    more",
    "Text [ref][x].\n\n[x]: https://a.test",
    "## Summary\n\n<!-- template -->\n\n- [x] Tests\n- [ ] Docs\n\n## Notes\n\nWriting:\n```\nconst a",
  ]) {
    expect(apart(text)).toBe(whole(text));
  }
  expect(blocks("One.\n\nTwo.\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
  expect(blocks("```\na\n\nb\n```")).toHaveLength(1);
});

test("pull request templates' HTML comments are dropped", () => {
  expect(html("<!-- describe your change -->\nFixes the hero")).not.toContain("describe");
});

test("tables, as every pull request template has them", () => {
  const out = html(
    "| Before | After |\n| :-- | --: |\n| `12px` | **14px** |\n| a long https://example.test/path | b |",
  );
  expect(tags(out)).toEqual(expect.arrayContaining(["table", "thead", "tbody", "tr", "th", "td"]));
  expect(shape(out)).toContain('<th style="text-align:left">Before</th>');
  expect(shape(out)).toContain('<td style="text-align:right"><strong>14px</strong></td>');
  expect(out).toContain('href="https://example.test/path"');
  // It scrolls inside its own box rather than widening the thread.
  expect(out).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
});

test("task lists: a box for each item, never a control", () => {
  const out = html("- [x] Tests pass\n- [ ] Screenshots attached");
  expect(out).not.toContain("<input");
  expect(out.match(/role="img"/g)).toHaveLength(2);
  expect(out).toContain('aria-label="Done"');
  expect(out).toContain('aria-label="Not done"');
  expect(out).toContain("Tests pass");
  expect(out).not.toContain("[x]");
});

test("strikethrough and bare addresses, as GitHub writes them", () => {
  expect(shape(html("~~old~~ new"))).toContain("<del>old</del> new");
  expect(html("www.ponzu.design")).toContain('href="http://www.ponzu.design/"');
});

/*
 * micromark slows with the square of some shapes (a 16 KB address of dots took 1.5 s, 16 KB of
 * `![` 5 s at 64 KB) and runs out of stack on a line of nested lists. `parseable` sends those to
 * plain text; what it lets through, shaped to sit just under each of its limits, measured under
 * 100 ms at the 32 KB limit on an M-series Mac, at most about four times an ordinary reply that
 * long (a thousand one-letter paragraphs and a long fenced block cost by their number of
 * lines). The
 * bound is against that reply on the same machine, since CI runs slower: a shape that grows with
 * the square of its length costs tens of times more. One slow draw proves nothing on a busy
 * machine (a collection or a neighbour's test lands in it), so a text over the bound is drawn
 * again, twice at most, and its fastest draw is what counts: a shape that is slow by its nature
 * is slow every time.
 */
test("hostile text the size of a GitHub comment draws about as fast as a reply", () => {
  const fill = (unit: string, n = 65_536) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const under = (unit: string) => fill(unit, PROSE_LIMIT - 1);
  const time = (text: string) => {
    const started = performance.now();
    html(text);
    return performance.now() - started;
  };
  // Warm the parser once, as the app has by the time anything arrives.
  html("*warm* `up`");
  const reply = under(
    "I moved the headline into `--hero-measure` and set **B** a step calmer, as [you asked](https://a.test).\n\n- one change\n- another\n\n",
  );
  const ordinary = Math.min(time(reply), time(reply), time(reply));
  const bound = Math.max(5 * ordinary, 100);
  const fastest = (text: string) => {
    let best = time(text);
    for (let again = 0; again < 2 && best >= bound; again++) best = Math.min(best, time(text));
    return best;
  };
  for (const text of [
    fill("*a "),
    fill("_a "),
    fill("**a "),
    fill("~~a "),
    fill("[a "),
    fill("![a "),
    fill("*_~~[`a "),
    fill("| a "),
    fill("- [ "),
    `http://a${".".repeat(65_536)}x`,
    `www.a${".".repeat(16_384)}x`,
    `- ${fill("*a ")}`,
    `${">".repeat(16_384)} deep`,
    `${"- ".repeat(5000)}x`,
    `${"*_".repeat(4096)}x${"_*".repeat(4096)}`,
    // Brackets with no partner, which GFM's footnotes scanned back over with the square of their
    // number; lines underlined as headings, which micromark resolves against the text before
    // them; and short lines, in one paragraph or each its own.
    under("a]"),
    under("x]\n"),
    under("a ]"),
    under("b]a"),
    under("a\n=\n"),
    under("a\n-\n"),
    under("a\n"),
    under("a\n\n"),
    under("[^a] "),
    // Just under the limits.
    under(`${"[".repeat(16)}${"a ".repeat(100)}`),
    under(`${"*_".repeat(8)}${"a ".repeat(100)}`),
    under(`${"*_".repeat(4)}a${"_*".repeat(4)} ${"b ".repeat(80)}`),
    under(`http://a${".".repeat(15)}b `),
    under("*a* bcde "),
    under(`${"x]\n".repeat(1000)}\n`),
    `${"a\n=\n".repeat(200)}${fill("word ", PROSE_LIMIT - 801)}`,
    `${"a\n\n".repeat(1000)}${fill("word ", PROSE_LIMIT - 3001)}`,
    `\`\`\`\n${fill("a\n", PROSE_LIMIT - 5)}`,
    fill("- - - - x\n", 8000),
    Array.from({ length: 30 }, (_, i) => `${"  ".repeat(i)}- x`)
      .join("\n")
      .repeat(20),
  ]) {
    expect(fastest(text)).toBeLessThan(bound);
  }
});

test("what can't be parsed quickly is plain text, as written", () => {
  const long = `**bold** ${"a".repeat(PROSE_LIMIT)}`;
  expect(parseable(long)).toBe(false);
  const out = html(long);
  expect(out).not.toContain("<strong");
  expect(out).toContain("**bold**");
  expect(html(`${"![".repeat(40)}x <script>`)).toContain("&lt;script&gt;");
  // Ordinary Markdown is never mistaken for it.
  for (const text of [
    "-----\nhr",
    "*****",
    "> > > quote",
    "1. a\n   - b\n     - c\n       - d",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "**bold** and ***both***",
    "Wait......",
    "> - [ ] task",
    "[**`code`**](https://a.test)",
  ]) {
    expect(parseable(text)).toBe(true);
  }
});

test("long runs of lines, headings and blocks are plain text just past their limits", () => {
  const lines = (n: number, line = "a") => `${line}\n`.repeat(n);
  expect(parseable(lines(1000))).toBe(true);
  expect(parseable(lines(1001))).toBe(false);
  // A blank line or fenced code starts the count again.
  expect(parseable(`${lines(1000)}\n${lines(1000)}`)).toBe(true);
  expect(parseable(`\`\`\`\n${lines(5000)}\`\`\`\n${lines(1000)}`)).toBe(true);
  // A fence that only looks like one hides nothing: inside an HTML block, after text, or with a
  // backtick in its info.
  expect(parseable(`<div>\n\`\`\`\n\n${lines(1001)}`)).toBe(false);
  expect(parseable(`\`\`\` a\`b\n${lines(1001)}`)).toBe(false);
  expect(parseable(`- a\n  \`\`\`\n${lines(1001)}`)).toBe(false);
  expect(parseable("a\n=\n".repeat(200))).toBe(true);
  expect(parseable("a\n=\n".repeat(201))).toBe(false);
  // A rule after a blank line underlines nothing.
  expect(parseable("a\n\n---\n".repeat(300))).toBe(true);

  const out = (n: number) => html("a\n\n".repeat(n));
  expect(out(1000)).not.toContain("whitespace-pre-wrap");
  expect(out(1001)).toContain("whitespace-pre-wrap");
});

test("blocks drawn in runs draw as they do whole", () => {
  const text = Array.from({ length: 40 }, (_, i) =>
    i % 3 ? `Line ${i} **bold**` : `> quote ${i}\n> - [x] done`,
  ).join("\n\n");
  const whole = renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkUntrusted]}>{text}</Markdown>,
  );
  expect(blocks(text)).toHaveLength(40);
  const split = parts(text)!;
  expect(split).toHaveLength(3);
  const apart = split
    .map((run) =>
      renderToStaticMarkup(
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkUntrusted]}>{run}</Markdown>,
      ),
    )
    .join("\n");
  expect(apart).toBe(whole);
  // Text streaming in leaves every run but the last as it was.
  expect(parts(`${text}\n\nmore`)!.slice(0, 2)).toEqual(split.slice(0, 2));
});

test("footnotes read as written, with no heading or back link", () => {
  const out = html("Footnote[^1].\n\n[^1]: the note");
  expect(out).not.toContain("<section");
  expect(out).not.toContain("<sup");
  expect(out).not.toContain("Footnotes");
  expect(out).not.toContain("↩");
  expect(out).toContain("Footnote[^1].");
  expect(out).toContain("[^1]: the note");
});

test("quotes, links and emphasis nest only so deep", () => {
  const depth = (markup: string) => {
    let deepest = 0;
    let at = 0;
    for (const m of markup.matchAll(/<(\/?)blockquote/g)) {
      at += m[1] ? -1 : 1;
      deepest = Math.max(deepest, at);
    }
    return deepest;
  };
  // The fourth reads as written.
  const deep = html(">>>> deep");
  expect(depth(deep)).toBe(3);
  expect(deep).toContain("&gt; deep");
  expect(depth(html("> a\n> > b\n> > > c\n> > > > d"))).toBe(3);
  // Deeper than a person writes is plain text.
  expect(depth(html(`${">".repeat(5000)} deep`))).toBe(0);

  // A link's label never holds another link.
  const nested = html(`${"[".repeat(12)}x${"](https://a.test)".repeat(12)}`);
  expect(nested).toContain("<a ");
  expect(nested).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<a /s);
  expect(html(`${"[".repeat(3000)}x${"](https://a.test)".repeat(3000)}`)).not.toContain("<a ");

  // Five kinds of emphasis, each inside the last: the fifth reads as written.
  const five = shape(html("*a _b **c __d ~~e~~ d__ c** b_ a*"));
  expect(five).toBe(
    "<div><p><em>a <em>b <strong>c <strong>d ~~e~~ d</strong> c</strong> b</em> a</em></p></div>",
  );
});
