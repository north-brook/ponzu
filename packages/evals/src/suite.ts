import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Calibration } from "./calibrate.ts";
import type { Judge, Model } from "./judge.ts";
import type { Meter, TurnBudget } from "./meter.ts";

/*
 * A suite: cases with inputs, run against the real models, graded by exact checks and calibrated
 * judges, written up as `results/latest.json` (everything) and `results/latest.md` (for a person)
 * beside its cases. Both are committed, so a prompt change shows the numbers before and after in
 * its diff.
 */

export interface EvalContext {
  /** Every model call on the API key is metered against the cap. */
  meter: Meter;
  /** Real agent turns, on a Claude sign-in. */
  turns: TurnBudget;
  /** Claude models on the evals' API key. */
  models: (id: string) => Model;
  /** The offline judge (Claude Opus 5.5), metered. */
  judge: Judge;
  /** How many times each case is run. */
  samples: number;
  /** Only these case ids, when given. */
  only: readonly string[] | null;
  /** Calibrate only this judge, when given. */
  onlyJudge: string | null;
  /** The checkout's commit, for the record. */
  commit: string | null;
  log(line: string): void;
}

export interface Suite {
  name: string;
  /** Where its results go. */
  resultsDir: string;
  /** Checks each of its judges against their labelled examples, and records it. */
  calibrate(ctx: EvalContext): Promise<Calibration[]>;
  /** Runs its cases and writes `latest.json` and `latest.md`. */
  run(ctx: EvalContext): Promise<SuiteReport>;
  /**
   * Judges the outputs `latest.json` recorded again, with the judges as they are now: for a
   * suite whose cases are costly to run (real agent turns), when only a judge changed.
   */
  rejudge?(ctx: EvalContext): Promise<SuiteReport>;
}

export interface SuiteReport {
  suite: string;
  at: string;
  commit: string | null;
  samples: number;
  /** Dollars this run spent on the API key, by what spent it. */
  spend: { usd: number; cap: number; byLabel: Record<string, { calls: number; usd: number }> };
  /** Agent turns this run used. */
  turns?: { used: number; max: number };
  models: Record<string, string>;
  /** Judge name to the version it ran at. */
  judges: Record<string, string>;
  /** Criterion to its pass rate over every sample it applied to. */
  rates: Record<string, { passed: number; of: number }>;
  /** What was not run, and why: a cap, a case left out. */
  notRun: string[];
  /** One summary line per notable failure. */
  failures: string[];
  /** The suite's own detail: cases, outputs, verdicts. */
  cases: unknown[];
}

export function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function writeReport(dir: string, report: SuiteReport, markdown: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "latest.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

/** Adds one result of `criterion` to `rates`. A verdict of n/a adds nothing. */
export function tally(
  rates: SuiteReport["rates"],
  criterion: string,
  verdict: boolean | "pass" | "fail" | "n/a" | null | undefined,
): void {
  if (verdict === "n/a" || verdict === null || verdict === undefined) return;
  const row = rates[criterion] ?? { passed: 0, of: 0 };
  rates[criterion] = row;
  row.of++;
  if (verdict === true || verdict === "pass") row.passed++;
}

export const percent = ({ passed, of }: { passed: number; of: number }) =>
  of === 0 ? "n/a" : `${Math.round((100 * passed) / of)}% (${passed}/${of})`;

/** The header every report starts with: when, at what commit, what it cost. */
export function reportHeader(report: SuiteReport, title: string): string {
  const lines = [
    `# ${title}`,
    "",
    `Run ${report.at} at ${report.commit ?? "an unknown commit"}, ${report.samples} sample(s) a case.`,
    `Spent $${report.spend.usd.toFixed(4)} of a $${report.spend.cap.toFixed(2)} cap${report.turns ? `, and ${report.turns.used} of ${report.turns.max} agent turns` : ""}.`,
    `Models: ${Object.entries(report.models)
      .map(([role, id]) => `${role} \`${id}\``)
      .join(", ")}. Judges: ${Object.entries(report.judges)
      .map(([name, version]) => `${name} \`${version}\``)
      .join(", ")}.`,
    "",
    "## Pass rates",
    "",
    "| Criterion | Passed |",
    "|---|---|",
    ...Object.entries(report.rates).map(
      ([criterion, rate]) => `| ${criterion} | ${percent(rate)} |`,
    ),
    "",
  ];
  if (report.failures.length) {
    lines.push("## Failures", "", ...report.failures.map((line) => `- ${line}`), "");
  }
  if (report.notRun.length) {
    lines.push("## Not run", "", ...report.notRun.map((line) => `- ${line}`), "");
  }
  return lines.join("\n");
}

/** A calibration as Markdown, for `results/calibration.md`. */
export function calibrationMarkdown(calibrations: readonly Calibration[]): string {
  const lines = ["# Judge calibration", ""];
  for (const c of calibrations) {
    lines.push(
      `## ${c.judge}: ${c.right}/${c.total} labels right, ${c.passed ? "passed" : "FAILED"}`,
      "",
      `\`${c.model}\`, version \`${c.version}\`, ${c.at} at ${c.commit ?? "?"}, $${c.usd.toFixed(4)}.`,
      "",
      "| Example | Labels | Misses |",
      "|---|---|---|",
    );
    for (const e of c.examples) {
      const flags = [e.hard ? "hard" : "", e.unsettled ? "unsettled" : ""]
        .filter(Boolean)
        .join(", ");
      const misses = e.misses
        .map((m) => `${m.label}: wanted ${m.expected}, got ${m.got}`)
        .join("; ");
      lines.push(`| ${e.id}${flags ? ` (${flags})` : ""} | ${e.labels} | ${misses || "none"} |`);
    }
    lines.push("");
    for (const e of c.examples) {
      for (const m of e.misses) {
        lines.push(`- **${e.id}**, ${m.label}: ${m.reason.replaceAll("\n", " ")}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
