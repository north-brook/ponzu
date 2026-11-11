import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Doc, emptyDoc, findArtboard, parseHtml } from "@ponzu/core";
import type { Renderer, RenderRequest } from "@ponzu/render";
import { ScriptedAgent, type ScriptedRun } from "./agent/scripted.ts";
import { ApiError } from "./api/api.ts";
import { ADA, FakeRunnerApi } from "./api/fake.ts";
import type { AskedQuestion, RunnerSession } from "./api/protocol.ts";
import { derivedId, eventUuid, randomId } from "./ids.ts";
import { Runner, type Timing } from "./run.ts";

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 1_000,
  stopStepMs: 500,
  previewDelayMs: 10,
  restartMs: 10,
  backoff: () => 20,
};

const ada: Actor = { kind: "user", id: ADA.id, name: ADA.name };

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

/** A design with one page and a Pricing artboard, as the API has it. */
function pricing(): Doc {
  const doc = emptyDoc("Fern");
  doc.pages.push({
    id: "pg_home",
    name: "Home",
    artboards: [
      {
        id: "ab_pricing",
        name: "Pricing",
        x: 0,
        y: 0,
        root: {
          kind: "el",
          id: "ab_pricing",
          tag: "section",
          name: "Pricing",
          attrs: {},
          style: { width: "800px", height: "600px" },
          children: parseHtml(`<p data-id="n_plan">Free</p>`).nodes,
        },
      },
    ],
  });
  return doc;
}

const HEADLINE: AskedQuestion = {
  header: "Headline",
  question: "The headline runs to three lines at 390px. Which way?",
  options: [
    { label: "Shorten it", description: "Two lines on phones." },
    { label: "Let it wrap", description: "Three lines." },
  ],
  multiSelect: false,
};

interface Setup {
  api: FakeRunnerApi;
  agent: ScriptedAgent;
  runner: Runner;
  run: ScriptedRun;
  logs: string[];
  stateDir: string;
  fatal: string[];
}

async function setup(
  opts: {
    api?: FakeRunnerApi;
    agent?: ScriptedAgent;
    session?: Partial<RunnerSession>;
    doc?: Doc;
    prepare?: (session: RunnerSession) => Promise<string>;
    stateDir?: string;
    timing?: Partial<Timing>;
    renderer?: Renderer;
    flush?: () => void;
  } = {},
): Promise<Setup> {
  const api = opts.api ?? new FakeRunnerApi({ session: opts.session, doc: opts.doc });
  const agent = opts.agent ?? new ScriptedAgent();
  const stateDir = opts.stateDir ?? (await temp());
  const logs: string[] = [];
  const fatal: string[] = [];
  const work = await temp();
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: opts.prepare ?? (async () => work),
    renderer: opts.renderer,
    flush: opts.flush,
    stateDir,
    log: (m) => logs.push(m),
    onFatal: (reason) => fatal.push(reason),
    timing: { ...FAST, ...opts.timing },
  });
  open.push(runner);
  await runner.start();
  return { api, agent, runner, run: agent.last, logs, stateDir, fatal };
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-runner-"));
  dirs.push(dir);
  return dir;
}

/** A message in, taken: a turn running. */
async function turn(s: Setup, text = "Go"): Promise<void> {
  s.api.push({ kind: "message", payload: { text } });
  s.runner.poke();
  s.run.take(await s.run.input());
}

const notices = (api: FakeRunnerApi, type: string) =>
  api.items().filter((i) => i.kind === "notice" && i.payload.type === type);

/* ------------------------------------------------------------------ */
/* Starting                                                            */
/* ------------------------------------------------------------------ */

test("the thread shows the runner waking while the checkout is made, then a new session", async () => {
  let cloned: (() => void) | undefined;
  const work = await temp();
  const api = new FakeRunnerApi();
  const starting = setup({
    api,
    prepare: () =>
      new Promise((resolve) => {
        cloned = () => resolve(work);
      }),
  });
  await until(() => cloned && api.items()[0]);
  expect(api.items()[0]).toMatchObject({
    kind: "notice",
    payload: { type: "waking" },
    streaming: true,
  });
  expect(api.lastState).toMatchObject({ state: "working", status: "Waking up" });

  cloned!();
  const { run } = await starting;
  expect(run.opts.resume).toBeNull();
  expect(run.opts.instructions).toContain("Ponzu's canvas tools");
  expect(run.opts.instructions).toContain("no repository");
  expect(run.opts.instructions).toContain('Lines that start with "> " quote');
  expect(run.opts.tools.map((t) => t.name)).toContain("create_artboard");
  await until(() => !api.items()[0]!.streaming);
  expect(api.items()[0]!.payload).toEqual({ type: "started" });
  await until(() => api.lastState?.state === "idle");

  run.ready("sess_new");
  await until(() => api.lastState?.claudeSessionId === "sess_new");
});

test("what a turn wrote is flushed to the disk once it has ended and settled, not before", async () => {
  let flushes = 0;
  const s = await setup({ flush: () => flushes++ });
  s.run.ready();
  await turn(s);
  s.run.say("m1", "Drawn.");
  expect(flushes).toBe(0);
  s.run.end();
  await until(() => flushes === 1);
});

