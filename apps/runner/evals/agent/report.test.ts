import { expect, test } from "bun:test";
import type { SuiteReport } from "@ponzu/evals";
import { agentMarkdown, type CaseResult, inOrder, keptRows, rowName } from "./agent.eval.ts";
import { CANVAS_DEFAULTS, RUN_ON } from "./harness.ts";

// How rows from `--on dev-key` live beside the rows at a canvas's defaults in results/latest.*.

const DEV = RUN_ON["dev-key"]!;
const row = (id: string, ranOn?: string): CaseResult => ({
  id,
  title: `Case ${id}`,
  ...(ranOn ? { ranOn } : {}),
});
const recorded = {
  at: "2026-11-12T09:47:03.486Z",
  commit: "398914845a6f",
  cases: [row("A1"), row("A7"), row("A7", DEV.ranOn!), row("A8", DEV.ranOn!)],
};

test("a dev-key run never replaces a row at the defaults", () => {
  const kept = keptRows(recorded, DEV, ["A7", "A8"]);
  expect(kept.map(rowName)).toEqual(["A1", "A7"]);
  // Each kept row says when its turn ran.
  expect(kept[0]!.ran).toEqual({ at: recorded.at, commit: recorded.commit });
});

test("a run at the defaults never drops a dev-key row, even a full one", () => {
  expect(keptRows(recorded, CANVAS_DEFAULTS, null).map(rowName)).toEqual([
    "A7 (dev-key/haiku/low)",
    "A8 (dev-key/haiku/low)",
  ]);
  expect(keptRows(recorded, CANVAS_DEFAULTS, ["A1"]).map(rowName)).toEqual([
    "A7",
    "A7 (dev-key/haiku/low)",
    "A8 (dev-key/haiku/low)",
  ]);
});

test("a report written before --on existed keeps all its rows as defaults rows", () => {
  const old = { ...recorded, cases: [row("A1"), row("A2")] };
  expect(keptRows(old, DEV, null).map(rowName)).toEqual(["A1", "A2"]);
  expect(keptRows(null, DEV, null)).toEqual([]);
});

test("rows read defaults first, then each other place, each in case order", () => {
  const rows = [row("A8", DEV.ranOn!), row("A2"), row("A7", DEV.ranOn!), row("A10"), row("A1")];
  expect(inOrder(rows).map(rowName)).toEqual([
    "A1",
    "A2",
    "A10",
    "A7 (dev-key/haiku/low)",
    "A8 (dev-key/haiku/low)",
  ]);
});

test("the report puts dev-key rows in their own section, with their own rates", () => {
  const report: SuiteReport = {
    suite: "agent",
    at: "2026-11-13T18:00:00.000Z",
    commit: "abc",
    samples: 1,
    spend: { usd: 0.1, cap: 2, byLabel: {} },
    models: { agent: "claude-opus-5-5 (high)" },
    judges: {},
    rates: { "exact: links": { passed: 1, of: 1 } },
    ratesByRun: { [DEV.ranOn!]: { "exact: opened_pull_request": { passed: 0, of: 1 } } },
    notRun: [],
    failures: [],
    cases: [],
  };
  const md = agentMarkdown(report, [row("A1"), row("A7", DEV.ranOn!)]);
  const [above, below] = md.split("## Under the builders' rules");
  expect(below).toBeDefined();
  expect(above).toContain("### A1: Case A1");
  expect(above).not.toContain("### A7");
  expect(above).not.toContain("opened_pull_request");
  expect(below).toContain("`claude-haiku-5-5` at `low`");
  expect(below).toContain("| exact: opened_pull_request | 0% (0/1) |");
  expect(below).toContain("### A7: Case A7");
});

test("a kept row whose turn never ran gets no date", () => {
  const skipped = { ...row("A9"), error: "not run: turn budget" };
  const kept = keptRows({ ...recorded, cases: [skipped, row("A1")] }, DEV, null);
  expect(kept.map((r) => [r.id, r.ran ?? null])).toEqual([
    ["A9", null],
    ["A1", { at: recorded.at, commit: recorded.commit }],
  ]);
});
