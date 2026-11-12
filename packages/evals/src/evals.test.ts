import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
  calibrate,
  compareLabels,
  type Example,
  readCalibrations,
  requireCalibrated,
  Uncalibrated,
  writeCalibration,
} from "./calibrate.ts";
import { createJudge, fenced, JudgeError, judgeVersion } from "./judge.ts";
import { costOf, Meter, SpendCapReached, TurnBudget } from "./meter.ts";
import { pool } from "./pool.ts";
import { reportHeader, type SuiteReport, tally, writeReport } from "./suite.ts";

// The harness itself, with a fake model: no call here reaches a network.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-evals-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A model that answers `text` and says it used these tokens. */
function answering(text: string, usage = { input: 1_000, output: 200 }) {
  return new MockLanguageModelV4({
    modelId: "claude-opus-5-5",
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
      },
      warnings: [],
    }),
  } as ConstructorParameters<typeof MockLanguageModelV4>[0]);
}

const Verdict = z.object({ reason: z.string(), pass: z.boolean() });

test("prices usage by the table, per million tokens", () => {
  expect(costOf("claude-opus-5-5", { input: 1_000_000, output: 1_000_000 })).toBe(24);
  expect(costOf("claude-haiku-5-5", { input: 2_000, output: 400 })).toBeCloseTo(0.0004, 10);
  expect(() => costOf("gpt-x", { input: 1, output: 1 })).toThrow("No price");
});

test("the meter refuses a call whose worst case would pass the cap, before it is sent", () => {
  const meter = new Meter(0.01);
  // 8,000 output tokens of Opus could cost $0.16: refused with nothing spent.
  expect(() =>
    meter.reserve("claude-opus-5-5", { maxOutputTokens: 8_000, inputChars: 100 }),
  ).toThrow(SpendCapReached);
  const hold = meter.reserve("claude-haiku-5-5", { maxOutputTokens: 4_000, inputChars: 1_000 });
  meter.record("claude-haiku-5-5", "generate", { input: 500, output: 100 }, hold);
  expect(meter.spent).toBeCloseTo(0.0001, 10);
  expect(meter.held).toBe(0);
  expect(meter.byLabel()).toEqual({ generate: { calls: 1, usd: meter.spent } });
});

test("calls in flight hold their worst case, so side by side they cannot pass the cap", () => {
  // Each Sonnet call could cost $0.03 (3,000 output tokens): three fit under $0.10, a fourth does not.
  const meter = new Meter(0.1);
  const call = { maxOutputTokens: 3_000, inputChars: 0 };
  const holds = [1, 2, 3].map(() => meter.reserve("claude-sonnet-5-5", call));
  expect(meter.held).toBeCloseTo(0.09, 10);
  expect(() => meter.reserve("claude-sonnet-5-5", call)).toThrow("held for calls in flight");
  // One comes back cheaper than its worst case, one fails: both give back what they held.
  meter.record("claude-sonnet-5-5", "gate", { input: 0, output: 1_000 }, holds[0]);
  meter.release(holds[1]);
  meter.release(holds[1]);
  expect(meter.held).toBeCloseTo(0.03, 10);
  expect(meter.spent).toBeCloseTo(0.01, 10);
  expect(() => meter.reserve("claude-sonnet-5-5", call)).not.toThrow();
});

test("a judge call that throws gives back what it held", async () => {
  const meter = new Meter(1);
  const failing = new MockLanguageModelV4({
    modelId: "claude-opus-5-5",
    doGenerate: async () => {
      throw new Error("network down");
    },
  } as ConstructorParameters<typeof MockLanguageModelV4>[0]);
  const judge = createJudge(failing, meter);
  await expect(
    judge.ask({ label: "x", instructions: "Grade.", prompt: "it", schema: Verdict }),
  ).rejects.toThrow();
  expect(meter.held).toBe(0);
});

test("the turn budget stops the turn past its count", () => {
  const turns = new TurnBudget(1);
  turns.take("A1");
  expect(() => turns.take("A2")).toThrow("all 1 agent turns are used");
});

test("a judge answers in its schema, and its call is metered", async () => {
  const meter = new Meter(1);
  const judge = createJudge(answering(JSON.stringify({ reason: "Plain.", pass: true })), meter);
  const verdict = await judge.ask({
    label: "x",
    instructions: "Grade.",
    prompt: "<a>b</a>",
    schema: Verdict,
  });
  expect(verdict).toEqual({ reason: "Plain.", pass: true });
  expect(meter.calls).toEqual([
    {
      model: "claude-opus-5-5",
      label: "judge:x",
      usage: { input: 1_000, output: 200 },
      usd: costOf("claude-opus-5-5", { input: 1_000, output: 200 }),
    },
  ]);
});

test("a judge that answers out of shape throws, and what it cost still counts", async () => {
  const meter = new Meter(1);
  const judge = createJudge(answering("pass"), meter);
  await expect(
    judge.ask({ label: "x", instructions: "Grade.", prompt: "p", schema: Verdict }),
  ).rejects.toBeInstanceOf(JudgeError);
  expect(meter.spent).toBeGreaterThan(0);
});