test("a poke while the runner is starting waits for the claim that ends the start", async () => {
  const agent = new ScriptedAgent();
  const api = new FakeRunnerApi();
  const work = await temp();
  let cloned: (() => void) | undefined;
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: () => new Promise((resolve) => (cloned = () => resolve(work))),
    stateDir: await temp(),
    log: () => {},
    timing: FAST,
  });
  open.push(runner);
  const starting = runner.start();
  await until(() => cloned);
  const event = api.push({ kind: "message", payload: { text: "Early" } });
  runner.poke();
  await Bun.sleep(20);
  expect(api.calls).not.toContain("claim");
  cloned!();
  await starting;
  expect((await agent.last.input()).uuid).toBe(eventUuid(event.id));
});

test("a runner starting for a message says it is waking until its first claim, never idle", async () => {
  const api = new FakeRunnerApi();
  api.push({ kind: "message", payload: { text: "Make the card" } });
  // A claim takes a while to come back, as over the network: long enough for a heartbeat.
  api.slow.set("claim", 60);
  const s = await setup({ api });
  await until(() => s.agent.runs.length > 0);
  await Bun.sleep(30);
  const said = api.states.map((r) => r.state);
  expect(said.length).toBeGreaterThan(0);
  expect(said).not.toContain("idle");
  expect(said.at(-1)).toBe("working");
});

test("a runner with nothing to claim goes from waking to idle once its claim is answered", async () => {
  const api = new FakeRunnerApi();
  api.slow.set("claim", 40);
  await setup({ api });
  await until(() => api.states.at(-1)?.state === "idle");
  const said = api.states.map((r) => r.state);
  expect(said.indexOf("idle")).toBeGreaterThan(said.indexOf("working"));
});

test("a design with a session resumes it, and what an earlier run asked stays open", async () => {
  const agent = new ScriptedAgent();
  agent.sessions.set("sess_old", { messages: new Set(), toolResults: new Set() });
  const api = new FakeRunnerApi({
    session: { claudeSessionId: "sess_old", openQuestions: ["q_stale"] },
  });
  api.questions.set("q_stale", {
    id: "q_stale",
    kind: "question",
    payload: { questions: [HEADLINE] },
    status: "open",
  });
  const { runner, run } = await setup({ api, agent });
  expect(run.opts.resume).toBe("sess_old");
  await until(() => api.items()[0] && !api.items()[0]!.streaming);
  expect(api.items()[0]!.payload).toEqual({ type: "resumed" });
  // Nobody waits on it, but the person can still answer, so the design needs them.
  await until(() => api.lastState?.state === "needs_you");
  expect(api.lastState?.claudeSessionId).toBe("sess_old");
  expect(api.questions.get("q_stale")?.status).toBe("open");

  const answer = api.answer({
    questionId: "q_stale",
    answers: { [HEADLINE.question]: "Shorten it" },
  });
  runner.poke();
  const input = await run.input();
  expect(input.text).toBe(
    `Ada answered the question you asked earlier:\n"${HEADLINE.question}": Shorten it`,
  );
  run.take(input);
  await until(() => api.delivered.includes(answer.id));
});

test("a question an earlier run left open is withdrawn once the next turn ends", async () => {
  const api = new FakeRunnerApi({ session: { openQuestions: ["q_stale"] } });
  api.questions.set("q_stale", {
    id: "q_stale",
    kind: "plan",
    payload: { plan: "" },
    status: "open",
  });
  const s = await setup({ api });
  await turn(s, "Something else");
  s.run.end();
  await until(() => api.questions.get("q_stale")?.status === "cancelled");
  await until(() => api.lastState?.state === "idle");
});

test("a session whose transcript is gone starts over instead of failing to resume", async () => {
  const { run } = await setup({ session: { claudeSessionId: "sess_lost" } });
  expect(run.opts.resume).toBeNull();
});

test("a transcript that can't be read starts a new session instead of stopping the runner", async () => {
  const agent = new ScriptedAgent();
  agent.historyError = new Error("EACCES: permission denied");
  const { run, logs } = await setup({ agent, session: { claudeSessionId: "sess_1" } });
  expect(run.opts.resume).toBeNull();
  expect(logs.join("\n")).toContain("EACCES");
});

test("a clone that fails is said in the thread and the state, and the agent is told the truth", async () => {
  const scratch = await temp();
  const { api, run } = await setup({
    session: {
      repo: { owner: "north", name: "fern", defaultBranch: "main" },
      branch: "pz/hero",
    },
    prepare: async (session) => {
      if (session.repo) throw new Error("Ponzu could not get north/fern: Repository not found.");
      return scratch;
    },
  });
  await until(() => notices(api, "error").length);
  expect(notices(api, "error")[0]!.payload).toEqual({
    type: "error",
    code: "clone_failed",
    message: "Ponzu could not get north/fern: Repository not found.",
  });
  await until(() => api.lastState?.status === "Couldn't get the repository");
  expect(run.opts.cwd).toBe(scratch);
  expect(run.opts.instructions).toContain(
    "The design's repository, north/fern, could not be checked out (Ponzu could not get north/fern: Repository not found.)",
  );
  expect(run.opts.instructions).not.toContain("no repository");
});

