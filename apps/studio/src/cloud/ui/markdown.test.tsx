import { expect, test } from "bun:test";
import * as core from "micromark-core-commonmark";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { linearEmphasis, work as pairing } from "./emphasis.ts";
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
    "ponzu://canvas/1",
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

test("a link to a canvas's page or board is held to the same rules as any other", () => {
  // Followed in place only once it is a safe https address (place-link.test.tsx): what the rules
  // refuse stays text however much it looks like one of ours.
  for (const href of [
    "javascript:location='https://ponzu.design/canvases/cnv_1?artboard=ab_1'",
    "ponzu://canvas/cnv_1?artboard=ab_1",
    "/canvases/cnv_1?artboard=ab_1",
    "data:text/html,https://ponzu.design/canvases/cnv_1",
  ]) {
    expect(html(`[Note: Pricing](${href})`)).not.toContain("<a");
  }
  // And as an image, it still loads nothing.
  expect(html("![x](https://ponzu.design/canvases/cnv_1?artboard=ab_1)")).not.toContain("<img");
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
 * `![` 5 s at 64 KB, 32 KB of `abc* ` 0.32 to 0.75 s before emphasis.ts) and runs out of stack on
 * a line of nested lists. `parseable` sends the first and last kinds to plain text, and
 * emphasis.ts pairs emphasis and strikethrough in linear time; what is drawn, shaped to sit at
 * each limit, must cost in step with its length. So each shape is drawn once at the most
 * `parseable` lets through (the whole limit, or 4,096 characters for text dense with marks) and
 * eight times at an eighth of that: the same work if its cost grows with its length, eight times
 * as much if with the square. The long draw may do at most one and a half times the work of the
 * eight short ones; every shape here measures about 1 or less, and `abc* ` measured 7.9 before.
 *
 * Work is counted, never timed, so a slow or busy machine can't move it: every character
 * micromark's own constructs consume (so one that backs up and reads text again counts it again),
 * every read and write of the events each of its resolvers is handed, which is where the square
 * was, and every step of emphasis.ts's own pairing, which reads no events while it searches its
 * stack of openers (without its floors, `_a b* ` measured 7.6 here). Not counted: GitHub's table, task list and bare address constructs, which are made
 * anew for each parse, and the stages after micromark (the tree's plugins, the markup, React),
 * which visit each node a fixed number of times; `parseable` keeps out what made those slow.
 */
const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const hostile: [(n: number) => string, number?][] = [
  [(n) => fill("*a ", n)],
  [(n) => fill("_a ", n)],
  [(n) => fill("**a ", n)],
  [(n) => fill("~~a ", n)],
  [(n) => fill("[a ", n)],
  [(n) => fill("![a ", n)],
  [(n) => fill("![", n)],
  [(n) => fill("*_~~[`a ", n)],
  [(n) => fill("| a ", n)],
  [(n) => fill("- [ ", n)],
  [(n) => `http://a${".".repeat(n - 9)}x`],
  [(n) => `www.a${".".repeat(n - 6)}x`],
  [(n) => `- ${fill("*a ", n - 2)}`],
  [(n) => `${">".repeat(n - 5)} deep`],
  [(n) => `${fill("- ", n - 1)}x`],
  [(n) => `${fill("*_", (n - 1) / 2)}x${fill("_*", (n - 1) / 2)}`],
  // Brackets with no partner, which GFM's footnotes scanned back over with the square of their
  // number, and short lines, in one paragraph or each its own, as many as `parseable` allows.
  [(n) => fill("a]", n)],
  [(n) => fill("x]\n", n), 3000],
  [(n) => fill("a ]", n)],
  [(n) => fill("b]a", n)],
  [(n) => fill("a\n", n), 2000],
  [(n) => fill("a\n\n", n), 3000],
  [(n) => fill("[^a] ", n)],
  // Closing marks with nothing to close, each of which micromark walked back over the whole
  // paragraph to look for its partner, and marks the rule of three keeps apart.
  [(n) => fill("abc* ", n)],
  [(n) => fill("abc_ ", n)],
  [(n) => fill("abcdefgh~~ ", n)],
  [(n) => fill("abcdefgh~ ", n)],
  // Openers of one kind and closers of another, which every closer would search past without
  // emphasis.ts's floors.
  [(n) => fill("_a b* ", n)],
  [(n) => fill("a*_b ", n)],
  [(n) => fill("_a*_b* ", n)],
  [(n) => fill("~a b~~ ", n)],
  [(n) => fill("a**** b* ", n)],
  [(n) => fill("*a **b c* ", n)],
  [(n) => fill("**a *b ~~c* d** ", n)],
  [(n) => fill("*_*_*_*_a_*_*_*_* b ", n)],
  [(n) => fill("*_*_*_*_*_*_*_*_a a ", n)],
  [(n) => `${fill("*a ", n / 2)}${fill("b* ", n / 2)}`],
  [(n) => `${fill("~~a ", n / 2)}${fill("b~~ ", n / 2)}`],
  [(n) => fill("[*a* ~~b~~](x) ", n)],
  // Just under the limits.
  [(n) => fill(`${"[".repeat(16)}${"a ".repeat(100)}`, n)],
  [(n) => fill(`${"*_".repeat(8)}${"a ".repeat(100)}`, n)],
  [(n) => fill(`${"*_".repeat(4)}a${"_*".repeat(4)} ${"b ".repeat(80)}`, n)],
  [(n) => fill(`http://a${".".repeat(15)}b `, n)],
  [(n) => fill("*a* bcde ", n)],
  [(n) => fill(`${"x]\n".repeat(1000)}\n`, n)],
  [(n) => `${"a\n\n".repeat(1000)}${fill("word ", n - 3000)}`],
  [(n) => `\`\`\`\n${fill("a\n", n - 4)}`],
  [(n) => fill("- - - - x\n", n), 10_000],
  [(n) => fill(Array.from({ length: 30 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"), n)],
];

/** More shapes, made from the marks that pair, so ones nobody thought of are tried too. */
function generated(count: number): string[] {
  const marks = ["*", "**", "_", "__", "~", "~~", "a", "bc", " ", " ", ".", "(", "[", "](x)", "`"];
  let state = 42;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  return Array.from({ length: count }, () => {
    let unit = "";
    const length = 2 + Math.floor(next() * 8);
    for (let i = 0; i < length; i++) unit += marks[Math.floor(next() * marks.length)];
    return unit;
  });
}
for (const unit of generated(40)) hostile.push([(n) => fill(unit, n)]);

/** Work counted while `draw` runs: characters consumed and events read or written. */
function counted(draw: () => void, most = Infinity): number {
  let work = 0;
  const tick = () => {
    if (++work > most) throw new Error(`more than ${most} steps of work`);
  };
  const events = (list: unknown[]) =>
    new Proxy(list, {
      get(target, key, receiver) {
        tick();
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        tick();
        return Reflect.set(target, key, value, receiver);
      },
    });
  type Hooked = Record<string, unknown>;
  type Step = (this: unknown, ...args: unknown[]) => unknown;
  const constructs = [
    ...Object.values(core),
    ...Object.values(linearEmphasis.text ?? {}),
  ] as unknown as Hooked[];
  const undo: (() => void)[] = [];
  const hook = (
    construct: Hooked,
    key: string,
    wrap: (original: Step) => (this: unknown, ...args: never[]) => unknown,
  ) => {
    const original = construct[key];
    if (typeof original !== "function") return;
    construct[key] = wrap(original as Step);
    undo.push(() => {
      construct[key] = original;
    });
  };
  for (const construct of new Set(constructs)) {
    if (!construct || typeof construct !== "object") continue;
    for (const key of ["resolve", "resolveAll", "resolveTo"]) {
      hook(
        construct,
        key,
        (original) =>
          function (this: unknown, list: unknown[], context: unknown) {
            const seen = events(list);
            const out = original.call(this, seen, context);
            return out === seen ? list : out;
          },
      );
    }
    hook(
      construct,
      "tokenize",
      (original) =>
        function (
          this: unknown,
          effects: { consume(code: unknown): void },
          ok: unknown,
          no: unknown,
        ) {
          const consume = (code: unknown) => {
            tick();
            effects.consume(code);
          };
          return original.call(this, { ...effects, consume }, ok, no);
        },
    );
  }
  const paired = pairing.steps;
  try {
    draw();
  } finally {
    for (const put of undo) put();
  }
  return work + pairing.steps - paired;
}

/** The most of a shape `parseable` lets through: all it may be, or as much as dense marks may. */
const drawn = (make: (n: number) => string, most: number) =>
  [most, 4096].find((n) => parseable(make(n))) ?? most;

for (const [make, limit = PROSE_LIMIT - 1] of hostile) {
  const most = drawn(make, limit);
  const long = make(most);
  test(`hostile text costs in step with its length: ${JSON.stringify(long.slice(0, 20))}… at ${most}`, () => {
    expect(long.length).toBeLessThan(PROSE_LIMIT);
    const short = make(Math.floor(most / 8));
    const eight = counted(() => {
      for (let i = 0; i < 8; i++) html(short);
    });
    // A quadratic draw stops as soon as it is plainly one, rather than running on.
    const once = counted(() => html(long), Math.max(2 * eight, 1000));
    expect(once).toBeLessThanOrEqual(Math.max(1.5 * eight, 1000));
    // And a fixed amount for each character, whatever the shape (links cost the most, 65).
    expect(once).toBeLessThanOrEqual(128 * long.length);
  });
}

/*
 * Lines underlined as headings are the one shape left that costs more than its length: micromark
 * rewrites every event of a block for each heading underlined in it, so the work grows with the
 * square of their number. `parseable` allows 200, which keeps it to a fixed amount, here at its
 * worst: the most lines a block may have before them, then the most headings.
 */
test("headings underlined cost no more than parseable's limit on them allows", () => {
  for (const text of [
    "a\n=\n".repeat(200),
    "a\n-\n".repeat(200),
    `${"a\n".repeat(599)}${"a\n=\n".repeat(200)}`,
    `${fill("lorem ipsum dolor sit amet ", 15_000).replaceAll("amet ", "amet\n")}${"a\n=\n".repeat(200)}`,
    `${"a\n=\n".repeat(200)}${fill("word ", PROSE_LIMIT - 801)}`,
  ]) {
    expect(parseable(text)).toBe(true);
    expect(counted(() => html(text))).toBeLessThan(4_000_000);
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
