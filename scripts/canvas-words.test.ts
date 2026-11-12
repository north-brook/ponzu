// The word "design" means the .design format, the 1.x product, or a third-party name, and
// nothing else. A canvas is a canvas, and the activity is making, building and shipping: every
// other use is a miss. The rules (what is out of scope, the spans that are not the word, the
// lines kept word for word) are scripts/canvas-words.ts, the same file the rename was made with.
//
// CANVAS_WORDS_PATHS=<glob>[,<glob>…] limits every check to those paths, and a glob that starts
// with ! leaves its paths out: a slice's own gate.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DECIDED } from "./canvas-words/decided.ts";
import { ALLOWED_SPANS, EXCLUDE, INCLUDE_AGAIN, KEEP } from "./canvas-words.ts";

const ROOT = process.env.CANVAS_WORDS_ROOT ?? join(import.meta.dir, "..");
const globs = (process.env.CANVAS_WORDS_PATHS ?? "").split(",").filter(Boolean);
const only = globs.filter((g) => !g.startsWith("!")).map((g) => new Bun.Glob(g));
const not = globs.filter((g) => g.startsWith("!")).map((g) => new Bun.Glob(g.slice(1)));
const chosen = (p: string) =>
  (!only.length || only.some((g) => g.match(p))) && !not.some((g) => g.match(p));
const excluded = EXCLUDE.map((r) => new Bun.Glob(r.glob));
const again = INCLUDE_AGAIN.map((r) => new Bun.Glob(r.glob));
const inScope = (p: string) => !excluded.some((g) => g.match(p)) || again.some((g) => g.match(p));
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, maxBuffer: 1 << 28 })
  .toString()
  .split("\n")
  .filter(Boolean);
const files = tracked.filter((p) => inScope(p) && chosen(p));

const read = (path: string): string | null => {
  const buffer = readFileSync(join(ROOT, path));
  return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf8");
};

/** The line with every allowed span blanked: what is left is what must not say design. */
function blank(path: string, line: string): string {
  let out = line;
  for (const p of ALLOWED_SPANS) {
    if (p.paths && !p.paths.some((g) => new Bun.Glob(g).match(path))) continue;
    out = out.replace(p.re, (m) => " ".repeat(m.length));
  }
  return out;
}

const WORD = /design|Design|DESIGN/;
const OLD_ID = /(?<![\w])(?:des|dsn)_[A-Za-z0-9[]/;
const keepMatches = KEEP.map((rule) => new Bun.Glob(rule.path));
const used = new Set<number>();
const misses: string[] = [];
for (const path of files) {
  const text = read(path);
  if (text === null) continue;
  text.split("\n").forEach((line, i) => {
    if (!WORD.test(line) && !OLD_ID.test(line)) return;
    const k = KEEP.findIndex((rule, j) => keepMatches[j]!.match(path) && line.includes(rule.has));
    if (k >= 0) return void used.add(k);
    const left = blank(path, line);
    const isDoc = /\.mdx?$/.test(path);
    if (WORD.test(left) || (!isDoc && OLD_ID.test(left)))
      misses.push(`${path}:${i + 1}: ${line.trim()}`);
  });
}

test("no line in scope says design but for the format, third-party names and the kept lines", () => {
  expect(misses).toEqual([]);
});

// A kept line that no longer exists is a stale allowance: drop it. Its own test, so it reports
// while misses remain.
test("every kept line still exists", () => {
  const stale = KEEP.filter(
    (_, i) => !used.has(i) && tracked.some((p) => chosen(p) && keepMatches[i]!.match(p)),
  );
  expect(stale.map((k) => `${k.path}: ${k.has}`)).toEqual([]);
});

test("no path in scope says design but for .design folders", () => {
  expect(files.filter((p) => WORD.test(blank(p, p)))).toEqual([]);
});

test("the allowances stay few, and each says why", () => {
  expect(KEEP.length).toBeLessThan(150);
  for (const k of KEEP) expect(k.why.length).toBeGreaterThan(3);
});

// The words decided for the rename are the ones in the tree, and the script's guesses are gone.
test("the decided words are in place", () => {
  const wrong: string[] = [];
  for (const d of DECIDED) {
    const glob = new Bun.Glob(d.path);
    const except = d.except ? new Bun.Glob(d.except) : null;
    const paths = tracked.filter((p) => glob.match(p) && !except?.match(p) && chosen(p));
    if (!paths.length) {
      if (!only.length) wrong.push(`${d.path}: no such file (${d.why})`);
      continue;
    }
    const texts = paths.map((p) => [p, read(p) ?? ""] as const);
    if (d.gone)
      for (const [p, t] of texts)
        t.split("\n").forEach((line, i) => {
          if (d.gone!.test(line))
            wrong.push(`${p}:${i + 1}: still says ${line.match(d.gone!)![0]} (${d.why})`);
        });
    for (const s of d.present ?? [])
      if (!texts.some(([, t]) => t.includes(s)))
        wrong.push(`${d.path}: lacks ${JSON.stringify(s)} (${d.why})`);
  }
  expect(wrong).toEqual([]);
});

const grep = (pattern: string, ...paths: string[]) => {
  try {
    return execFileSync("git", ["grep", "-n", "-I", "-P", pattern, "--", ...paths], { cwd: ROOT })
      .toString()
      .trim()
      .split("\n")
      .filter((l) => {
        const [path, , ...rest] = l.split(":");
        const line = rest.join(":");
        // A KEEP line may name the old form on purpose (the spec saying it still redirects).
        const kept = KEEP.some((k, j) => keepMatches[j]!.match(path!) && line.includes(k.has));
        return inScope(path!) && chosen(path!) && !kept;
      });
  } catch {
    return [];
  }
};

// The old link and address forms are written nowhere; only the readers that accept them remain.
// Each check is its own test, so one failing never hides another.
test("nothing writes an old link, route, variable, tool or footer", () => {
  const readers = [
    ":!apps/studio/src/cloud/ui/canvas-address*",
    ":!apps/web/next.config.ts",
    ":!apps/desktop/src/deep-links*",
    ":!packages/client/src/model/pull-request-map*",
    ":!apps/studio/src/app/pull-request.test.ts",
    ":!apps/runner/evals/agent/checks*",
    ":!scripts/canvas-words*",
  ];
  expect(
    grep(
      "ponzu\\.design/designs?/|ponzu(?:-dev|-preview)?://design/|/v1/designs\\b|PONZU_DESIGN_ID|update_design|Designed in Ponzu",
      ".",
      ...readers,
    ),
  ).toEqual([]);
});

test("nothing makes an id with the old prefix", () => {
  expect(grep('newId\\("des"\\)|\\.id\\("dsn"\\)', ".")).toEqual([]);
});

// The other meanings of "canvas" have their own words (the plan's naming table). "The open
// canvas" is the canvas open in the window; the space off every board is the ground.
test("the other meanings of canvas keep their own words", () => {
  expect(
    grep(
      "canvas-pane(?!s)|CANVAS_PANEL|CANVAS_MIN|canvasStep|tab: \"canvas\"|/canvas/canvas|CanvasCanvas|canvas(?:'s)? canvas|(?i:\\bonto (?:the|a|its) open canvas\\b|\\bopen canvas of\\b|\\bpage's open canvas\\b|\\bcanvas(?:'s)? pane\\b)",
      ".",
      ":!scripts/canvas-words*",
    ),
  ).toEqual([]);
});