test("a repo design is told where its checkout is and that Ponzu opens the pull request", async () => {
  const root = await temp();
  const { run } = await setup({
    session: { repo: { owner: "north", name: "fern", defaultBranch: "main" }, branch: "pz/hero" },
    prepare: async () => join(root, "fern"),
  });
  expect(run.opts.instructions).toContain("north/fern is checked out at");
  expect(run.opts.instructions).toContain("pz/hero");
  expect(run.opts.instructions).toContain("Ponzu opens and merges the pull request");
  expect(run.opts.instructions).toContain("give it one in your first turn with update_design");
});

test("a repo design's agent describes its pull request, which the API keeps", async () => {
  const root = await temp();
  const { run, api } = await setup({
    session: { repo: { owner: "north", name: "fern", defaultBranch: "main" }, branch: "pz/hero" },
    prepare: async () => join(root, "fern"),
  });
  expect(run.opts.instructions).toContain("describe_pull_request");
  const describe = run.opts.tools.find((t) => t.name === "describe_pull_request")!;
  const result = await describe.run({ summary: "Adds the **Pro** pricing card." });
  expect(result.text).toContain("when Ponzu opens it");
  expect(api.summaries).toEqual(["Adds the **Pro** pricing card."]);
});

test("a Scratch design has no pull request to describe", async () => {
  const { run } = await setup();
  expect(run.opts.tools.map((t) => t.name)).not.toContain("describe_pull_request");
});

/* ------------------------------------------------------------------ */
/* The lease                                                           */
/* ------------------------------------------------------------------ */

test("a second runner for the design takes over: the first stops for good, and nothing goes in twice", async () => {
  const api = new FakeRunnerApi();
  const first = await setup({ api });
  const second = await setup({ api });
  api.push({ kind: "message", payload: { text: "Draw it" } });
  first.runner.poke();
  second.runner.poke();
  await second.run.input();
  await until(() => first.fatal.length === 1);
  expect(first.fatal[0]).toContain("Another runner took over");
  expect(first.run.inputs).toEqual([]);
  expect(first.run.closed).toBe(true);
  expect(second.fatal).toEqual([]);
});

test("a token the API revokes stops the runner for good, mid-life too", async () => {
  const { api, runner, run, fatal } = await setup();
  api.revoked = true;
  runner.poke();
  await until(() => fatal.length === 1);
  expect(fatal[0]).toContain("refused the runner token");
  expect(run.closed).toBe(true);
});

test("a fake that outlives its process goes on numbering its feed, as the API never reuses an id", () => {
  const before = new FakeRunnerApi();
  before.push({ kind: "message", payload: { text: "one" } });
  const after = new FakeRunnerApi({ feedSeq: before.feedSeq });
  expect(after.push({ kind: "message", payload: { text: "two" } }).id).toBe("evt_0002");
});

test("git's credential is asked through the lease, and only the live runner gets one", async () => {
  const api = new FakeRunnerApi({
    session: { repo: { owner: "north", name: "fern", defaultBranch: "main" }, branch: "pz/hero" },
  });
  const ask = { protocol: "https", host: "github.com", path: "north/fern.git" };
  const first = await setup({ api });
  expect((await first.runner.gitCredential(ask)).password).toBe("ghs_fake");
  await first.runner.eraseGitCredential(ask);
  expect(api.erased).toEqual([ask]);

  // A newer runner took the design: the older one's git gets nothing, and it stops.
  await setup({ api });
  await expect(first.runner.gitCredential(ask)).rejects.toThrow("A newer runner");
  await until(() => first.fatal.length === 1);
});

/* ------------------------------------------------------------------ */
/* Events in                                                           */
/* ------------------------------------------------------------------ */

test("a message goes in at once, and is acknowledged once the session holds it, naming the session", async () => {
  const { api, runner, run } = await setup();
  run.ready("sess_1");
  const event = api.push({ kind: "message", payload: { text: "Make the hero quieter." } });
  runner.poke();
  const input = await run.input();
  expect(input).toEqual({
    uuid: eventUuid(event.id),
    text: "Message from Ada:\nMake the hero quieter.",
    priority: "now",
    human: true,
  });
  await until(() => api.lastState?.state === "working");
  await Bun.sleep(30);
  expect(api.delivered).toEqual([]);

  run.take(input);
  await until(() => api.delivered.length === 1);
  expect(api.delivered).toEqual([event.id]);
});

test("an ack waits for the session's id, and carries it, so a failing state report can't lose it", async () => {
  const { api, runner, run } = await setup();
  api.failing.set("putState", new TypeError("fetch failed"));
  const event = api.push({ kind: "message", payload: { text: "Draw it" } });
  runner.poke();
  // Claude Code takes the message before it says which session it is.
  run.take(await run.input());
  await Bun.sleep(40);
  expect(api.delivered).toEqual([]);
  run.ready("sess_new");
  await until(() => api.delivered.includes(event.id));
  expect(api.sessionInfo.claudeSessionId).toBe("sess_new");
  // The next runner resumes the session the message went into.
  expect((await api.session()).claudeSessionId).toBe("sess_new");
});

