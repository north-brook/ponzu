import { describe, expect, test } from "bun:test";
import { applyOp, type Doc, type Op } from "./doc.ts";
import { el, SAMPLE_OPS, sampleDoc, text } from "./fixtures/ops.ts";
import { type Random, random } from "./fixtures/random.ts";
import { randomOp } from "./fixtures/random-ops.ts";
import { Sequencer, wire } from "./fixtures/sequencer.ts";
import {
  assertSearchTerm,
  docSearchChanges,
  docSearchEntries,
  findMatches,
  foldForSearch,
  type Match,
  SEARCH_IGNORED_OPS,
  SEARCH_TEXT_MAX,
  type SearchEntry,
  type SearchKind,
  searchTerms,
  searchText,
  segments,
  snippet,
} from "./search.ts";
import type { Actor } from "./types.ts";

const codePoints = (s: string) => [...s].length;
/** No lone surrogate: what String.prototype.isWellFormed says, which this tsconfig's lib lacks. */
const wellFormed = (s: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const ALPHABET = /^[\p{L}\p{M}\p{N} ]*$/u;

describe("foldForSearch", () => {
  const table: [string, string, string][] = [
    ["ASCII", "Hello, World! #412 100%", "hello  world   412 100 "],
    ["ASCII punctuation", "a_b%c\\d.e*f(g)", "a b c d e f g "],
    ["Latin-1", "Crème Brûlée Ñandú Øre Æble", "creme brulee nandu øre æble"],
    ["Vietnamese stacked marks", "Tiếng Việt Đà Nẵng", "tieng viet đa nang"],
    ["Turkish dotted and dotless I", "İstanbul ılık IŞIK", "istanbul ılık isik"],
    ["German sharp s", "Straße STRAẞE", "straße straße"],
    ["Greek, final sigma folded to sigma", "ΟΔΟΣ οδός Ἀθῆναι", "οδοσ οδοσ αθηναι"],
    ["Cyrillic", "Привет Ёлка Й", "привет елка и"],
    ["Hangul stays whole", "한국어 가", "한국어 가"],
    ["CJK, where the long vowel mark is a letter", "東京タワー、検索。", "東京タワー 検索 "],
    ["emoji: two spaces for a pair", "hi 🎉!", "hi    "],
    ["a ZWJ sequence", "a👩‍💻b", "a     b"],
    ["a mark on its own is a space, one on a letter stays", "\u0301x\u0308 \u0301", " x\u0308  "],
    [
      "Devanagari vowel signs stay in the word",
      "\u0939\u093f\u0928\u094d\u0926\u0940 \u092a\u093e\u0920",
      "\u0939\u093f\u0928\u094d\u0926\u0940 \u092a\u093e\u0920",
    ],
    [
      "Hebrew points stay in the word",
      "\u05e2\u05b4\u05d1\u05b0\u05e8\u05b4\u05d9\u05ea",
      "\u05e2\u05b4\u05d1\u05b0\u05e8\u05b4\u05d9\u05ea",
    ],
    ["a mark after an emoji or a space is a space", "\ud83c\udf89\u0301 \u20dd", "     "],
    [
      "an astral mark on an astral letter stays",
      "\ud804\udc13\ud804\udc38 \ud804\udc38",
      "\ud804\udc13\ud804\udc38   ",
    ],
    ["control characters", "a\tb\nc\u0001d\u007f", "a b c d "],
    ["lone surrogates", "a\ud800b\udc00", "a b "],
    ["an astral letter lowercases", "𐐀𐐨", "𐐨𐐨"],
    ["mathematical letters are letters", "𝐀𝟏", "𝐀𝟏"],
    ["NBSP and other spaces", "a\u00a0b\u2003c", "a b c"],
  ];
  for (const [name, input, folded] of table) {
    test(name, () => {
      expect(foldForSearch(input)).toBe(folded);
      expect(foldForSearch(input).length).toBe(input.length);
    });
  }

  test("10,000 strings from every plane keep their length, and the alphabet holds", () => {
    const r = random(0x5ea4c4);
    for (let n = 0; n < 10_000; n++) {
      const input = randomString(r, 1 + r.int(24));
      const folded = foldForSearch(input);
      expect(folded.length).toBe(input.length);
      expect(ALPHABET.test(folded)).toBe(true);
      // Every code point keeps its width, so offsets line up one for one.
      const inPoints = [...input];
      const outPoints = [...folded];
      let a = 0;
      let b = 0;
      let split = 0;
      let inWord = false;
      while (a < inPoints.length) {
        const ch = inPoints[a]!;
        const out = outPoints[b]!;
        const mark = /^\p{M}$/u.test(ch);
        // A mark is kept exactly when it sits on a letter, a digit or a mark kept so.
        if (mark) expect(out === ch).toBe(inWord);
        if (out.length === ch.length) {
          b += 1;
          if (!mark) inWord = out !== " ";
        } else {
          // An astral code point that is not a letter, a digit or a kept mark: two spaces.
          expect(ch.length).toBe(2);
          expect(/^[\p{L}\p{N}]$/u.test(ch)).toBe(false);
          expect(out + outPoints[b + 1]).toBe("  ");
          b += 2;
          split += 1;
          if (!mark) inWord = false;
        }
        a += 1;
      }
      expect(b).toBe(outPoints.length);
      // Code points are kept except for those, each of which gives two.
      expect(codePoints(folded)).toBe(codePoints(input) + split);
      // No folded word starts with a mark.
      expect(/(^| )\p{M}/u.test(folded)).toBe(false);
      // Folding what is folded changes nothing, so a stored fold and a query's agree.
      expect(foldForSearch(folded)).toBe(folded);
    }
  });
});

/** A string drawn from every plane, with lone surrogates and marks more likely than chance. */
function randomString(r: Random, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const roll = r.int(10);
    if (roll === 0) out += String.fromCharCode(0xd800 + r.int(0x800));
    else if (roll === 1) out += String.fromCharCode(0x300 + r.int(0x70));
    else if (roll < 4) out += String.fromCharCode(r.int(0x80));
    else if (roll < 7) out += String.fromCharCode(r.int(0x10000));
    else out += String.fromCodePoint(0x10000 + r.int(0x100000));
  }
  return out;
}

