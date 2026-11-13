#!/usr/bin/env bun
/*
 * `bun run evals [judges|rejudge|ideas|agent|all] [suite…] [--samples N] [--turns N] [--cap USD] [--only id,id] [--judge name] [--parallel N]`
 *
 * Runs the AI evals against the real models (docs/evals.md). They cost money and are not
 * deterministic, so `bun test` never runs them.
 *
 *   judges [ideas|agent]   check each judge against its labelled examples, and record it
 *                          (--judge <name> for one; --only <ids> tries examples without recording)
 *   rejudge agent          judge the recorded agent turns again, with no new turn
 *   ideas                  the repo ideas suite (apps/api/evals/ideas)
 *   agent                  the agent's thread messages (apps/runner/evals/agent)
 *   all                    judges, then every suite
 *
 * Everything runs on one Anthropic API key, PONZU_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY (the
 * development key), never on a Claude sign-in. Spend stops before the call that could pass
 * PONZU_EVALS_SPEND_USD (default $3) or --cap. Agent turns run on the same key through Claude
 * Code, at most --turns of them (default 6); what each cost is added to the spend after it ends.
 * Each suite writes results/latest.json and latest.md beside its cases; the judges write
 * results/calibration.json and calibration.md.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  anthropicModels,
  type Calibration,
  calibrationMarkdown,
  createJudge,
  type EvalContext,
  evalsApiKey,
  gitCommit,
  JUDGE_MODEL,
  Meter,
  NO_EVALS_KEY,
  percent,
  readCalibrations,
  type Suite,
  TurnBudget,
  withoutSecret,
} from "@ponzu/evals";
import { ideasSuite } from "../apps/api/evals/ideas/ideas.eval.ts";
import { agentSuite } from "../apps/runner/evals/agent/agent.eval.ts";

const SUITES: Record<string, Suite> = { ideas: ideasSuite, agent: agentSuite };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const words = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [command = "all", ...named] = words;

const apiKey = evalsApiKey();
if (!apiKey) {
  console.error(NO_EVALS_KEY);
  process.exit(2);
}
const cap = Number(flag("cap") ?? process.env.PONZU_EVALS_SPEND_USD ?? 3);
const meter = new Meter(cap);
const models = anthropicModels(apiKey);
const only = flag("only")?.split(",").filter(Boolean) ?? null;
const ctx: EvalContext = {
  meter,
  turns: new TurnBudget(Number(flag("turns") ?? 6)),
  models,
  judge: createJudge(models(JUDGE_MODEL), meter),
  samples: Number(flag("samples") ?? 3),
  only,
  parallel: Math.max(1, Number(flag("parallel") ?? 4)),
  onlyJudge: flag("judge") ?? null,
  commit: gitCommit(),
  // Nothing printed carries the key, whatever an error quoted.
  log: (line) => console.log(`  ${withoutSecret(line, apiKey)}`),
};

const pick = (names: string[]) => {
  const unknown = names.filter((name) => !SUITES[name]);
  if (unknown.length) {
    console.error(
      `No suite called ${unknown.join(", ")}: there are ${Object.keys(SUITES).join(", ")}.`,
    );
    process.exit(2);
  }
  return (names.length ? names : Object.keys(SUITES)).map((name) => SUITES[name]!);
};

async function calibrateAll(suites: Suite[]) {
  let ok = true;
  for (const suite of suites) {
    console.log(`\n# Calibrating the ${suite.name} judges`);
    const done: Calibration[] = await suite.calibrate(ctx);
    for (const c of done) {
      console.log(
        `${c.judge}: ${c.right}/${c.total} labels right, ${c.passed ? "passed" : "FAILED"} ($${c.usd.toFixed(4)})`,
      );
      for (const e of c.examples) {
        for (const m of e.misses)
          console.log(`  MISS ${e.id} ${m.label}: wanted ${m.expected}, got ${m.got}. ${m.reason}`);
      }
      ok &&= c.passed;
    }
    if (done.length && !only) {
      const recorded = Object.values(readCalibrations(suite.resultsDir));
      writeFileSync(join(suite.resultsDir, "calibration.md"), calibrationMarkdown(recorded));
    }
  }
  return ok;
}

async function runAll(suites: Suite[]) {
  for (const suite of suites) {
    console.log(`\n# The ${suite.name} suite`);
    const report = await suite.run(ctx);
    for (const [criterion, rate] of Object.entries(report.rates))
      console.log(`${criterion}: ${percent(rate)}`);
    for (const line of report.notRun) console.log(`not run: ${line}`);
    const written = only && suite.name === "ideas" ? "partial.md" : "latest.md";
    console.log(`→ ${join(suite.resultsDir, written)}`);
  }
}

let ok = true;
try {
  if (command === "judges") ok = await calibrateAll(pick(named));
  else if (command === "rejudge") {
    for (const suite of pick(named)) {
      if (!suite.rejudge) continue;
      console.log(`\n# Judging the ${suite.name} suite's recorded outputs again`);
      const report = await suite.rejudge(ctx);
      for (const [criterion, rate] of Object.entries(report.rates))
        console.log(`${criterion}: ${percent(rate)}`);
    }
  } else if (command === "all") {
    ok = await calibrateAll(pick([]));
    if (ok) await runAll(pick([]));
  } else await runAll(pick([command, ...named]));
} finally {
  console.log(
    `\nSpent $${meter.spent.toFixed(4)} of the $${cap.toFixed(2)} cap; ${ctx.turns.used} agent turn(s).`,
  );
  for (const [label, row] of Object.entries(meter.byLabel())) {
    console.log(`  ${label}: ${row.calls} call(s), $${row.usd.toFixed(4)}`);
  }
}
process.exit(ok ? 0 : 1);