test("a message that arrives mid-turn goes in mid-turn, not after it", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s, "Start");
  await s.run.call("get_basic_info");

  const comment = s.api.push({
    kind: "comment",
    payload: {
      threadId: "th_1",
      messageId: "m_1",
      text: "Too many words here.",
      reply: false,
      artboardId: "ab_pricing",
      artboardName: "Pricing",
      nodeId: "n_plan",
    },
  });
  s.runner.poke();
  const input = await s.run.input(2);
  expect(input.priority).toBe("now");
  expect(input.uuid).toBe(eventUuid(comment.id));
  expect(input.text).toBe(
    'Comment from Ada on "Pricing" (artboard ab_pricing), pinned to node n_plan, thread th_1:\n> Too many words here.',
  );
});

test("other comments, checks and reviews wait for the step running now", async () => {
  const { api, runner, run } = await setup();
  api.push(
    {
      kind: "check",
      payload: { name: "test", conclusion: "failure", url: "https://ci/1", summary: "1 failed" },
    },
    { priority: "next", from: null },
  );
  runner.poke();
  const input = await run.input();
  expect(input.priority).toBe("next");
  expect(input.human).toBe(false);
  expect(input.text).toBe(
    'A check failed on the pull request: "test" (failure).\nDetails: https://ci/1\nWhat it reported:\n> 1 failed',
  );
});

test("a canvas edit never starts a turn: it goes into the session aside, and is acknowledged", async () => {
  const { api, runner, run } = await setup({ doc: pricing() });
  run.ready("sess_1");
  const edit = api.push(
    {
      kind: "edit",
      payload: { summary: 'moved "Pricing"', artboards: [{ id: "ab_pricing", name: "Pricing" }] },
    },
    { priority: "later" },
  );
  runner.poke();
  const input = await run.input();
  expect(input).toEqual({
    uuid: eventUuid(edit.id),
    text: 'Canvas edit by Ada: moved "Pricing"\nArtboards: "Pricing" (ab_pricing)',
    priority: "aside",
    human: false,
  });
  run.take(input);
  await until(() => api.delivered.includes(edit.id));
  await Bun.sleep(20);
  expect(api.lastState?.state).toBe("idle");
});

test("an edit during a turn goes in right after the agent's next canvas tool call", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  const edit = s.api.push(
    { kind: "edit", payload: { summary: "renamed a page", artboards: [] } },
    { priority: "later" },
  );
  s.runner.poke();
  await until(() => s.api.calls.filter((c) => c === "claim").length >= 3);
  await Bun.sleep(20);
  expect(s.run.inputs.length).toBe(1);
  await s.run.call("get_tree");
  const input = await s.run.input(2);
  expect(input).toMatchObject({ uuid: eventUuid(edit.id), priority: "next" });
});

test("an edit the turn never reached goes in aside when the turn ends", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  const edit = s.api.push(
    { kind: "edit", payload: { summary: "renamed a page", artboards: [] } },
    { priority: "later" },
  );
  s.runner.poke();
  await until(() => s.api.calls.filter((c) => c === "claim").length >= 3);
  s.run.end();
  const input = await s.run.input(2);
  expect(input).toMatchObject({ uuid: eventUuid(edit.id), priority: "aside" });
});

test("a claim that comes back full is followed by another, so nothing waits behind old events", async () => {
  const { api, runner, run } = await setup();
  for (let i = 0; i < 130; i++)
    api.push(
      { kind: "edit", payload: { summary: `edit ${i}`, artboards: [] } },
      { priority: "later" },
    );
  const message = api.push({ kind: "message", payload: { text: "And now this" } });
  runner.poke();
  await until(() => run.inputs.some((i) => i.uuid === eventUuid(message.id)));
  expect(run.inputs.length).toBe(131);
});

test("a claim whose answer was lost is sent again as the same claim, and hands out what it took", async () => {
  const api = new FakeRunnerApi();
  const message = api.push({ kind: "message", payload: { text: "Draw it" } });
  api.lostAnswers.add("claim");
  const { run, runner } = await setup({ api });
  const input = await run.input();
  expect(input.uuid).toBe(eventUuid(message.id));
  expect(api.claimIds[1]).toBe(api.claimIds[0]!);
  api.push({ kind: "message", payload: { text: "And this" } });
  runner.poke();
  await until(() => run.inputs.length === 2);
  expect(new Set(api.claimIds).size).toBe(2);
});

test("a runner that dies before the session holds an event: the next one gets it and puts it in", async () => {
  const stateDir = await temp();
  const first = await setup({ stateDir });
  first.run.ready("sess_1");
  const event = first.api.push({ kind: "message", payload: { text: "Draw it" } });
  first.runner.poke();
  await first.run.input();
  await first.runner.stop();
  expect(first.api.delivered).toEqual([]);

  const agent = new ScriptedAgent();
  agent.sessions.set("sess_1", { messages: new Set(), toolResults: new Set() });
  first.api.sessionInfo.claudeSessionId = "sess_1";
  const second = await setup({ api: first.api, agent, stateDir });
  const again = await second.run.input();
  expect(again.uuid).toBe(eventUuid(event.id));
  second.run.take(again);
  await until(() => first.api.delivered.includes(event.id));
});