describe("searchText", () => {
  test("is NFC", () => {
    expect(searchText("e\u0301")).toBe("\u00e9");
  });

  test("clips to SEARCH_TEXT_MAX without splitting a surrogate pair", () => {
    expect(searchText("a".repeat(SEARCH_TEXT_MAX + 5)).length).toBe(SEARCH_TEXT_MAX);
    const astral = `${"a".repeat(SEARCH_TEXT_MAX - 1)}🎉`;
    expect(searchText(astral)).toBe("a".repeat(SEARCH_TEXT_MAX - 1));
    expect(searchText("short")).toBe("short");
  });

  test("a lone surrogate becomes U+FFFD, keeping the length, and a pair is kept", () => {
    expect(searchText("a\ud800b\udc00🎉\udbff")).toBe("a�b�🎉�");
    expect(searchText(`${"a".repeat(SEARCH_TEXT_MAX - 1)}\ud800x`)).toBe(
      `${"a".repeat(SEARCH_TEXT_MAX - 1)}�`,
    );
  });
});

describe("searchTerms", () => {
  const words = (q: string) => searchTerms(q).map((t) => t.words);

  test("words, and quoted phrases as one term", () => {
    expect(words('hero "dark mode" shop')).toEqual([["hero"], ["dark", "mode"], ["shop"]]);
    expect(words("“Dark  Mode” x")).toEqual([["dark", "mode"], ["x"]]);
  });

  test("an unclosed quote runs to the end", () => {
    expect(words('hero "dark mode')).toEqual([["hero"], ["dark", "mode"]]);
  });

  test("keeps the first eight, dropping repeats and empties", () => {
    expect(words("a b c d e f g h i j")).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g"],
      ["h"],
    ]);
    expect(words('Hero hero HÉRO "" " "')).toEqual([["hero"]]);
  });

  test("punctuation goes: #412 is 412, 100% is 100, and punctuation alone is nothing", () => {
    expect(words("#412")).toEqual([["412"]]);
    expect(words("100%")).toEqual([["100"]]);
    expect(searchTerms("%_\\.*?")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });

  test("short is a single word of fewer than three code points", () => {
    expect(searchTerms('ab abc 𝐀𝐁 "a b"')).toEqual([
      { words: ["ab"], short: true },
      { words: ["abc"], short: false },
      { words: ["𝐀𝐁"], short: true },
      { words: ["a", "b"], short: false },
    ]);
  });

  test("no term ever carries a LIKE or regex metacharacter", () => {
    const r = random(7);
    const nasty = ["%", "_", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "^", "$", "|", "{"];
    for (let n = 0; n < 2_000; n++) {
      let q = "";
      for (let i = 0; i < 12; i++) q += r.chance(0.4) ? r.pick(nasty) : randomString(r, 1);
      for (const term of searchTerms(q)) {
        expect(() => assertSearchTerm(term)).not.toThrow();
        for (const w of term.words) for (const ch of nasty) expect(w.includes(ch)).toBe(false);
      }
    }
  });

  test("assertSearchTerm refuses anything but letters and digits", () => {
    expect(() => assertSearchTerm({ words: ["a%"], short: false })).toThrow();
    expect(() => assertSearchTerm({ words: ["a b"], short: false })).toThrow();
    expect(() => assertSearchTerm({ words: [], short: false })).toThrow();
    expect(() => assertSearchTerm({ words: ["é1"], short: false })).not.toThrow();
  });
});

