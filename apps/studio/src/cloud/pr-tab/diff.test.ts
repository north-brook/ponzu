import { expect, test } from "bun:test";
import type { CheckRun } from "../model.ts";
import { changedSpans, orderChecks, parsePatch } from "./diff.ts";

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
  expect(del.text.slice(...del.changed!)).toBe("Plants that outlive your lease");
  expect(add.text.slice(...add.changed!)).toBe("Slow plants, fast homes");
  // The second removed line has no pair: it is removed whole.
  expect(rows.find((r) => r.kind === "line" && r.old === 16)).toMatchObject({ changed: null });
});

test("changed spans: whole words, and nothing when the lines share too little", () => {
  const [a, b] = changedSpans("const width = 38;", "const width = 42;")!;
  expect("const width = 38;".slice(...a)).toBe("38");
  expect("const width = 42;".slice(...b)).toBe("42");
  const [c] = changedSpans("color: muted;", "color: mutedest;")!;
  expect("color: muted;".slice(...c)).toBe("muted");
  expect(changedSpans("import a from 'a';", "export default function Page() {}")).toBeNull();
  expect(changedSpans("same", "same")).toBeNull();
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