test("a runner that dies after the session took an event: the next acknowledges it without putting it in again", async () => {
  const api = new FakeRunnerApi({ session: { claudeSessionId: "sess_1" } });
  const event = api.push({ kind: "message", payload: { text: "Draw it" } });
  await (await api.connect()).claim({ claimId: randomId("clm") });
  const agent = new ScriptedAgent();
  agent.sessions.set("sess_1", {
    messages: new Set([eventUuid(event.id)]),
    toolResults: new Set(),
  });
  const { run } = await setup({ api, agent });
  await until(() => api.delivered.includes(event.id));
  expect(run.inputs).toEqual([]);
});

test("an answer the session already holds as a tool result is not put in again", async () => {
  const api = new FakeRunnerApi({ session: { claudeSessionId: "sess_1" } });
  const questionId = derivedId("q", "toolu_ask");
  api.questions.set(questionId, {
    id: questionId,
    kind: "plan",
    payload: { plan: "" },
    status: "open",
  });
  const answer = api.answer({ questionId, approved: true });
  const agent = new ScriptedAgent();
  agent.sessions.set("sess_1", { messages: new Set(), toolResults: new Set(["toolu_ask"]) });
  const { run } = await setup({ api, agent });
  await until(() => api.delivered.includes(answer.id));
  expect(run.inputs).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Needs you                                                           */
/* ------------------------------------------------------------------ */

test("a question becomes a question row and needs you, and its answer goes back to the agent", async () => {
  const s = await setup();
  const { api, runner, run } = s;
  run.ready("sess_1");
  await turn(s, "Pick a headline");

  const replied = run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  const id = derivedId("q", "toolu_ask");
  await until(() => api.questions.get(id));
  expect(api.questions.get(id)).toMatchObject({
    kind: "question",
    payload: { questions: [HEADLINE] },
    status: "open",
  });
  await until(() => api.lastState?.state === "needs_you");
  expect(notices(api, "question")[0]?.payload).toEqual({
    type: "question",
    questionId: id,
    header: "Headline",
    text: HEADLINE.question,
  });

  const answer = api.answer({ questionId: id, answers: { [HEADLINE.question]: "Shorten it" } });
  runner.poke();
  expect(await replied).toEqual({
    answers: { [HEADLINE.question]: "Shorten it" },
    approved: undefined,
    note: undefined,
  });
  await until(() => api.lastState?.state === "working");
  // Not delivered until the answer is in the session as the question's tool result.
  await Bun.sleep(30);
  expect(api.delivered).not.toContain(answer.id);
  run.answered("toolu_ask");
  await until(() => api.delivered.includes(answer.id));
});

test("a question raised while the API is out of reach is raised once it is back", async () => {
  const s = await setup();
  await turn(s);
  s.api.failing.set("ask", new TypeError("fetch failed"));
  void s.run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  // Far more tries than any limit would allow.
  await until(() => s.api.calls.filter((c) => c === "ask").length >= 12, 3_000);
  s.api.failing.delete("ask");
  await until(() => s.api.questions.get(derivedId("q", "toolu_ask"))?.status === "open");
});

test("a question the API refuses is taken back from the agent, which goes on, and the thread says so", async () => {
  const s = await setup();
  await turn(s);
  s.api.failing.set("ask", new ApiError(400, "invalid_request", "Too many options."));
  const replied = await s.run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  expect(replied).toBeNull();
  expect(s.run.withdrawn.get("toolu_ask")).toContain("could not show this question");
  await until(() => notices(s.api, "error").length);
  expect(notices(s.api, "error")[0]!.payload).toMatchObject({ code: "question_failed" });
  await until(() => s.api.lastState?.state === "working");
});

test("a question still open when the turn ends is withdrawn", async () => {
  const s = await setup();
  await turn(s, "Plan it");
  const replied = s.run.ask("toolu_plan", { kind: "plan", plan: "1. Draw\n2. Ship" });
  const id = derivedId("q", "toolu_plan");
  await until(() => s.api.questions.get(id));
  expect(s.api.questions.get(id)?.payload).toEqual({ plan: "1. Draw\n2. Ship" });
  s.run.end({ error: { code: "interrupted", message: "stopped" } });
  expect(await replied).toBeNull();
  await until(() => s.api.questions.get(id)?.status === "cancelled");
  await until(() => s.api.lastState?.state === "idle");
});

test("a question stays open while the sandbox sleeps, and its answer reaches the next run", async () => {
  const stateDir = await temp();
  const first = await setup({ stateDir });
  first.run.ready("sess_1");
  await turn(first, "Pick a headline");
  void first.run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  const id = derivedId("q", "toolu_ask");
  await until(() => first.api.questions.get(id));
  await first.runner.stop();
  // The ask is denied in the session, but people can still answer the question.
  expect(first.run.withdrawn.get("toolu_ask")).toBe("The sandbox is going to sleep.");
  expect(first.api.questions.get(id)?.status).toBe("open");
  expect(first.api.lastState?.state).toBe("needs_you");

  const api = first.api;
  const answer = api.answer({ questionId: id, answers: { [HEADLINE.question]: "Let it wrap" } });
  api.sessionInfo.openQuestions = [id];
  // The transcript holds the ask's tool result, but as a denial: not an answer.
  const agent = new ScriptedAgent();
  agent.sessions.set("sess_1", { messages: new Set(), toolResults: new Set() });
  const second = await setup({ api, agent, stateDir });
  const input = await second.run.input();
  expect(input.text).toBe(
    `Ada answered the question you asked earlier:\n"${HEADLINE.question}": Let it wrap`,
  );
  second.run.take(input);
  await until(() => api.delivered.includes(answer.id));
});

/* ------------------------------------------------------------------ */
/* Stopping a turn                                                     */
/* ------------------------------------------------------------------ */

test("stop interrupts the turn and the thread says who stopped it", async () => {
  const s = await setup();
  await turn(s);
  const stop = s.api.push({ kind: "stop", payload: {} });
  s.runner.poke();
  await until(() => s.run.interrupts === 1);
  await until(() => s.api.delivered.includes(stop.id));
  s.run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(() => notices(s.api, "stopped").length);
  expect(notices(s.api, "stopped")[0]?.payload).toEqual({ type: "stopped", by: ADA });
  await until(() => s.api.lastState?.state === "idle");
});

test("stop with no turn running is acknowledged and interrupts nothing", async () => {
  const { api, runner, run } = await setup();
  const stop = api.push({ kind: "stop", payload: {} });
  runner.poke();
  await until(() => api.delivered.includes(stop.id));
  expect(run.interrupts).toBe(0);
});

test("stop also ends what was put in behind it, and is spent once that is over", async () => {
  const { api, runner, run } = await setup();
  api.push({ kind: "message", payload: { text: "Draw three takes" } });
  runner.poke();
  const queued = await run.input();
  // Stopped before Claude Code took the message: there is no turn to interrupt yet.
  api.push({ kind: "stop", payload: {} });
  runner.poke();
  await Bun.sleep(30);
  expect(run.interrupts).toBe(0);
  run.take(queued);
  await until(() => run.interrupts === 1);
  run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(() => notices(api, "stopped").length === 1);

  // A later turn cut short by a person's message is not a stop.
  api.push({ kind: "message", payload: { text: "Just one" } });
  runner.poke();
  run.take(await run.input(2));
  run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(() => api.lastState?.state === "idle");
  await Bun.sleep(20);
  expect(notices(api, "stopped").length).toBe(1);
});

test("a reply cut off by an interrupt ends in the thread as it was, not streaming", async () => {
  const s = await setup();
  await turn(s);
  s.run.say("msg_1", "Here is what I", false);
  s.run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(() => s.api.lastState?.state === "idle");
  await until(() => s.api.items().every((i) => !i.streaming));
  expect(s.api.items().find((i) => i.kind === "assistant")).toMatchObject({
    payload: { text: "Here is what I" },
    streaming: false,
  });
});

/* ------------------------------------------------------------------ */
/* The canvas                                                          */
/* ------------------------------------------------------------------ */

test("the canvas tools edit a real replica and the edits reach the API", async () => {
  const s = await setup({ doc: emptyDoc("Fern") });
  await turn(s, "Draw a card");
  const result = await s.run.call("create_artboard", {
    name: "Card",
    html: "<div><h1>Hi</h1></div>",
  });
  expect(result.isError).toBeFalsy();
  await until(() => s.api.doc.snapshot().doc.pages[0]?.artboards[0]?.name === "Card");
  await until(() => s.api.items().some((i) => i.kind === "tool"));
  const work = s.api.items().find((i) => i.kind === "tool");
  expect(work?.payload).toMatchObject({ label: 'Drawing "Card"', steps: 1 });
});

test("an edit the API undid is in the next tool result", async () => {
  const s = await setup({ doc: pricing() });
  const { api, runner, run } = s;
  await turn(s);
  await run.call("get_tree");

  // The agent writes into Pricing while the API is out of reach, and Ada deletes it meanwhile.
  api.down = true;
  const wrote = await run.call("write_html", {
    target: "ab_pricing",
    html: "<p>Paid</p>",
    mode: "append",
  });
  expect(wrote.isError).toBeFalsy();
  api.doc.commit([{ id: "op_ada_1", op: { op: "artboard.delete", id: "ab_pricing" } }], ada);
  api.down = false;
  runner.poke();
  await until(() => !findArtboard(api.doc.snapshot().doc, "ab_pricing"));
  let next = await run.call("get_basic_info");
  for (let i = 0; i < 50 && !next.text.includes("Undone:"); i++) {
    await Bun.sleep(20);
    next = await run.call("get_basic_info");
  }
  expect(next.text).toContain("Undone:");
});

test("the working line follows the agent's steps, and its status when it gives one", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  s.run.emit({ type: "tool", id: "t1", name: "Read", input: { file_path: "/w/src/app.tsx" } });
  await until(() => s.api.lastState?.status === "Reading the repo");
  await s.run.call("set_status", { status: "tightening the hero" });
  await until(() => s.api.lastState?.status === "Tightening the hero");
  s.run.say("msg_1", "Done.");
  await until(() => s.api.items().some((i) => i.kind === "assistant"));
  const work = s.api.items().find((i) => i.kind === "tool")!;
  expect(work.streaming).toBe(false);
  expect(work.payload).toMatchObject({ label: "Tightening the hero", steps: 2 });
});

test("a finished stretch is named by what it made, and a later one keeps the boards it is on", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  await s.run.call("set_text", { updates: [{ id: "n_plan", text: "Paid" }] });
  await s.run.call("list_comments");
  s.run.say("msg_1", "Updated the plan.");
  await s.run.call("set_text", { updates: [{ id: "n_plan", text: "Pro" }] });
  s.run.say("msg_2", "And again.");
  await until(() => s.api.items().filter((i) => i.kind === "tool" && !i.streaming).length === 2);
  const work = s.api.items().filter((i) => i.kind === "tool");
  expect(work.map((i) => i.payload)).toEqual([
    { label: 'Drawing "Pricing"', steps: 2, artboards: ["ab_pricing"] },
    { label: 'Drawing "Pricing"', steps: 1, artboards: ["ab_pricing"] },
  ]);
});