describe("findMatches", () => {
  const m = (text: string, query: string) => findMatches(text, searchTerms(query));

  test("a word marks every occurrence, in the original's offsets", () => {
    expect(m("Hero hero, HÉRO", "hero")).toEqual([
      [0, 4],
      [5, 9],
      [11, 15],
    ]);
    expect(m("aaaa", "aaa")).toEqual([[0, 3]]);
  });

  test("a short term matches only at a word start", () => {
    expect(m("Brand ad, adapt", "ad")).toEqual([
      [6, 8],
      [10, 12],
    ]);
    expect(m("Ad", "ad")).toEqual([[0, 2]]);
    expect(m("Head lead", "ad")).toEqual([]);
    expect(m("Head lead", "ead")).toEqual([
      [1, 4],
      [6, 9],
    ]);
  });

  test("a phrase marks its words in order, one or more spaces apart", () => {
    expect(m("Dark mode, dark  MODE, mode dark", '"dark mode"')).toEqual([
      [0, 9],
      [11, 21],
    ]);
    expect(m("dark-mode", '"dark mode"')).toEqual([[0, 9]]);
  });

  test("overlapping and touching matches merge, and are sorted", () => {
    expect(m("shopping", "pping shop")).toEqual([[0, 8]]);
    expect(m("abc def", "def abc")).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  test("offsets carry back across accents, astral characters and İ", () => {
    const t = "🎉 İstanbul café";
    const [match] = m(t, "cafe");
    expect(t.slice(...(match as [number, number]))).toBe("café");
    expect(t.slice(...(m(t, "istanbul")[0] as [number, number]))).toBe("İstanbul");
  });

  test("a word written with vowel signs is one term, and matches whole", () => {
    expect(searchTerms("हिन्दी")).toEqual([{ words: ["हिन्दी"], short: false }]);
    expect(m("नमस्ते हिन्दी", "हिन्दी")).toEqual([[7, 13]]);
    expect(m("हिन्दी", "हि")).toEqual([[0, 2]]);
  });

  test("no terms, no matches", () => {
    expect(findMatches("anything", [])).toEqual([]);
  });
});

describe("snippet", () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => `word${i}`)
      .join(" ")
      .slice(0, n);

  test("text that fits is whole, with line breaks and tabs as spaces", () => {
    expect(snippet("a\nb\tc\r", [[0, 1]])).toEqual({ text: "a b c ", matches: [[0, 1]] });
  });

  test("a match at offset 0 cuts only the end, at a space", () => {
    const text = long(400);
    const out = snippet(text, [[0, 5]]);
    expect(out.text.startsWith("word0")).toBe(true);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(141);
    expect(text.startsWith(out.text.slice(0, -1))).toBe(true);
    expect(text[out.text.length - 1]).toBe(" ");
    expect(out.matches).toEqual([[0, 5]]);
  });

  test("a match at the end cuts only the start, after a space, and shifts the matches", () => {
    const text = `${long(400)} target`;
    const at = text.length - 6;
    const out = snippet(text, [[at, text.length]]);
    expect(out.text.startsWith("…")).toBe(true);
    expect(out.text.endsWith("target")).toBe(true);
    const [s, e] = out.matches[0]!;
    expect(out.text.slice(s, e)).toBe("target");
    expect(out.text[1]).not.toBe(" ");
    expect(text.slice(text.length - (out.text.length - 1))).toBe(out.text.slice(1));
    expect(text[text.length - out.text.length]).toBe(" ");
  });

  test("a match in the middle starts about 40 characters before it", () => {
    const text = long(600);
    const at = text.indexOf("word50 ");
    const out = snippet(text, [[at, at + 6]]);
    const [s, e] = out.matches[0]!;
    expect(out.text.slice(s, e)).toBe("word50");
    expect(s).toBeLessThanOrEqual(41);
    expect(s).toBeGreaterThan(30);
  });

  test("a match longer than the width is cut with the window, and later matches dropped", () => {
    const text = `start ${"x".repeat(300)} later`;
    const out = snippet(text, [
      [6, 306],
      [307, 312],
    ]);
    expect(out.text).toBe(`start ${"x".repeat(134)}…`);
    expect(out.matches).toEqual([[6, 140]]);
  });

  test("no cut splits a surrogate pair", () => {
    const text = "🎉".repeat(200);
    for (const at of [0, 1, 100, 101, 398]) {
      const out = snippet(text, [[at, at + 2]]);
      expect(wellFormed(out.text)).toBe(true);
    }
    const mixed = `a${"🎉".repeat(150)}`;
    expect(wellFormed(snippet(mixed, [[1, 3]]).text)).toBe(true);
  });

  test("text without matches is cut from its start", () => {
    const out = snippet(long(300), []);
    expect(out.text.startsWith("word0")).toBe(true);
    expect(out.matches).toEqual([]);
  });
});

