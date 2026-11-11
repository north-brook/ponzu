import { expect, test } from "bun:test";
import { readEnv } from "./env.ts";

const base = {
  HOME: "/home/user",
  PONZU_API_URL: "https://api.ponzu.design",
  PONZU_DESIGN_ID: "des_1",
  PONZU_RUNNER_TOKEN: "pzr_x",
};

test("the runner starts with its three variables and one Claude credential", () => {
  expect(readEnv({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t" })).toEqual({
    apiUrl: "https://api.ponzu.design",
    designId: "des_1",
    token: "pzr_x",
    port: 4600,
    workRoot: "/home/user/work",
    stateDir: "/home/user/.ponzu",
  });
});

test("both Claude credentials is refused: the API key would silently bill the wrong account", () => {
  expect(() => readEnv({ ...base, ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" })).toThrow(
    /exactly one/,
  );
  expect(() => readEnv(base)).toThrow(/ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/);
});

test("a missing variable or a bad port is said by name", () => {
  const { PONZU_RUNNER_TOKEN: _, ...missing } = base;
  expect(() => readEnv({ ...missing, ANTHROPIC_API_KEY: "k" })).toThrow(
    "PONZU_RUNNER_TOKEN is not set.",
  );
  expect(() => readEnv({ ...base, ANTHROPIC_API_KEY: "k", PONZU_RUNNER_PORT: "http" })).toThrow(
    /not a port/,
  );
});