test("a stretch is named by its main action: a commit, not the pull request's description after it", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  const step = (id: string, name: string, input: Record<string, unknown>) => {
    s.run.emit({ type: "tool", id, name, input });
    s.run.emit({ type: "tool-done", id, error: false });
  };
  step("toolu_a", "Bash", { command: "git add -A" });
  step("toolu_b", "Bash", { command: 'git commit -m "Pricing"' });
  step("toolu_c", "Bash", { command: "git push" });
  step("toolu_d", "mcp__ponzu__describe_pull_request", { title: "Pricing", body: "" });
  s.run.say("msg_1", "Committed.");
  await until(() => s.api.items().some((i) => i.kind === "tool" && !i.streaming));
  const work = s.api.items().find((i) => i.kind === "tool");
  expect(work?.payload).toMatchObject({ label: "Committing", steps: 4 });
});

test("a stretch that deletes a board says so, by the board's name", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  await s.run.call("list_comments");
  // Claude Code says what it calls before the call runs, so the board is still there to name.
  s.run.emit({
    type: "tool",
    id: "toolu_del",
    name: "mcp__ponzu__delete",
    input: { ids: ["ab_pricing"] },
  });
  s.run.emit({ type: "tool-done", id: "toolu_del", error: false });
  s.run.say("msg_1", "Removed it.");
  await until(() => s.api.items().some((i) => i.kind === "tool" && !i.streaming));
  const work = s.api.items().find((i) => i.kind === "tool");
  expect(work?.payload).toMatchObject({ label: 'Deleting "Pricing"', steps: 2 });
});

