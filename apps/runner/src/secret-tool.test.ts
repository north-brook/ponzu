import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedAgent, type ScriptedRun } from "./agent/scripted.ts";
import { elicitationPlan, permissionOf, toolUseIdOf } from "./agent/sdk.ts";
import { ApiError } from "./api/api.ts";
import { FakeRunnerApi } from "./api/fake.ts";
import { checkSecretName, type RunnerSession } from "./api/protocol.ts";
import { derivedId } from "./ids.ts";
import { Runner, type Timing } from "./run.ts";
import { localSecretWriter, REQUEST_SECRET, secretSavedText } from "./secret-tool.ts";
import { describeStep } from "./steps.ts";

/*
 * A secret the agent asks for and a link it hands off (docs/cloud.md, "Needs you"), against the
 * fake API with a scripted agent: the question, the wait, the one fetch, the file, the scrub.
 */

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 200,
  stopStepMs: 200,
  previewDelayMs: 10,
  restartMs: 10,
  backoff: () => 20,
};

/** What a person pastes: easy to find anywhere it should not be. */
const VALUE = "sk_test_51Hv8QpLx0-very-secret-value";

const REPO: Partial<RunnerSession> = {
  repo: { owner: "fernwood", name: "shop", defaultBranch: "main" },
  branch: "pz/checkout",
};

const open: Runner[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.stop()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-secret-"));
  dirs.push(dir);
  return dir;
}

async function until(check: () => unknown, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

interface Setup {
  api: FakeRunnerApi;
  runner: Runner;
  run: ScriptedRun;
  logs: string[];
  kept: string[];
  folder: string;
}

async function setup(session: Partial<RunnerSession> = REPO, folder?: string): Promise<Setup> {
  const api = new FakeRunnerApi({ session });
  const agent = new ScriptedAgent();
  const work = await temp();
  const dir = folder ?? join(await temp(), "secrets");
  const logs: string[] = [];
  const kept: string[] = [];
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: async () => work,
    stateDir: await temp(),
    secretWriter: localSecretWriter(dir),
    keepSecret: (value) => kept.push(value),
    log: (m) => logs.push(m),
    timing: FAST,
  });
  open.push(runner);
  await runner.start();
  const run = agent.last;
  run.ready("sess_1");
  api.push({ kind: "message", payload: { text: "Turn on test payments" } });
  runner.poke();
  run.take(await run.input());
  return { api, runner, run, logs, kept, folder: dir };
}

const notices = (api: FakeRunnerApi, type: string) =>
  api.items().filter((i) => i.kind === "notice" && i.payload.type === type);

/** Nothing the runner said holds the value: the thread, the state, its log. */
function nowhere(s: Setup) {
  expect(JSON.stringify(s.api.threadWrites)).not.toContain(VALUE);
  expect(JSON.stringify(s.api.states)).not.toContain(VALUE);
  expect(JSON.stringify(s.logs)).not.toContain(VALUE);
  expect(JSON.stringify([...s.api.questions.values()])).not.toContain(VALUE);
  expect(JSON.stringify(s.api.events)).not.toContain(VALUE);
}

test("request_secret is offered for a repo canvas only", async () => {
  const repo = await setup();
  const scratch = await setup({ repo: null, branch: null });
  const names = (run: ScriptedRun) => run.opts.tools.map((t) => t.name);
  expect(names(repo.run)).toContain(REQUEST_SECRET);
  expect(names(scratch.run)).not.toContain(REQUEST_SECRET);
});

test("a secret asked for is a question row; given, it is fetched once into the file, and the agent is told so", async () => {
  const s = await setup();
  const { api, runner, run } = s;

  const result = run.call(REQUEST_SECRET, {
    name: "STRIPE_TEST_KEY",
    description: "Checkout's test mode needs it.",
  });
  // The scripted call is `toolu_1`: the question's id comes from it, as from Claude Code's.
  const id = derivedId("q", "toolu_1");
  await until(() => api.questions.get(id));
  expect(api.questions.get(id)).toMatchObject({
    kind: "secret",
    payload: { name: "STRIPE_TEST_KEY", description: "Checkout's test mode needs it." },
    status: "open",
  });
  await until(() => api.lastState?.state === "needs_you");
  expect(notices(api, "question")[0]?.payload).toEqual({
    type: "question",
    questionId: id,
    header: "Secret",
    text: "Claude needs STRIPE_TEST_KEY to go on.",
  });

  const answer = api.giveSecret(id, VALUE);
  runner.poke();
  const said = await result;

  expect(said).toEqual({ text: secretSavedText("STRIPE_TEST_KEY") });
  expect(said.text).toBe(
    "STRIPE_TEST_KEY is saved to this repository's secrets in Ponzu. It's in the file ~/.ponzu/secrets/STRIPE_TEST_KEY now, and in the environment of every command from the sandbox's next start. Never print it.",
  );
  const file = join(s.folder, "STRIPE_TEST_KEY");
  expect(readFileSync(file, "utf8")).toBe(VALUE);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(api.secrets.get(id)?.delivered).toBe(true);
  expect(s.kept).toEqual([VALUE]);
  // Delivered once the tool's result is in the session.
  await until(() => api.delivered.includes(answer.id));
  await until(() => api.lastState?.state === "working");
  nowhere(s);
});

