import { expect, test } from "bun:test";
import { agentRun, CANVAS_DEFAULTS, turnCostUsd, turnEnv, turnSession } from "./harness.ts";

// What a turn's Claude Code is given to sign in with: the evals' API key and nothing else.

const KEY = "sk-ant-api03-example-not-a-real-key";
const shell = {
  PATH: "/usr/bin:/bin",
  USER: "ada",
  HOME: "/Users/ada",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-the-developers-shell",
  ANTHROPIC_AUTH_TOKEN: "from-the-shell",
  PONZU_ANTHROPIC_API_KEY: "sk-ant-api03-another",
  CLAUDE_CONFIG_DIR: "/Users/ada/.claude",
};

test("a turn runs on the API key, as a canvas connected to one does", () => {
  const env = turnEnv("/tmp/ponzu-eval-x", KEY, shell);
  expect(env.ANTHROPIC_API_KEY).toBe(KEY);
  expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/ponzu-eval-x/claude");
  expect(env.HOME).toBe("/tmp/ponzu-eval-x/home");
});

test("a sign-in in the developer's shell never reaches the turn", () => {
  const env = turnEnv("/tmp/ponzu-eval-x", KEY, shell);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.PONZU_ANTHROPIC_API_KEY).toBeUndefined();
  // The only Claude credential in it is the key.
  expect(Object.values(env).filter((v) => v?.startsWith("sk-ant-"))).toEqual([KEY]);
  expect(Object.keys(env).sort()).toEqual(
    [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "GIT_CONFIG_NOSYSTEM",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
      "USER",
    ].sort(),
  );
});

test("a turn's cost is what Claude Code said each model cost, a failed turn's too", () => {
  const usage = [
    { models: [{ costUsd: 0.25 }, { costUsd: 0.05 }] },
    { models: [{ costUsd: 0.1 }] },
  ] as unknown as Parameters<typeof turnCostUsd>[0];
  expect(turnCostUsd(usage)).toBeCloseTo(0.4);
  expect(turnCostUsd(undefined)).toBe(0);
});

test("a turn without a key does not start", () => {
  expect(() => turnEnv("/tmp/ponzu-eval-x", "", shell)).toThrow(/API key/);
});

// Where a turn runs: a canvas's defaults, or the builders' rules (`--on dev-key`).

const SETUP = {
  canvasId: "cnv_x",
  doc: { name: "Onboarding", pages: [], tokens: ":root {\n}\n", threads: [], notes: {} },
  repo: true,
  event: { kind: "message", payload: { text: "hi" } },
} as unknown as Parameters<typeof turnSession>[0];

test("without --on a turn runs at a canvas's defaults, unlabelled", () => {
  expect(agentRun(null)).toBe(CANVAS_DEFAULTS);
  expect(agentRun(undefined)).toBe(CANVAS_DEFAULTS);
  const session = turnSession(SETUP);
  expect([session.model, session.effort]).toEqual(["claude-opus-5-5", "high"]);
  expect(CANVAS_DEFAULTS.ranOn).toBeNull();
});

test("--on dev-key pins Haiku at low effort for the turn, and labels its rows", () => {
  const run = agentRun("dev-key");
  expect(run).toMatchObject({
    model: "claude-haiku-5-5",
    effort: "low",
    ranOn: "dev-key/haiku/low",
  });
  const session = turnSession(SETUP, run);
  // The runner hands Claude Code the session's model and effort (run.ts), so this is what runs.
  expect([session.model, session.effort]).toEqual(["claude-haiku-5-5", "low"]);
  expect(session.canvas).toEqual({ id: "cnv_x", name: "Onboarding" });
});

test("--on dev-key still runs on the key alone: a sign-in in the shell never reaches it", () => {
  // The run changes only the model; the environment is the same one, built from nothing.
  agentRun("dev-key");
  const env = turnEnv("/tmp/ponzu-eval-x", KEY, shell);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBe(KEY);
});

test("an unknown --on is refused before anything runs", () => {
  expect(() => agentRun("subscription")).toThrow(/--on takes dev-key/);
  // Names every object has are not runs.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    expect(() => agentRun(name)).toThrow(/--on takes dev-key/);
});
