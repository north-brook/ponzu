import { expect, test } from "bun:test";
import { encodeRepoSecrets } from "./api/protocol.ts";
import { agentEnv, readEnv } from "./env.ts";

const base = {
  HOME: "/home/user",
  PONZU_API_URL: "https://api.ponzu.design",
  PONZU_DESIGN_ID: "des_1",
  PONZU_RUNNER_TOKEN: "pzr_x",
  PONZU_PORT_TOKEN: "pzp_x",
};

test("the runner starts with its three variables and one Claude credential", () => {
  expect(readEnv({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t" })).toEqual({
    apiUrl: "https://api.ponzu.design",
    designId: "des_1",
    token: "pzr_x",
    port: 4600,
    portToken: "pzp_x",
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

test("the agent's side gets everything but the runner token and the port token", () => {
  const env = { ...base, ANTHROPIC_API_KEY: "k", STRIPE_KEY: "repo secret" };
  const { PONZU_RUNNER_TOKEN: _, PONZU_PORT_TOKEN: __, ...rest } = env;
  expect(agentEnv(env)).toEqual(rest);
  // The runner's own is left as it was.
  expect(env.PONZU_RUNNER_TOKEN).toBe("pzr_x");
});

test("the repo's secrets reach the agent's side only, as they were written", () => {
  const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
  const hostile = 'it\'s $(touch /tmp/pwned) `id` "quoted" ünïcode';
  const env = {
    ...base,
    ANTHROPIC_API_KEY: "k",
    PONZU_REPO_SECRETS: encodeRepoSecrets([
      ["PEM", pem],
      ["HOSTILE", hostile],
      ["BUN_OPTIONS", "--preload=/tmp/x.js"],
    ]),
  };
  // What the runner itself runs with: one variable of base64, nothing a loader reads.
  expect(env.PONZU_REPO_SECRETS).toMatch(/^[A-Z0-9_:A-Za-z+/=,]+$/);
  expect("BUN_OPTIONS" in env).toBe(false);
  const agent = agentEnv(env);
  expect(agent.PEM).toBe(pem);
  expect(agent.HOSTILE).toBe(hostile);
  expect(agent.PONZU_REPO_SECRETS).toBeUndefined();
  expect(agent.PONZU_RUNNER_TOKEN).toBeUndefined();
});

test("a secret never replaces what the runner has, nor brings the runner token back", () => {
  const env = {
    ...base,
    ANTHROPIC_API_KEY: "k",
    PONZU_REPO_SECRETS: encodeRepoSecrets([
      ["HOME", "/tmp/elsewhere"],
      ["ANTHROPIC_API_KEY", "someone else's"],
      ["PONZU_RUNNER_TOKEN", "pzr_forged"],
    ]),
  };
  const agent = agentEnv(env);
  expect(agent.HOME).toBe("/home/user");
  expect(agent.ANTHROPIC_API_KEY).toBe("k");
  expect(agent.PONZU_RUNNER_TOKEN).toBeUndefined();
});

test("a malformed secrets variable costs a secret, not the start", () => {
  const env = {
    ...base,
    ANTHROPIC_API_KEY: "k",
    PONZU_REPO_SECRETS: `lower:YQ==,NOCOLON,BAD:@@@,${encodeRepoSecrets([["GOOD", "yes"]])}`,
  };
  const agent = agentEnv(env);
  expect(agent.GOOD).toBe("yes");
  expect(Object.keys(agent).filter((name) => ["lower", "NOCOLON", "BAD"].includes(name))).toEqual(
    [],
  );
});
