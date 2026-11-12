import { expect, test } from "bun:test";
import type { CheckRun } from "../model.ts";
import { changedSpans, orderChecks, parsePatch, type Span } from "./diff.ts";

const PATCH = `@@ -13,6 +13,5 @@ export function Hero() {
 export function Hero() {
   return (
-    <h1 className="hero-title">Plants that outlive your lease</h1>
-    <p>Hardy, slow-growing greenery, potted and delivered.</p>
+    <h1 className="hero-title">Slow plants, fast homes</h1>
     <HeroPhoto crop="wide" />
   );
@@ -40,3 +39,4 @@ export function Hero() {
 }
+
+export const measure = "38ch";

\\ No newline at end of file`;

test("a patch reads into numbered lines, with the unchanged lines between hunks folded", () => {
  const rows = parsePatch(PATCH);
  const brief = rows.map((r) =>
    r.kind === "fold" ? `fold ${r.lines}` : `${r.type} ${r.old ?? "-"} ${r.new ?? "-"}`,
  );
  expect(brief).toEqual([
    "context 13 13",
    "context 14 14",
    "del 15 -",
    "del 16 -",
    "add - 15",
    "context 17 16",
    "context 18 17",
    // Hunk one covered old lines 13 to 18; the next starts at 40.
    "fold 21",
    "context 40 39",
    "add - 40",
    "add - 41",
  ]);
});

test("a changed line marks what changed, in whole words, beside its pair", () => {
  const rows = parsePatch(PATCH).filter((r) => r.kind === "line");
  const del = rows.find((r) => r.kind === "line" && r.old === 15)!;
  const add = rows.find((r) => r.kind === "line" && r.new === 15)!;
  if (del.kind !== "line" || add.kind !== "line") throw new Error("not lines");
  expect(marked(del.text, del.changed)).toEqual(["Plants that outlive your lease"]);
  expect(marked(add.text, add.changed)).toEqual(["Slow plants, fast homes"]);
  // The second removed line has no pair: it is removed whole.
  expect(rows.find((r) => r.kind === "line" && r.old === 16)).toMatchObject({ changed: null });
});

/** The marked words of a line. */
const marked = (text: string, spans: Span[] | null) =>
  (spans ?? []).map(([from, to]) => text.slice(from, to));
const changes = (a: string, b: string) => {
  const spans = changedSpans(a, b);
  return spans && [marked(a, spans[0]), marked(b, spans[1])];
};

test("changed spans: only the words that changed, and nothing when lines share too little", () => {
  expect(changes("const width = 38;", "const width = 42;")).toEqual([["38"], ["42"]]);
  expect(changes("color: muted;", "color: mutedest;")).toEqual([["muted"], ["mutedest"]]);
  // Two changes apart on one line are two marks, not everything between them.
  expect(
    changes(
      'export const label = "Shop" + suffix(a, b);',
      'export const title = "Shop" + suffix(a, c);',
    ),
  ).toEqual([
    ["label", "b"],
    ["title", "c"],
  ]);
  // Words said again in the new line stay unmarked; a space between changed words joins them.
  expect(changes("Keep the green and the photo", "Keep the calm green and photo")).toEqual([
    ["the"],
    ["calm"],
  ]);
  // When spacing is all that changed, the spacing is marked.
  expect(changes("  return width;", "    return width;")).toEqual([["  "], ["    "]]);
  expect(changes("import a from 'a';", "export default function Page() {}")).toBeNull();
  expect(changes("same", "same")).toBeNull();
});

test("changed spans stay quick on a long, wholly rewritten line", () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join(" ");
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join(" ");
  const started = performance.now();
  changedSpans(`x ${a} y`, `x ${b} y`);
  expect(performance.now() - started).toBeLessThan(50);
});

test("checks: failing first, then running and queued, then passed, each in GitHub's order", () => {
  const check = (name: string, state: CheckRun["state"]): CheckRun => ({
    id: name,
    name,
    state,
    startedAt: null,
    completedAt: null,
    description: null,
    url: null,
  });
  const ordered = orderChecks([
    check("test", "passing"),
    check("lint", "failing"),
    check("e2e", "running"),
    check("docs", "skipped"),
    check("build", "passing"),
    check("deploy", "queued"),
    check("types", "failing"),
  ]);
  expect(ordered.map((c) => c.name)).toEqual([
    "lint",
    "types",
    "e2e",
    "deploy",
    "test",
    "build",
    "docs",
  ]);
});
