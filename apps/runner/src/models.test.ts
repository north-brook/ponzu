import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { OfferedModels } from "./agent/agent.ts";
import recorded from "./agent/fixtures/supported-models.api-key.json";
import { reportedModels, sameModels } from "./agent/models.ts";
import { ScriptedAgent } from "./agent/scripted.ts";
import { FakeRunnerApi } from "./api/fake.ts";
import { ApiError } from "./api/request.ts";
import { Runner, type Timing } from "./run.ts";

/*
 * The runner telling the API what Claude Code offers the account it runs as (docs/cloud.md,
 * "Models"): once for each start of Claude Code at most, and only when it says something the API
 * does not hold already.
 */

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 1_000,
  stopStepMs: 500,
  restartMs: 10,
  backoff: () => 20,
};

const open: Runner[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.stop()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function until(check: () => unknown, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-models-"));
  dirs.push(dir);
  return dir;
}

/** A runner on `api` and `agent`, with the events it says. */
async function start(api: FakeRunnerApi, agent: ScriptedAgent, timing: Partial<Timing> = {}) {
  const events: { name: string; fields: Record<string, unknown> }[] = [];
  const work = await temp();
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: async () => work,
    stateDir: await temp(),
    log: () => {},
    event: (name, fields) => events.push({ name, fields }),
    onFatal: () => {},
    timing: { ...FAST, ...timing },
  });
  open.push(runner);
  await runner.start();
  /** The models events said so far. */
  const said = () => events.filter((e) => e.name.startsWith("models_")).map((e) => e.name);
  return { runner, said };
}

const OFFERED: OfferedModels = {
  claudeCode: recorded.claudeCode,
  models: reportedModels(recorded.models as ModelInfo[]),
};