test("a step that would say the value says the plain words instead", async () => {
  const s = await setup();
  const result = s.run.call(REQUEST_SECRET, { name: "SCRUB_KEY" });
  const id = derivedId("q", "toolu_1");
  await until(() => s.api.questions.get(id));
  s.api.giveSecret(id, VALUE);
  s.runner.poke();
  await result;

  // The agent echoes it in a command: the turn's record and the state never say it.
  const writes = s.api.threadWrites.length;
  s.run.emit({ type: "tool", id: "toolu_echo", name: "Bash", input: { command: `echo ${VALUE}` } });
  await until(() => s.api.threadWrites.length > writes);
  nowhere(s);
});

test("a reserved or malformed name is refused before anyone is asked", async () => {
  const s = await setup();
  for (const name of ["ANTHROPIC_API_KEY", "PATH", "lower_case"]) {
    const said = await s.run.call(REQUEST_SECRET, { name });
    expect(said.isError).toBe(true);
  }
  expect(s.api.questions.size).toBe(0);
});

test("a turn that ends before anyone answers takes the question back, and the tool says why", async () => {
  const s = await setup();
  const result = s.run.call(REQUEST_SECRET, { name: "LATE_KEY" });
  const id = derivedId("q", "toolu_1");
  await until(() => s.api.questions.get(id));

  s.run.end();
  const said = await result;

  expect(said.isError).toBe(true);
  expect(said.text).toContain("The turn ended before anyone answered.");
  await until(() => s.api.questions.get(id)?.status === "cancelled");
});

test("a value that can't be fetched leaves it to the next start, and says so", async () => {
  const s = await setup();
  s.api.failing.set("secret", new ApiError(404, "not_found", "There is no secret to hand over."));
  const result = s.run.call(REQUEST_SECRET, { name: "MISSED_KEY" });
  const id = derivedId("q", "toolu_1");
  await until(() => s.api.questions.get(id));
  s.api.giveSecret(id, VALUE);
  s.runner.poke();

  const said = await result;

  expect(said.text).toBe(
    "MISSED_KEY is saved to this repository's secrets in Ponzu, but couldn't be handed over now. It's in the environment of every command from the sandbox's next start. Never print it.",
  );
  expect(existsSync(join(s.folder, "MISSED_KEY"))).toBe(false);
  expect(s.kept).toEqual([]);
});

test("a secret given after the turn ended goes in as a message that names it and not its value", async () => {
  const s = await setup();
  const result = s.run.call(REQUEST_SECRET, { name: "AFTER_KEY" });
  const id = derivedId("q", "toolu_1");
  await until(() => s.api.questions.get(id));
  s.run.end();
  await result;
  // The question stays open for people, as one an earlier run left would.
  s.api.questions.get(id)!.status = "open";

  s.api.giveSecret(id, VALUE);
  s.runner.poke();
  const input = await s.run.input();

  expect(input.text).toContain("gave the secret you asked for earlier.");
  expect(input.text).toContain(
    "AFTER_KEY is saved to this repository's secrets in Ponzu, and in the environment of every command from the sandbox's next start.",
  );
  expect(input.text).not.toContain(VALUE);
});

test("a start clears what an earlier start was given", async () => {
  const folder = join(await temp(), "secrets");
  await localSecretWriter(folder).write("OLD_KEY", "old");
  await writeFile(join(folder, "STRAY"), "x");
  await setup(REPO, folder);
  expect(existsSync(folder)).toBe(false);
});