test("a question ends the stretch before it, so the thread reads in the order it happened", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  await s.run.call("list_comments");
  void s.run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  await until(() => s.api.items().some((i) => i.kind === "notice"));
  await s.run.call("set_text", { updates: [{ id: "n_plan", text: "Pro" }] });
  s.run.say("msg_1", "Done.");
  await until(() => s.api.items().filter((i) => i.kind === "tool" && !i.streaming).length === 2);
  const kinds = s.api
    .items()
    .filter((i) => i.kind === "tool" || (i.kind === "notice" && i.payload.type === "question"))
    .map((i) => i.kind);
  expect(kinds).toEqual(["tool", "notice", "tool"]);
});

/* ------------------------------------------------------------------ */
/* The thread and the state                                            */
/* ------------------------------------------------------------------ */

test("streaming text is a few writes, not one per token, and ends finished", async () => {
  const s = await setup({ timing: { threadGapMs: 100 } });
  await turn(s, "Talk");
  let text = "";
  for (let i = 0; i < 200; i++) {
    text += "word ";
    s.run.say("msg_1", text, false);
    if (i % 20 === 0) await Bun.sleep(10);
  }
  s.run.say("msg_1", text, true);
  await until(() => s.api.items().some((i) => i.kind === "assistant" && !i.streaming));
  const writes = s.api.threadWrites.filter((w) => w.some((i) => i.kind === "assistant")).length;
  expect(writes).toBeLessThan(10);
  expect(s.api.items().find((i) => i.kind === "assistant")?.payload).toEqual({ text });
});

test("the state is reported on every heartbeat while the runner lives", async () => {
  const { api } = await setup({ timing: { heartbeatMs: 30 } });
  const before = api.states.length;
  await Bun.sleep(150);
  expect(api.states.length).toBeGreaterThanOrEqual(before + 3);
});

test("a turn's usage is recorded by model, as the change in the running totals", async () => {
  const s = await setup();
  s.run.ready("sess_1");
  await turn(s);
  const total = (input: number, cost: number) => ({
    model: "claude-haiku",
    inputTokens: input,
    outputTokens: input / 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: cost,
  });
  s.run.end({ id: "res_1", usage: [total(100, 0.01)] });
  await until(() => s.api.usage.has("res_1"));
  s.api.push({ kind: "message", payload: { text: "Again" } });
  s.runner.poke();
  s.run.take(await s.run.input(2));
  // Recorded once the API is back, however long that takes.
  s.api.failing.set("recordUsage", new TypeError("fetch failed"));
  s.run.end({ id: "res_2", usage: [total(250, 0.03)] });
  await until(() => s.api.calls.filter((c) => c === "recordUsage").length >= 8);
  s.api.failing.delete("recordUsage");
  await until(() => s.api.usage.has("res_2"));
  const [used] = s.api.usage.get("res_2")!.models;
  expect(used).toMatchObject({ model: "claude-haiku", inputTokens: 150, outputTokens: 15 });
  expect(used!.costUsd).toBeCloseTo(0.02);
  expect(s.api.usage.get("res_2")?.claudeSessionId).toBe("sess_1");
});

