#!/usr/bin/env bun
/*
 * The studio's performance harness (README.md).
 *
 *   bun apps/studio/perf/run.ts                         this checkout, built now, 1 round
 *   bun apps/studio/perf/run.ts --head <dir> --base <dir> --rounds 3 --out results.json --markdown comment.md
 *   bun apps/studio/perf/run.ts --only website.zoom,thread.stream
 *   bun apps/studio/perf/run.ts --only website.zoom --profile traces    keep and explain each trace
 *   bun apps/studio/perf/run.ts --report results.json --history history.jsonl --markdown comment.md
 *   bun apps/studio/perf/run.ts --electron apps/desktop/run-dev.sh --head <dir> --base <dir>
 *   bun apps/studio/perf/run.ts --cdp http://127.0.0.1:9222      the desktop app already running
 *
 * `--head` and `--base` are studio builds in e2e mode (`vite build --mode e2e`). With a base, the
 * two run in turn, round by round, the order swapped each round, so whatever the machine does
 * meanwhile falls on both alike. Each round of each build is a fresh browser.
 *
 * `--electron` and `--cdp` measure the desktop app on this Mac's GPU and display instead of
 * headless Chrome (README.md, "Profiling"): only on Ponzu Cloud in memory, and only on spare.
 * `--electron` starts the checkout's app for each suite, showing `--head` (and `--base`) from
 * the harness's server; `--cdp` attaches to an app already running and measures its own studio.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "../src/app/e2e-lib.ts";
import { type Desktop, openDesktop, openStudio, windowSize } from "./app.ts";
import { parseHistory, type Results, type Runs, report } from "./report.ts";
import { SUITES } from "./scenarios.ts";
import { explain, profiling } from "./trace.ts";

const { values: args } = parseArgs({
  options: {
    head: { type: "string" },
    base: { type: "string" },
    "head-sha": { type: "string" },
    "base-sha": { type: "string" },
    rounds: { type: "string", default: "1" },
    only: { type: "string" },
    out: { type: "string" },
    markdown: { type: "string" },
    history: { type: "string" },
    report: { type: "string" },
    machine: { type: "string" },
    profile: { type: "string" },
    electron: { type: "string" },
    cdp: { type: "string" },
  },
});

function readHistory(): ReturnType<typeof parseHistory> {
  if (!args.history) return [];
  try {
    return parseHistory(readFileSync(args.history, "utf8"));
  } catch {
    return [];
  }
}

// Only the report, from results already measured.
if (args.report) {
  const results = JSON.parse(readFileSync(args.report, "utf8")) as Results;
  const md = report(results, readHistory());
  if (args.markdown) writeFileSync(args.markdown, md);
  else console.log(md);
  process.exit(0);
}

const only = args.only ? new Set(args.only.split(",")) : null;
const wanted = (id: string) =>
  !only || only.has(id) || [...only].some((o) => id.startsWith(`${o}.`));
const suites = SUITES.map((s) => ({
  ...s,
  scenarios: s.scenarios.filter((sc) => wanted(sc.id)),
})).filter((s) => s.scenarios.length);

// Profiling: each scenario's trace is kept in the directory named, for Chrome's Performance
// panel or ui.perfetto.dev, and what it says is printed. Its numbers are slower: the trace
// records every invalidation.
let current = "";
if (args.profile) {
  mkdirSync(args.profile, { recursive: true });
  profiling.on = true;
  profiling.sink = (events) => {
    if (!current) return;
    const file = join(args.profile!, `${current}.json`);
    writeFileSync(file, JSON.stringify({ traceEvents: events }));
    console.error(`  ${current}: ${file}\n${explain(events)}`);
  };
}

if (args.cdp && (args.electron || args.head || args.base)) {
  console.error(
    "--cdp measures the app already running, with its own studio: no --electron, --head or --base.",
  );
  process.exit(1);
}
const head = args.cdp ? "" : (args.head ?? (await buildApp("e2e")));
const builds: { name: "head" | "base"; dir: string; runs: Runs }[] = [
  { name: "head", dir: head, runs: {} },
];
if (args.base) builds.push({ name: "base", dir: args.base, runs: {} });
/** The desktop app showing a build, when the harness measures that instead of headless Chrome. */
const desktop = (dir: string): Desktop | null =>
  args.cdp ? { cdp: args.cdp } : args.electron ? { electron: args.electron, dir } : null;
/** Where the numbers were taken: the desktop's window, as the first suite found it. */
let where = "";

const rounds = Math.max(1, Number(args.rounds));
const errors: Results["errors"] = [];
const started = Date.now();
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? [...builds].reverse() : builds;
  for (const build of order) {
    console.error(`round ${round + 1}/${rounds}, ${build.name}`);
    for (const suite of suites) {
      // A browser per suite: one suite's canvases and leftovers never weigh on the next.
      let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
      try {
        const app = desktop(build.dir);
        studio = app ? await openDesktop(app) : await openStudio(build.dir);
        if (app && !where) {
          const ua = await studio.page.evaluate(() => navigator.userAgent);
          const electron = ua.match(/Electron\/[\d.]+/)?.[0] ?? "the desktop app";
          where = `${electron}, ${await windowSize(studio.page)}`;
          console.error(`  measuring ${where}`);
        }
        const state = await suite.setup(studio);
        for (const sc of suite.scenarios) {
          try {
            current = sc.id;
            const measured = await sc.run(studio, state);
            const into = build.runs[sc.id] ?? {};
            build.runs[sc.id] = into;
            for (const [k, v] of Object.entries(measured)) into[k] = [...(into[k] ?? []), v];
            console.error(
              `  ${sc.id.padEnd(26)} ${sc.headline.map((h) => `${h}=${measured[h]}`).join(" ")}`,
            );
          } catch (error) {
            errors.push({ build: build.name, at: sc.id, message: String(error) });
            console.error(`  ${sc.id} failed: ${String(error).split("\n")[0]}`);
          }
        }
      } catch (error) {
        errors.push({ build: build.name, at: suite.id, message: String(error) });
        console.error(`  ${suite.id} failed to set up: ${String(error).split("\n")[0]}`);
      } finally {
        await studio?.close();
      }
    }
  }
}
console.error(`measured in ${Math.round((Date.now() - started) / 1000)} s`);

const results: Results = {
  date: new Date().toISOString(),
  machine:
    args.machine ??
    [`${process.platform}, ${cpus().length} cores`, where].filter(Boolean).join(", "),
  rounds,
  head: { sha: args["head-sha"] ?? null, runs: builds[0]!.runs },
  base: builds[1] ? { sha: args["base-sha"] ?? null, runs: builds[1].runs } : null,
  scenarios: suites.flatMap((s) =>
    s.scenarios.map((sc) => ({
      id: sc.id,
      suite: s.id,
      surface: sc.id.includes(".resize-") ? "panes" : s.surface,
      title: sc.title,
      headline: sc.headline,
    })),
  ),
  suites: suites.map((s) => ({ id: s.id, surface: s.surface, about: s.about })),
  errors,
};
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
const md = report(results, readHistory());
if (args.markdown) writeFileSync(args.markdown, md);
else if (!args.out) console.log(md);
