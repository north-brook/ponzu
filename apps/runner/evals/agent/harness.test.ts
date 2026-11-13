import { expect, test } from "bun:test";
import { turnEnv } from "./harness.ts";

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

test("a turn without a key does not start", () => {
  expect(() => turnEnv("/tmp/ponzu-eval-x", "", shell)).toThrow(/API key/);
});
