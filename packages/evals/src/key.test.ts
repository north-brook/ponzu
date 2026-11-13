import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Calibration, writeCalibration } from "./calibrate.ts";
import { evalsApiKey, NO_EVALS_KEY, withoutSecret } from "./key.ts";
import { Meter } from "./meter.ts";
import { type SuiteReport, writeReport } from "./suite.ts";

// The evals' one credential: an Anthropic API key, never a Claude sign-in.

const KEY = "sk-ant-api03-example-not-a-real-key";

test("the key is PONZU_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY", () => {
  expect(evalsApiKey({ PONZU_ANTHROPIC_API_KEY: KEY, ANTHROPIC_API_KEY: "other" })).toBe(KEY);
  expect(evalsApiKey({ ANTHROPIC_API_KEY: KEY })).toBe(KEY);
  expect(evalsApiKey({ PONZU_ANTHROPIC_API_KEY: " ", ANTHROPIC_API_KEY: KEY })).toBe(KEY);
});

test("a Claude sign-in is never taken for the key", () => {
  expect(
    evalsApiKey({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-example",
      PONZU_EVALS_CLAUDE_TOKEN_FILE: "/tmp/claude-oauth-token",
    }),
  ).toBeNull();
  expect(NO_EVALS_KEY).not.toContain("\n");
  expect(NO_EVALS_KEY).toContain("ANTHROPIC_API_KEY");
});

test("what the evals keep has the key taken out, however deep", () => {
  const report = {
    cases: [{ error: `401 for key ${KEY}`, steps: ["ran env", `ANTHROPIC_API_KEY=${KEY}`] }],
    spend: { usd: 0.1 },
  };
  const kept = withoutSecret(report, KEY);
  expect(JSON.stringify(kept)).not.toContain(KEY);
  expect(kept.cases[0]!.error).toBe("401 for key [redacted]");
  expect(kept.spend.usd).toBe(0.1);
  expect(JSON.stringify(report)).toContain(KEY);
});

test("a report or calibration written to disk never carries the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-evals-key-"));
  const before = { ponzu: process.env.PONZU_ANTHROPIC_API_KEY };
  process.env.PONZU_ANTHROPIC_API_KEY = KEY;
  try {
    const report = {
      suite: "x",
      at: "now",
      commit: null,
      samples: 1,
      spend: { usd: 0, cap: 1, byLabel: {} },
      judges: {},
      rates: {},
      notRun: [`401: ${KEY}`],
      failures: [],
      cases: [{ error: `the key ${KEY} was refused` }],
    } as unknown as SuiteReport;
    writeReport(dir, report, `# Run\n\nfailed: ${KEY}`);
    writeCalibration(dir, {
      judge: "j",
      reason: `quoted ${KEY}`,
    } as unknown as Calibration);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(KEY);
      expect(text).toContain("[redacted]");
    }
  } finally {
    if (before.ponzu === undefined) delete process.env.PONZU_ANTHROPIC_API_KEY;
    else process.env.PONZU_ANTHROPIC_API_KEY = before.ponzu;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent turn's cost, known only after it, counts against the cap", () => {
  const meter = new Meter(1);
  expect(meter.add("agent:turn", 0.4)).toBe(0.4);
  meter.add("agent:turn", Number.NaN);
  expect(meter.spent).toBeCloseTo(0.4);
  expect(meter.byLabel()["agent:turn"]).toEqual({ calls: 2, usd: 0.4 });
  meter.add("agent:turn", 0.7);
  expect(() =>
    meter.reserve("claude-opus-5-5", { maxOutputTokens: 1_000, inputChars: 100 }),
  ).toThrow(/cap/);
});
