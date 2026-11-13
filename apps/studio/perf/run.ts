#!/usr/bin/env bun
/*
 * The studio's performance harness (README.md).
 *
 *   bun apps/studio/perf/run.ts                         this checkout, built now, 1 round
 *   bun apps/studio/perf/run.ts --head <dir> --base <dir> --rounds 3 --out results.json --markdown comment.md
 *   bun apps/studio/perf/run.ts --only website.zoom,thread.stream
 *   bun apps/studio/perf/run.ts --only website.zoom --profile traces    keep and explain each trace
 *   bun apps/studio/perf/run.ts --report results.json --history history.jsonl --markdown comment.md
 *
 * `--head` and `--base` are studio builds in e2e mode (`vite build --mode e2e`). With a base, the
 * two run in turn, round by round, the order swapped each round, so whatever the machine does
 * meanwhile falls on both alike. Each round of each build is a fresh browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "../src/app/e2e-lib.ts";
import { openStudio } from "./app.ts";
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

const head = args.head ?? (await buildApp("e2e"));
const builds: { name: "head" | "base"; dir: string; runs: Runs }[] = [
  { name: "head", dir: head, runs: {} },
];
if (args.base) builds.push({ name: "base", dir: args.base, runs: {} });

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
        studio = await openStudio(build.dir);
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
  machine: args.machine ?? `${process.platform}, ${cpus().length} cores`,
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