test("an MCP server's link is a hand-off: done or not now goes back, with no tool result to wait for", async () => {
  const s = await setup();
  const ask = {
    kind: "handoff" as const,
    title: "Sign in to Linear",
    url: "https://linear.app/oauth/authorize",
    description: "Linear needs you to sign in.",
  };
  const replied = s.run.elicit("elicit:el_1", ask);
  const id = derivedId("q", "elicit:el_1");
  await until(() => s.api.questions.get(id));
  expect(s.api.questions.get(id)).toMatchObject({
    kind: "handoff",
    payload: { title: ask.title, url: ask.url, description: ask.description },
  });
  expect(notices(s.api, "question")[0]?.payload).toMatchObject({
    header: "Over to you",
    text: "Sign in to Linear",
  });

  const answer = s.api.answer({ questionId: id, approved: true });
  s.runner.poke();

  expect((await replied)?.approved).toBe(true);
  await until(() => s.api.delivered.includes(answer.id));
});

test("an MCP server's form is declined, and the thread says so once", async () => {
  const s = await setup();
  s.run.emit({ type: "declined", server: "linear" });
  await until(() => notices(s.api, "error").length > 0);
  expect(notices(s.api, "error").map((n) => n.payload)).toEqual([
    {
      type: "error",
      code: "elicitation_unsupported",
      message: "linear asked for details Ponzu can't show yet, so Claude went on without them.",
    },
  ]);
});

test("elicitations: a web address is a hand-off, a form is declined, anything else refused", () => {
  expect(
    elicitationPlan({
      serverName: "linear",
      message: "Sign in to go on.",
      mode: "url",
      url: "https://linear.app/oauth",
      elicitationId: "el_1",
    }),
  ).toEqual({
    kind: "ask",
    ask: {
      kind: "handoff",
      title: "linear",
      url: "https://linear.app/oauth",
      description: "Sign in to go on.",
    },
  });
  expect(
    elicitationPlan({
      serverName: "s",
      message: "m",
      mode: "url",
      url: "https://x.test",
      title: "Sign in",
    }),
  ).toMatchObject({ ask: { title: "Sign in" } });
  expect(
    elicitationPlan({ serverName: "s", message: "m", mode: "form", requestedSchema: {} }),
  ).toEqual({ kind: "form" });
  expect(elicitationPlan({ serverName: "s", message: "m" })).toEqual({ kind: "form" });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url", undefined]) {
    expect(elicitationPlan({ serverName: "s", message: "m", mode: "url", url })).toEqual({
      kind: "refuse",
    });
  }
});

test("canUseTool's answers, and the tool call's id from Claude Code's request", () => {
  const input = { questions: [] };
  expect(permissionOf("AskUserQuestion", input, { answers: { "Which?": "A" } }, "")).toEqual({
    behavior: "allow",
    updatedInput: { questions: [], answers: { "Which?": "A" } },
  });
  expect(permissionOf("ExitPlanMode", { plan: "x" }, { approved: true }, "")).toEqual({
    behavior: "allow",
    updatedInput: { plan: "x" },
  });
  expect(permissionOf("Bash", {}, { approved: false, note: "No" }, "")).toEqual({
    behavior: "deny",
    message: "The person said no. They said: No",
  });
  expect(permissionOf("Bash", {}, null, "The turn was stopped.")).toEqual({
    behavior: "deny",
    message: "The turn was stopped.",
  });
  expect(toolUseIdOf({ _meta: { "claudecode/toolUseId": "toolu_9" } })).toBe("toolu_9");
  expect(toolUseIdOf({})).toBeUndefined();
  expect(toolUseIdOf(undefined)).toBeUndefined();
});

test("the step says the name being asked for, and never anything that isn't one", () => {
  const ctx = { doc: { pages: [] } as never };
  expect(
    describeStep(`mcp__ponzu__${REQUEST_SECRET}`, { name: "STRIPE_TEST_KEY" }, ctx),
  ).toMatchObject({
    doing: "Asking for STRIPE_TEST_KEY",
    done: "Asked for STRIPE_TEST_KEY",
  });
  expect(describeStep(`mcp__ponzu__${REQUEST_SECRET}`, { name: "sk-live-123" }, ctx)).toMatchObject(
    {
      doing: "Asking for a secret",
    },
  );
});

test("one rule for a secret's name, shared with the API", () => {
  expect(checkSecretName("STRIPE_TEST_KEY")).toBeNull();
  expect(checkSecretName("NODE_AUTH_TOKEN")).toBeNull();
  expect(checkSecretName("PONZU_RUNNER_TOKEN")).toBe("reserved");
  expect(checkSecretName("HTTPS_PROXY")).toBe("reserved");
  expect(checkSecretName("a")).toBe("invalid");
  expect(checkSecretName(`K${"X".repeat(64)}`)).toBe("invalid");
});
