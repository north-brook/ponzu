import { expect, test } from "bun:test";
import { agentEnv, readEnv } from "./env.ts";

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
    gitSocket: "/home/user/.ponzu/git.sock",
  });
});

test("the image says where the agent's side lives", () => {
  expect(
    readEnv({
      ...base,
      ANTHROPIC_API_KEY: "k",
      PONZU_WORK_ROOT: "/home/agent/work",
      PONZU_GIT_SOCKET: "/run/ponzu/git.sock",
      PONZU_CLAUDE: "/opt/ponzu/libexec/agent-claude",
      PONZU_GIT: "/opt/ponzu/libexec/agent-git",
    }),
  ).toMatchObject({
    workRoot: "/home/agent/work",
    gitSocket: "/run/ponzu/git.sock",
    claude: "/opt/ponzu/libexec/agent-claude",
    git: "/opt/ponzu/libexec/agent-git",
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

test("the agent's side gets everything but the runner token", () => {
  const env = { ...base, ANTHROPIC_API_KEY: "k", STRIPE_KEY: "repo secret" };
  const { PONZU_RUNNER_TOKEN: _, ...rest } = env;
  expect(agentEnv(env)).toEqual(rest);
  // The runner's own is left as it was.
  expect(env.PONZU_RUNNER_TOKEN).toBe("pzr_x");
});