test("a failed turn is said in the thread, and a refused credential on the design's row until a turn works", async () => {
  const s = await setup();
  await turn(s);
  s.run.end({ error: { code: "claude_auth", message: "Claude refused the credential." } });
  await until(() => notices(s.api, "error").length);
  await until(() => s.api.lastState?.state === "idle");
  expect(s.api.lastState?.status).toBe("Claude refused the credential.");
  s.api.push({ kind: "message", payload: { text: "Again" } });
  s.runner.poke();
  s.run.take(await s.run.input(2));
  s.run.end();
  await until(() => s.api.lastState?.state === "idle" && s.api.lastState.status === null);
});

test("Claude Code that stops by itself is started again on the same session", async () => {
  const agent = new ScriptedAgent();
  const { api, runner, run } = await setup({ agent });
  run.ready("sess_1");
  agent.sessions.set("sess_1", { messages: new Set(), toolResults: new Set() });
  const event = api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  await run.input();
  run.crash();
  const second = await agent.run(2);
  expect(second.opts.resume).toBe("sess_1");
  // What the first had not taken goes into the second.
  const again = await second.input();
  expect(again.uuid).toBe(eventUuid(event.id));
});

test("Claude Code that stops when its transcript can't be read starts on a new session", async () => {
  const agent = new ScriptedAgent();
  const { api, runner, run } = await setup({ agent });
  run.ready("sess_1");
  const event = api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  await run.input();
  agent.historyError = new Error("EIO: i/o error");
  run.crash();
  const second = await agent.run(2);
  expect(second.opts.resume).toBeNull();
  expect((await second.input()).uuid).toBe(eventUuid(event.id));
});

test("Claude Code that keeps stopping is left down until the next event starts it", async () => {
  const agent = new ScriptedAgent();
  const { api, runner } = await setup({ agent });
  for (let n = 1; n <= 4; n++) (await agent.run(n)).crash();
  await until(() =>
    api.items().some((i) => i.kind === "notice" && JSON.stringify(i.payload).includes("keeps")),
  );
  await Bun.sleep(30);
  expect(agent.runs.length).toBe(4);

  const event = api.push({ kind: "message", payload: { text: "Try again" } });
  runner.poke();
  const fifth = await agent.run(5);
  expect((await fifth.input()).uuid).toBe(eventUuid(event.id));
});

test("an event of a kind this runner does not know is acknowledged, not held forever", async () => {
  const { api, runner, run, logs } = await setup();
  const event = api.push({ kind: "deploy", payload: {} } as never);
  runner.poke();
  await until(() => api.delivered.includes(event.id));
  expect(run.inputs).toEqual([]);
  expect(logs.join("\n")).toContain("deploy");
});

test("a message a repo's hook refused is acknowledged, said in the thread, and leaves the design idle", async () => {
  const { api, runner, run } = await setup();
  const event = api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  const input = await run.input();
  await until(() => api.lastState?.state === "working");
  run.emit({ type: "dropped", uuids: [input.uuid] });
  await until(() => api.lastState?.state === "idle");
  await until(() => api.delivered.includes(event.id));
  await until(() => notices(api, "error").length);
  expect(notices(api, "error")[0]!.payload).toMatchObject({ code: "message_refused" });
});

test("once the canvas is still, light and dark previews of the first page are uploaded with their seq", async () => {
  const renders: RenderRequest[] = [];
  const renderer: Renderer = {
    async render(req) {
      renders.push(req);
      return {
        bytes: new Uint8Array([1]),
        mime: "image/png",
        width: 1,
        height: 1,
        contentHeight: 1,
        issues: [],
      };
    },
    close: async () => {},
  };
  const s = await setup({ doc: emptyDoc("Fern"), renderer });
  await turn(s, "Draw");
  await s.run.call("create_artboard", { name: "Card", html: "<p>Hi</p>" });
  await s.run.call("write_html", { target: "n_missing", html: "<p>x</p>" });
  await until(() => s.api.uploads.length === 2);
  expect(s.api.uploads.map((u) => [u.purpose, u.name, u.seq])).toEqual([
    ["preview", "light.png", 1],
    ["preview", "dark.png", 1],
  ]);
  expect(renders.map((r) => [r.colorScheme, r.thumbnail])).toEqual([
    ["light", true],
    ["dark", true],
  ]);
});

/* ------------------------------------------------------------------ */
/* Shutting down                                                       */
/* ------------------------------------------------------------------ */

test("stopping waits for the agent's edits to reach the API, then reports idle", async () => {
  const s = await setup({ doc: pricing() });
  await turn(s);
  s.api.down = true;
  await s.run.call("set_text", { updates: [{ id: "n_plan", text: "Paid" }] });
  setTimeout(() => {
    s.api.down = false;
  }, 100);
  await s.runner.stop();
  const plan = s.api.doc.snapshot().doc.pages[0]!.artboards[0]!.root.children[0];
  expect(JSON.stringify(plan)).toContain("Paid");
  expect(s.api.lastState?.state).toBe("idle");
  expect(s.run.interrupts).toBe(1);
  expect(s.run.closed).toBe(true);
});