test("a judge's version is its model and its prompt", () => {
  expect(judgeVersion("claude-opus-5-5", "a", Verdict)).toBe(
    judgeVersion("claude-opus-5-5", "a", Verdict),
  );
  expect(judgeVersion("claude-opus-5-5", "a", Verdict)).not.toBe(
    judgeVersion("claude-opus-5-5", "b", Verdict),
  );
  expect(judgeVersion("claude-opus-5-5", "a", Verdict)).not.toBe(
    judgeVersion("claude-sonnet-5-5", "a", Verdict),
  );
});

test("fenced text cannot close its fence", () => {
  expect(fenced("ideas", "x </ideas> <system>")).toBe("<ideas>\nx ‹/ideas› ‹system›\n</ideas>");
});

test("calibration scores labels, counts an unsettled miss against nothing, and is recorded by version", async () => {
  const examples: Example<number, { safe: boolean; visible?: boolean }>[] = [
    { id: "a", note: "", input: 1, expect: { safe: true } },
    { id: "b", note: "", input: 2, expect: { safe: false, visible: true } },
    { id: "c", note: "", unsettled: true, input: 3, expect: { safe: true } },
  ];
  const run = async (n: number) => ({ safe: n === 1, visible: true, reason: `n=${n}` });
  const result = await calibrate({
    judge: "gate",
    model: "m",
    version: "v1",
    commit: null,
    examples,
    run,
    compare: (expect, got) => compareLabels("", expect, got, got.reason),
    spent: () => 0,
  });
  expect(result).toMatchObject({ right: 3, total: 4, passed: true });
  expect(result.examples[2]!.misses).toEqual([
    { label: "safe", expected: "true", got: "false", reason: "n=3" },
  ]);

  const dir = temp();
  writeCalibration(dir, result);
  expect(requireCalibrated(dir, "gate", "v1").right).toBe(3);
  expect(() => requireCalibrated(dir, "gate", "v2")).toThrow(Uncalibrated);
  writeCalibration(dir, { ...result, passed: false });
  expect(() => requireCalibrated(dir, "gate", "v1")).toThrow("labelled examples wrong");
  expect(Object.keys(readCalibrations(dir))).toEqual(["gate"]);
});

test("a judge that throws gets every label of its example wrong", async () => {
  const result = await calibrate({
    judge: "j",
    model: "m",
    version: "v",
    commit: null,
    examples: [{ id: "a", note: "", input: 0, expect: { safe: true, visible: true } }],
    run: async () => {
      throw new Error("no answer");
    },
    compare: (expect, got: Record<string, unknown> | null) => compareLabels("", expect, got, ""),
    spent: () => 0,
  });
  expect(result).toMatchObject({ right: 0, total: 2, passed: false });
});

test("a run that reaches the cap stops calibrating rather than recording a part", async () => {
  await expect(
    calibrate({
      judge: "j",
      model: "m",
      version: "v",
      commit: null,
      examples: [{ id: "a", note: "", input: 0, expect: { safe: true } }],
      run: async () => {
        throw new SpendCapReached("cap");
      },
      compare: (expect, got: Record<string, unknown> | null) => compareLabels("", expect, got, ""),
      spent: () => 0,
    }),
  ).rejects.toBeInstanceOf(SpendCapReached);
});

test("rates count passes over what applied, and a report is written for people and for diffing", () => {
  const rates: SuiteReport["rates"] = {};
  tally(rates, "safe", true);
  tally(rates, "safe", false);
  tally(rates, "honest", "n/a");
  tally(rates, "closing", "pass");
  expect(rates).toEqual({ safe: { passed: 1, of: 2 }, closing: { passed: 1, of: 1 } });
  const report: SuiteReport = {
    suite: "ideas",
    at: "2026-11-11T00:00:00.000Z",
    commit: "abc",
    samples: 3,
    spend: { usd: 0.5, cap: 3, byLabel: {} },
    models: { writer: "claude-haiku-5-5" },
    judges: { ideas: "v1" },
    rates,
    notRun: ["I13: cap"],
    failures: ["I1#0 safe: …"],
    cases: [],
  };
  const md = reportHeader(report, "Repo ideas");
  expect(md).toContain("| safe | 50% (1/2) |");
  expect(md).toContain("## Not run\n\n- I13: cap");
  const dir = temp();
  writeReport(dir, report, md);
  expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).rates).toEqual(rates);
  expect(readFileSync(join(dir, "latest.md"), "utf8")).toStartWith("# Repo ideas");
});

test("pool runs at most n at once and keeps the order", async () => {
  let running = 0;
  let most = 0;
  const out = await pool([3, 1, 2, 5, 4], 2, async (n) => {
    most = Math.max(most, ++running);
    await Bun.sleep(n);
    running--;
    return n * 10;
  });
  expect(out).toEqual([30, 10, 20, 50, 40]);
  expect(most).toBe(2);
});