// The studio's cases, moved here with the function.
describe("segments", () => {
  test("a result's text splits at its matches", () => {
    expect(segments("Quieter shop hero", [[13, 17]])).toEqual([
      { text: "Quieter shop ", match: false },
      { text: "hero", match: true },
    ]);
    expect(segments("Hero, dark", [[0, 4]])).toEqual([
      { text: "Hero", match: true },
      { text: ", dark", match: false },
    ]);
  });

  test("matches out of order, overlapping or past the end are tolerated", () => {
    expect(
      segments("abcdef", [
        [4, 9],
        [0, 2],
        [1, 3],
      ]),
    ).toEqual([
      { text: "ab", match: true },
      { text: "c", match: true },
      { text: "d", match: false },
      { text: "ef", match: true },
    ]);
    expect(segments("abc", [])).toEqual([{ text: "abc", match: false }]);
  });

  test("leaves the matches it was given in their order", () => {
    const matches: Match[] = [
      [4, 5],
      [0, 1],
    ];
    segments("abcdef", matches);
    expect(matches).toEqual([
      [4, 5],
      [0, 1],
    ]);
  });
});

describe("docSearchEntries", () => {
  test("the sample canvas: its name, pages, board and comment", () => {
    expect(docSearchEntries(sampleDoc())).toEqual([
      {
        kind: "canvas",
        ref: "",
        text: "Sample",
        context: { kind: "canvas" },
        author: null,
        at: null,
      },
      {
        kind: "page",
        ref: "pg_1",
        text: "First",
        context: { kind: "page" },
        author: null,
        at: null,
      },
      {
        kind: "page",
        ref: "pg_2",
        text: "Second",
        context: { kind: "page" },
        author: null,
        at: null,
      },
      {
        kind: "board",
        ref: "ab_1",
        text: "Home",
        context: { kind: "board", pageId: "pg_1" },
        author: null,
        at: null,
      },
      {
        kind: "comment",
        ref: "th_1/m_1",
        text: "Tighter?",
        context: {
          kind: "comment",
          threadId: "th_1",
          messageId: "m_1",
          pageId: "pg_1",
          artboardId: "ab_1",
          resolved: false,
        },
        author: { kind: "user", id: null, name: "Ada" },
        at: 1000,
      },
    ]);
  });

  test("a pin on the open canvas, a resolved thread and an author with an id", () => {
    const doc = sampleDoc();
    applyOp(doc, SAMPLE_OPS["thread.create"]);
    doc.threads[1]!.status = "resolved";
    doc.threads[1]!.messages[0]!.author = { kind: "agent", name: "Claude", id: "agent_1" };
    const entry = docSearchEntries(doc).find((e) => e.ref === "th_2/m_2");
    expect(entry).toEqual({
      kind: "comment",
      ref: "th_2/m_2",
      text: "Which?",
      context: {
        kind: "comment",
        threadId: "th_2",
        messageId: "m_2",
        pageId: "pg_2",
        artboardId: null,
        resolved: true,
      },
      author: { kind: "agent", id: "agent_1", name: "Claude" },
      at: 2000,
    });
  });

  test("empty text gives no entry, and long text is clipped", () => {
    const doc = sampleDoc();
    doc.name = "";
    doc.pages[1]!.name = "x".repeat(SEARCH_TEXT_MAX + 10);
    const entries = docSearchEntries(doc);
    expect(entries.some((e) => e.kind === "canvas")).toBe(false);
    expect(entries.find((e) => e.ref === "pg_2")!.text.length).toBe(SEARCH_TEXT_MAX);
  });

  test("repeated ids give one entry each, the first in document order", () => {
    const doc = sampleDoc();
    const twin = (name: string) => ({
      id: "ab_1",
      name,
      x: 0,
      y: 0,
      root: el("ab_1", "section", [text("x")]),
    });
    doc.pages[0]!.artboards.push(twin("Second home"));
    doc.pages[1]!.artboards.push(twin("Third home"));
    doc.pages.push({ id: "pg_1", name: "Again", artboards: [twin("Fourth")] });
    doc.threads.push(structuredClone(doc.threads[0]!));
    doc.threads[1]!.messages[0]!.text = "Twin";
    doc.threads[1]!.messages.push({ ...doc.threads[1]!.messages[0]!, id: "m_twin", text: "Lost" });
    doc.threads[0]!.messages.push({ ...doc.threads[0]!.messages[0]!, text: "Echo" });

    const entries = docSearchEntries(doc);
    const keys = entries.map((e) => `${e.kind}:${e.ref}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(entries.find((e) => e.kind === "board")).toMatchObject({
      text: "Home",
      context: { pageId: "pg_1" },
    });
    expect(entries.find((e) => e.ref === "pg_1")!.text).toBe("First");
    expect(entries.find((e) => e.ref === "th_1/m_1")!.text).toBe("Tighter?");
    // The second thread of an id is one no op reaches, so none of its messages is offered.
    expect(entries.some((e) => e.ref === "th_1/m_twin")).toBe(false);
  });

  test("an old message with no author, or a broken time, still gives an entry", () => {
    const doc = sampleDoc();
    const message = doc.threads[0]!.messages[0]! as unknown as Record<string, unknown>;
    delete message.author;
    message.createdAt = Number.NaN;
    expect(docSearchEntries(doc).find((e) => e.kind === "comment")).toMatchObject({
      author: null,
      at: null,
    });
  });
});

describe("docSearchChanges", () => {
  test("node-only ops take the fast path and give null", () => {
    for (const kind of SEARCH_IGNORED_OPS) {
      const doc = sampleDoc();
      const op = SAMPLE_OPS[kind];
      const before = structuredClone(doc);
      applyOp(doc, op);
      expect(docSearchChanges(before, doc, [op])).toBeNull();
      expect(docSearchEntries(doc)).toEqual(docSearchEntries(before));
    }
    expect(docSearchChanges(sampleDoc(), sampleDoc(), [])).toBeNull();
    const nested: Op = {
      op: "batch",
      ops: [SAMPLE_OPS.style, { op: "batch", ops: [SAMPLE_OPS.note] }],
    };
    expect(docSearchChanges(sampleDoc(), sampleDoc(), [nested])).toBeNull();
  });

  test("a name op on a board's root leaves the fast path and renames the board", () => {
    const doc = sampleDoc();
    const before = structuredClone(doc);
    const op: Op = { op: "name", id: "ab_1", name: "Landing" };
    applyOp(doc, op);
    expect(docSearchChanges(before, doc, [op])).toEqual({
      upsert: [
        {
          kind: "board",
          ref: "ab_1",
          text: "Landing",
          context: { kind: "board", pageId: "pg_1" },
          author: null,
          at: null,
        },
      ],
      remove: [],
    });
  });

  test("a name op on an inner node leaves the fast path but changes nothing", () => {
    const doc = sampleDoc();
    const before = structuredClone(doc);
    applyOp(doc, SAMPLE_OPS.name);
    expect(docSearchChanges(before, doc, [SAMPLE_OPS.name])).toEqual({ upsert: [], remove: [] });
  });

  test("a fast-path op inside a batch with one that isn't leaves the fast path", () => {
    const op: Op = { op: "batch", ops: [SAMPLE_OPS.style, SAMPLE_OPS["file.rename"]] };
    const doc = sampleDoc();
    const before = structuredClone(doc);
    applyOp(doc, op);
    expect(docSearchChanges(before, doc, [op])?.upsert.map((e) => e.text)).toEqual(["Renamed"]);
  });

  test("deleting a page removes its entry and its boards', and moves its comments' context", () => {
    const doc = sampleDoc();
    const before = structuredClone(doc);
    applyOp(doc, SAMPLE_OPS["page.delete"]);
    const changes = docSearchChanges(before, doc, [SAMPLE_OPS["page.delete"]])!;
    expect(changes.remove).toEqual([
      { kind: "page", ref: "pg_1" },
      { kind: "board", ref: "ab_1" },
    ]);
    expect(changes.upsert).toEqual([
      expect.objectContaining({
        ref: "th_1/m_1",
        context: expect.objectContaining({ pageId: null }),
      }),
    ]);
  });

  test("an entry whose author or time alone changed is upserted", () => {
    const op = SAMPLE_OPS["thread.update"];
    const before = sampleDoc();
    const byId = structuredClone(before);
    byId.threads[0]!.messages[0]!.author = { kind: "user", id: "user_ada", name: "Ada" };
    expect(docSearchChanges(before, byId, [op])!.upsert.map((e) => e.author)).toEqual([
      { kind: "user", id: "user_ada", name: "Ada" },
    ]);
    const later = structuredClone(before);
    later.threads[0]!.messages[0]!.createdAt = 5000;
    expect(docSearchChanges(before, later, [op])!.upsert.map((e) => e.at)).toEqual([5000]);
  });

  test("every op kind, applied incrementally, matches the entries computed whole", () => {
    for (const kind of Object.keys(SAMPLE_OPS) as Op["op"][]) {
      const doc = sampleDoc();
      const before = structuredClone(doc);
      const op = SAMPLE_OPS[kind];
      applyOp(doc, op);
      expect(fold(docSearchEntries(before), docSearchChanges(before, doc, [op]))).toEqual(
        index(docSearchEntries(doc)),
      );
    }
  });

  test("500 random sequences: incremental changes equal the entries of the doc, undo included", () => {
    const actor: Actor = { kind: "user", id: "user_ada", name: "Ada" };
    const r = random(0x5ea2c4);
    let fresh = 0;
    const next = () => `x${(fresh++).toString(36)}`;
    let steps = 0;
    let undos = 0;
    let slow = 0;
    for (let run = 0; run < 500; run++) {
      const api = new Sequencer(startDoc(r, next));
      let entries = index(docSearchEntries(api.doc));
      const undoable: Op[] = [];
      for (let i = 0; i < 24; i++) {
        let op: Op;
        let undo = false;
        if (undoable.length && r.chance(0.25)) {
          op = undoable.pop()!;
          undo = true;
        } else {
          op = randomOp(r, api.doc, next);
        }
        const before = wire(api.doc);
        const result = api.commit([{ id: `op_${next()}`, op }], actor);
        const committed = result.committed[0];
        if (!committed) continue;
        steps++;
        if (undo) undos++;
        else undoable.push(applyOp(wire(before), committed.op));
        const changes = docSearchChanges(before, api.doc, [committed.op]);
        if (changes) {
          slow++;
          const removed = new Set(changes.remove.map((k) => `${k.kind}:${k.ref}`));
          for (const e of changes.upsert) expect(removed.has(`${e.kind}:${e.ref}`)).toBe(false);
          expect(new Set(changes.upsert.map((e) => `${e.kind}:${e.ref}`)).size).toBe(
            changes.upsert.length,
          );
        }
        entries = fold([...entries.values()], changes);
        expect(entries).toEqual(index(docSearchEntries(api.doc)));
      }
    }
    // The run did what it says: many steps, undos among them, and both paths taken.
    expect(steps).toBeGreaterThan(5_000);
    expect(undos).toBeGreaterThan(500);
    expect(slow).toBeGreaterThan(1_000);
    expect(steps - slow).toBeGreaterThan(1_000);
  });

  test("1,000 random applications of each fast-path kind leave the entries equal", () => {
    const r = random(0xfa57);
    let fresh = 0;
    const next = () => `y${(fresh++).toString(36)}`;
    const counts = new Map<string, number>(SEARCH_IGNORED_OPS.map((k) => [k, 0]));
    let doc = startDoc(r, next);
    for (let guard = 0; guard < 400_000; guard++) {
      if ([...counts.values()].every((n) => n >= 1_000)) break;
      if (guard % 200 === 0) doc = startDoc(r, next);
      const op = randomOp(r, doc, next);
      if (op.op === "batch") continue;
      const before = wire(doc);
      try {
        applyOp(doc, op);
      } catch {
        continue;
      }
      if (!counts.has(op.op)) continue;
      counts.set(op.op, counts.get(op.op)! + 1);
      expect(docSearchChanges(before, doc, [op])).toBeNull();
      expect(docSearchEntries(doc)).toEqual(docSearchEntries(before));
    }
    for (const [kind, n] of counts) expect([kind, n >= 1_000]).toEqual([kind, true]);
  });
});

/** A random starting canvas: the sample, grown by some random ops, sometimes with repeated ids. */
function startDoc(r: Random, next: () => string): Doc {
  const doc = sampleDoc();
  for (let i = 0; i < 6; i++) {
    try {
      applyOp(doc, randomOp(r, doc, next));
    } catch {}
  }
  if (r.chance(0.3) && doc.pages[0]?.artboards[0]) {
    const board = structuredClone(doc.pages[0].artboards[0]);
    board.name = next();
    (doc.pages[1] ?? doc.pages[0]).artboards.push(board);
  }
  if (r.chance(0.2) && doc.pages[0])
    doc.pages.push({ ...structuredClone(doc.pages[0]), name: next() });
  if (r.chance(0.2) && doc.threads[0]) doc.threads.push(structuredClone(doc.threads[0]));
  return doc;
}

type Index = Map<string, SearchEntry>;

function index(entries: readonly SearchEntry[]): Index {
  const out: Index = new Map();
  for (const e of entries) {
    const key = `${e.kind}:${e.ref}`;
    if (out.has(key)) throw new Error(`Two entries for ${key}.`);
    out.set(key, e);
  }
  return sorted(out);
}

function fold(
  entries: readonly SearchEntry[],
  changes: { upsert: SearchEntry[]; remove: { kind: SearchKind; ref: string }[] } | null,
): Index {
  const out = new Map(entries.map((e) => [`${e.kind}:${e.ref}`, e]));
  for (const k of changes?.remove ?? []) out.delete(`${k.kind}:${k.ref}`);
  for (const e of changes?.upsert ?? []) out.set(`${e.kind}:${e.ref}`, e);
  return sorted(out);
}

function sorted(map: Index): Index {
  return new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