test("the recorded answer is reported as Claude Code gave it, effort levels included", () => {
  expect(OFFERED.models.map((m) => [m.value, m.resolvedModel])).toEqual([
    ["default", "claude-opus-5-5"],
    ["opus", "claude-opus-5-5"],
    ["fable", "claude-fable-5-2"],
    ["sonnet", "claude-sonnet-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ]);
  expect(OFFERED.models[2]).toEqual({
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable",
    description:
      "Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  });
});

test("an entry that takes no effort says so, and one that does not say is left unsaid", () => {
  const [none, unsaid] = reportedModels([
    { value: "a", displayName: "A", description: "", supportsEffort: false },
    { value: "b", displayName: "B", description: "" },
  ]);
  expect(none?.efforts).toEqual([]);
  expect(unsaid?.efforts).toBeNull();
  expect(unsaid?.resolvedModel).toBeNull();
});

test("an entry whose id is too long to send is left out, not clipped into another id", () => {
  const long = `claude-${"x".repeat(200)}`;
  const reported = reportedModels([
    { value: long, displayName: "Long", description: "" },
    { value: "opus", resolvedModel: long, displayName: "Opus", description: "" },
    { value: "", displayName: "Empty", description: "" },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" },
  ]);
  expect(reported.map((m) => m.value)).toEqual(["haiku"]);
});

test("a runner reports what Claude Code offers once, and a later start that hears the same does not", async () => {
  const api = new FakeRunnerApi();
  const agent = new ScriptedAgent();
  agent.offers = OFFERED;
  const first = await start(api, agent);
  await until(() => first.said().length === 1);
  expect(first.said()).toEqual(["models_reported"]);
  expect(api.modelReports).toEqual([{ claudeCode: "2.1.322", models: OFFERED.models }]);

  // Claude Code started again in the same runner: the same answer, nothing sent.
  agent.last.crash();
  await agent.run(2);
  await until(() => first.said().length === 2);
  expect(first.said()).toEqual(["models_reported", "models_held"]);

  // A new runner process, whose session says what the API holds.
  await first.runner.stop();
  const second = await start(api, agent);
  await until(() => second.said().length === 1);
  expect(second.said()).toEqual(["models_held"]);
  expect(api.modelReports).toHaveLength(1);
});

test("it reports again when Claude Code offers something else, or is another Claude Code", async () => {
  const api = new FakeRunnerApi();
  const agent = new ScriptedAgent();
  agent.offers = OFFERED;
  const s = await start(api, agent);
  await until(() => api.modelReports.length === 1);

  // A model gone from the account.
  agent.offers = { ...OFFERED, models: OFFERED.models.filter((m) => m.value !== "fable") };
  agent.last.crash();
  await agent.run(2);
  await until(() => api.modelReports.length === 2);
  expect(api.modelReports[1]?.models.map((m) => m.value)).toEqual([
    "default",
    "opus",
    "sonnet",
    "haiku",
  ]);

  // The same models from a newer Claude Code.
  agent.offers = { ...agent.offers, claudeCode: "2.1.400" };
  agent.last.crash();
  await agent.run(3);
  await until(() => api.modelReports.length === 3);
  expect(api.modelReports[2]?.claudeCode).toBe("2.1.400");
  expect(s.said()).toEqual(["models_reported", "models_reported", "models_reported"]);
});

test("what the API holds a day after it was reported is reported again", async () => {
  const api = new FakeRunnerApi({
    session: {
      models: {
        claudeCode: "2.1.322",
        models: OFFERED.models,
        at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      },
    },
  });
  const agent = new ScriptedAgent();
  agent.offers = OFFERED;
  const s = await start(api, agent);
  await until(() => s.said().length === 1);
  expect(s.said()).toEqual(["models_reported"]);
  expect(api.modelReports).toHaveLength(1);
});

test("a report the API did not keep is sent again at the next start of Claude Code", async () => {
  const api = new FakeRunnerApi();
  api.keepModels = false;
  const agent = new ScriptedAgent();
  agent.offers = OFFERED;
  await start(api, agent);
  await until(() => api.modelReports.length === 1);
  agent.last.crash();
  await agent.run(2);
  await until(() => api.modelReports.length === 2);
});

test("a report that hangs or is refused holds up no turn, and the runner carries on", async () => {
  const api = new FakeRunnerApi();
  const agent = new ScriptedAgent();
  agent.offers = OFFERED;
  // The first report never answers until the end of the test; the next one is refused.
  let answer: (() => void) | undefined;
  const reportModels = api.reportModels.bind(api);
  api.reportModels = (runner, report) =>
    new Promise<void>((resolve) => {
      answer = resolve;
    }).then(() => reportModels(runner, report));
  const s = await start(api, agent);
  await until(() => answer);

  const say = async (text: string) => {
    api.push({ kind: "message", payload: { text } });
    s.runner.poke();
    const run = agent.last;
    run.take(await run.input());
    run.say(`m_${text}`, text);
    run.end();
    await until(() => api.items().some((i) => i.kind === "assistant" && i.payload.text === text));
  };
  agent.last.ready("sess_1");
  await say("Drawn while the report hangs.");
  expect(api.modelReports).toEqual([]);

  api.reportModels = reportModels;
  api.failing.set("reportModels", new ApiError(400, "invalid_request", "No."));
  agent.last.crash();
  await agent.run(2);
  await until(() => api.calls.filter((c) => c === "reportModels").length === 1);
  agent.last.ready("sess_1");
  await say("Drawn after the report was refused.");
  expect(s.said()).toEqual([]);
  // The hung one answers at last, and is kept.
  api.failing.delete("reportModels");
  answer!();
  await until(() => s.said().length === 1);
  expect(s.said()).toEqual(["models_reported"]);
});

test("Claude Code that says nothing of its models sends nothing", async () => {
  const api = new FakeRunnerApi();
  const agent = new ScriptedAgent();
  const s = await start(api, agent);
  agent.last.ready("sess_1");
  // The runner is up and has heard Claude Code; it reported nothing and said nothing of models.
  await until(() => api.lastState?.claudeSessionId === "sess_1");
  expect(api.modelReports).toEqual([]);
  expect(s.said()).toEqual([]);
});

test("two reports are the same only when every entry is, in order", () => {
  const [a, b] = OFFERED.models;
  expect(sameModels([a!, b!], [a!, b!])).toBe(true);
  expect(sameModels([a!, b!], [b!, a!])).toBe(false);
  expect(sameModels([a!], [{ ...a!, efforts: ["low"] }])).toBe(false);
});
