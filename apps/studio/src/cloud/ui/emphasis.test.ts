import { expect, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import type { Extension } from "micromark-util-types";
import { linearEmphasis, work } from "./emphasis.ts";

/*
 * emphasis.ts pairs the marks micromark pairs, in linear time. Proven here by comparing its tree
 * with micromark's own (core emphasis and GFM's strikethrough), positions and all, on text made
 * to find where they could part: every mark that pairs, links around and inside them, code spans,
 * escapes, line breaks, the punctuation that decides which way a mark faces, and the rest of
 * GitHub's flavour as markdown.ts reads it (tables, task lists, bare addresses). Set FUZZ_TEXTS,
 * FUZZ_LENGTH or FUZZ_SEED to try more: a million texts of up to 24 characters, 300,000 of up to
 * 80 and a million of up to 8 all matched when this was written.
 */
const flavour = (strikethrough: Extension) => ({
  extensions: [gfmAutolinkLiteral(), strikethrough, gfmTable(), gfmTaskListItem()],
  mdastExtensions: [
    gfmAutolinkLiteralFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ],
});
const theirs = (text: string) => JSON.stringify(fromMarkdown(text, flavour(gfmStrikethrough())));
const ours = (text: string) => JSON.stringify(fromMarkdown(text, flavour(linearEmphasis)));

const same = (text: string) => {
  const got = ours(text);
  const expected = theirs(text);
  // Name the text in the failure, since the trees alone don't say what made them.
  if (got !== expected) {
    expect(`${JSON.stringify(text)}: ${got}`).toBe(`${JSON.stringify(text)}: ${expected}`);
  }
};

/** A small, seeded generator, so a failure names a text that fails again. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("ordinary emphasis and strikethrough read as micromark reads them", () => {
  for (const text of [
    "*a* _b_ **c** __d__ ***e*** ~f~ ~~g~~",
    "*a **b** c*",
    "**a *b* c**",
    "*a _b **c __d ~~e~~ d__ c** b_ a*",
    "*a ~~b* c~~",
    "~~a *b~~ c*",
    "~~a *b* c~~ *d ~~e~~ f*",
    "[*a* ~~b~~](https://a.test) *c [d*](e) f*",
    "*a [b* c](d) e*",
    "foo***bar***baz",
    "*foo**bar**baz*",
    "**foo*bar*baz**",
    "foo*bar**baz***",
    "a * b * c",
    "snake_case_word and __init__",
    "~~~a~~~ ~a~~ ~~a~",
    "*a\nb*  \nc ~~d\ne~~",
    "`*a*` *`b`* \\*c\\* *d\\*",
    "***a* b** c",
    "*****a***** **a*b**",
    'a**"b"**c _"d"_e',
    "*(**a**)*",
    // Pairs a second look finds, once a pair has used part of a run (the rule of three).
    "** _**~****b(*~b_ ",
    "| **a** | ~~b~~ |\n| --- | --- |\n| *c* | https://a.test/*d* |",
    "- [x] **done** ~~not~~\n- [ ] *www.a.test*",
  ]) {
    same(text);
  }
});

test("generated text pairs as micromark pairs it", () => {
  const alphabet = ["*", "*", "*", "_", "_", "~", "~", "a", "b", " ", " ", ".", "[", "]", "(", ")"];
  const rarer = ["`", "\\", "\n", "!", "](x)", "**", "~~", '"', "  \n", "|", "www.a.b", "- [ ] "];
  const next = random(Number(process.env.FUZZ_SEED ?? 1));
  for (let i = 0; i < Number(process.env.FUZZ_TEXTS ?? 20_000); i++) {
    const length = 1 + Math.floor(next() * Number(process.env.FUZZ_LENGTH ?? 24));
    let text = "";
    for (let c = 0; c < length; c++) {
      text +=
        next() < 0.1
          ? rarer[Math.floor(next() * rarer.length)]
          : alphabet[Math.floor(next() * alphabet.length)];
    }
    same(text);
  }
});

test("pairing costs in step with the marks", () => {
  const steps = (text: string) => {
    work.steps = 0;
    ours(text);
    return work.steps;
  };
  // Closers with nothing to close, openers never closed, and pairs nested as deep as they go.
  for (const unit of ["abc* ", "abc~~ ", "*a ", "~~a ", "*_~", "a**** b* ", "*a _b "]) {
    const long = steps(unit.repeat(4096));
    const short = steps(unit.repeat(512));
    expect(long).toBeLessThanOrEqual(8.5 * short);
  }
  const nested = (n: number) => `${"*a _b ".repeat(n)}c${" d_ e*".repeat(n)}`;
  expect(steps(nested(4096))).toBeLessThanOrEqual(8.5 * steps(nested(512)));
});
