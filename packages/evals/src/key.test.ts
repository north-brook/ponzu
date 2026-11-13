import { expect, test } from "bun:test";
import { evalsApiKey, NO_EVALS_KEY, withoutSecret } from "./key.ts";
import { Meter } from "./meter.ts";

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
