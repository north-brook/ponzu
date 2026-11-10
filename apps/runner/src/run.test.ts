import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Doc, emptyDoc, findArtboard, parseHtml } from "@ponzu/core";
import type { Renderer, RenderRequest } from "@ponzu/render";
import { ScriptedAgent, type ScriptedRun } from "./agent/scripted.ts";
import { ADA, FakeRunnerApi } from "./api/fake.ts";
import type { RunnerSession } from "./api/protocol.ts";
import { derivedId, eventUuid } from "./ids.ts";
import { Runner, type Timing } from "./run.ts";

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  ackGapMs: 5,
  settleMs: 1_000,
  stopStepMs: 500,
  previewDelayMs: 10,
  restartMs: 10,
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

interface Setup {
  api: FakeRunnerApi;
  agent: ScriptedAgent;
  runner: Runner;
  run: ScriptedRun;
  logs: string[];
  stateDir: string;
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
  } = {},
): Promise<Setup> {
  const api = opts.api ?? new FakeRunnerApi({ session: opts.session, doc: opts.doc });
  const agent = opts.agent ?? new ScriptedAgent();
  const stateDir = opts.stateDir ?? (await temp());
  const logs: string[] = [];
  const work = await temp();
  const runner = new Runner({
    api,
    agent,
    prepare: opts.prepare ?? (async () => work),
    renderer: opts.renderer,
    stateDir,
    log: (m) => logs.push(m),
    timing: { ...FAST, ...opts.timing },
  });
  open.push(runner);
  await runner.start();
  return { api, agent, runner, run: agent.last, logs, stateDir };
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-runner-"));
  dirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* Starting                                                            */
/* ------------------------------------------------------------------ */

test("a fresh design starts a new session and says so once Claude is up", async () => {
  const { api, run } = await setup();
  expect(run.opts.resume).toBeNull();
  expect(run.opts.instructions).toContain("Ponzu's canvas tools");
  expect(run.opts.instructions).toContain("no repository");
  expect(run.opts.tools.map((t) => t.name)).toContain("create_artboard");

  await until(() => api.items()[0]?.payload);
  expect(api.items()[0]).toMatchObject({
    kind: "notice",
    payload: { type: "waking" },
    streaming: true,
  });

  run.ready("sess_new");
  await until(() => api.lastState?.claudeSessionId === "sess_new");
  await until(() => !api.items()[0]!.streaming);
  expect(api.items()[0]!.payload).toEqual({ type: "started" });
  expect(api.lastState).toMatchObject({ state: "idle", claudeSessionId: "sess_new" });
});

test("a design with a session resumes it, and withdraws what an earlier run left open", async () => {
  const agent = new ScriptedAgent();
  agent.sessions.set("sess_old", { messages: new Set(), toolResults: new Set() });
  const { api, run } = await setup({
    agent,
    session: { claudeSessionId: "sess_old", openQuestions: ["q_stale"] },
  });
  api.questions.set("q_stale", {
    id: "q_stale",
    kind: "plan",
    payload: { plan: "" },
    status: "open",
  });
  expect(run.opts.resume).toBe("sess_old");
  run.ready("sess_old");
  await until(() => api.items()[0] && !api.items()[0]!.streaming);
  expect(api.items()[0]!.payload).toEqual({ type: "resumed" });
  expect(api.calls).toContain("withdraw");
});

test("a session whose transcript is gone starts over instead of failing to resume", async () => {
  const { run } = await setup({ session: { claudeSessionId: "sess_lost" } });
  expect(run.opts.resume).toBeNull();
});

test("a clone that fails is said in the thread and the state, and the canvas work goes on", async () => {
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
  await until(() => api.items().some((i) => i.kind === "notice" && i.payload.type === "error"));
  const error = api.items().find((i) => i.kind === "notice" && i.payload.type === "error")!;
  expect(error.payload).toEqual({
    type: "error",
    code: "clone_failed",
    message: "Ponzu could not get north/fern: Repository not found.",
  });
  await until(() => api.lastState?.status === "Couldn't get the repository");
  expect(run.opts.cwd).toBe(scratch);
  expect(run.opts.instructions).toContain("no repository");
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
});

/* ------------------------------------------------------------------ */
/* Events in                                                           */
/* ------------------------------------------------------------------ */

test("a message goes in at once, and is acknowledged only once the session holds it", async () => {
  const { api, runner, run } = await setup();
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

test("a message that arrives mid-turn goes in mid-turn, not after it", async () => {
  const { api, runner, run } = await setup({ doc: pricing() });
  api.push({ kind: "message", payload: { text: "Start" } });
  runner.poke();
  run.take(await run.input());
  await run.call("get_basic_info");

  const comment = api.push({
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
  runner.poke();
  const input = await run.input(2);
  expect(input.priority).toBe("now");
  expect(input.uuid).toBe(eventUuid(comment.id));
  expect(input.text).toBe(
    'Comment from Ada on "Pricing" (artboard ab_pricing), thread th_1:\nToo many words here.\nIt is pinned to node n_plan.',
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
    'A check failed on the pull request: "test" (failure).\nDetails: https://ci/1\n1 failed',
  );
});

test("a canvas edit never starts a turn: it goes in when the agent next touches the canvas", async () => {
  const { api, runner, run } = await setup({ doc: pricing() });
  const edit = api.push(
    {
      kind: "edit",
      payload: { summary: 'moved "Pricing"', artboards: [{ id: "ab_pricing", name: "Pricing" }] },
    },
    { priority: "later" },
  );
  runner.poke();
  await Bun.sleep(50);
  expect(run.inputs).toEqual([]);
  expect(api.lastState?.state).toBe("idle");

  api.push({ kind: "message", payload: { text: "Tidy up." } });
  runner.poke();
  // The edit goes ahead of the message that starts the turn.
  const first = await run.input();
  const second = await run.input(2);
  expect(first).toMatchObject({ uuid: eventUuid(edit.id), priority: "next", human: false });
  expect(first.text).toBe('Canvas edit by Ada: moved "Pricing"\nArtboards: "Pricing" (ab_pricing)');
  expect(second.text).toBe("Message from Ada:\nTidy up.");
});

test("an edit during a turn goes in right after the agent's next canvas tool call", async () => {
  const { api, runner, run } = await setup({ doc: pricing() });
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());

  const edit = api.push(
    { kind: "edit", payload: { summary: "renamed a page", artboards: [] } },
    { priority: "later" },
  );
  runner.poke();
  await until(() => api.events.find((e) => e.event.id === edit.id)?.claimedAt !== undefined);
  expect(run.inputs.length).toBe(1);
  await run.call("get_tree");
  const input = await run.input(2);
  expect(input.uuid).toBe(eventUuid(edit.id));
  run.take(input);
  await until(() => api.delivered.includes(edit.id));
});

test("an event claimed again is not put in twice", async () => {
  const { api, runner, run } = await setup();
  const event = api.push({ kind: "message", payload: { text: "Once" } });
  runner.poke();
  await run.input();
  // The API hands it out again after its claim times out; the runner already holds it.
  api.events[0]!.claimedAt = 0;
  runner.poke();
  await until(() => api.calls.filter((c) => c === "claim").length >= 3);
  await Bun.sleep(30);
  expect(run.inputs.map((i) => i.uuid)).toEqual([eventUuid(event.id)]);
});

test("a runner that dies before the session holds an event gets it again and puts it in", async () => {
  const stateDir = await temp();
  const first = await setup({ stateDir });
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

test("a runner that dies after the session took an event acknowledges it without putting it in again", async () => {
  const api = new FakeRunnerApi({ session: { claudeSessionId: "sess_1" } });
  const event = api.push({ kind: "message", payload: { text: "Draw it" } });
  await api.claim();
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
  const { api, runner, run } = await setup();
  api.push({ kind: "message", payload: { text: "Pick a headline" } });
  runner.poke();
  run.take(await run.input());

  const question = {
    header: "Headline",
    question: "The headline runs to three lines at 390px. Which way?",
    options: [
      { label: "Shorten it", description: "Two lines on phones." },
      { label: "Let it wrap", description: "Three lines." },
    ],
    multiSelect: false,
  };
  const replied = run.ask("toolu_ask", { kind: "question", questions: [question] });
  const id = derivedId("q", "toolu_ask");
  await until(() => api.questions.get(id));
  expect(api.questions.get(id)).toMatchObject({
    kind: "question",
    payload: { questions: [question] },
    status: "open",
  });
  await until(() => api.lastState?.state === "needs_you");
  const notice = api.items().find((i) => i.kind === "notice" && i.payload.type === "question");
  expect(notice?.payload).toEqual({
    type: "question",
    questionId: id,
    header: "Headline",
    text: question.question,
  });

  const answer = api.answer({ questionId: id, answers: { [question.question]: "Shorten it" } });
  runner.poke();
  expect(await replied).toEqual({
    answers: { [question.question]: "Shorten it" },
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

test("a question still open when the turn ends is withdrawn", async () => {
  const { api, runner, run } = await setup();
  api.push({ kind: "message", payload: { text: "Plan it" } });
  runner.poke();
  run.take(await run.input());
  const replied = run.ask("toolu_plan", { kind: "plan", plan: "1. Draw\n2. Ship" });
  const id = derivedId("q", "toolu_plan");
  await until(() => api.questions.get(id));
  expect(api.questions.get(id)?.payload).toEqual({ plan: "1. Draw\n2. Ship" });
  run.end({ error: { code: "interrupted", message: "stopped" } });
  expect(await replied).toBeNull();
  await until(() => api.questions.get(id)?.status === "cancelled");
  await until(() => api.lastState?.state === "idle");
});

test("an answer to a question no run is waiting on goes in as a message", async () => {
  const api = new FakeRunnerApi();
  api.questions.set("q_old", { id: "q_old", kind: "plan", payload: { plan: "" }, status: "open" });
  api.answer({ questionId: "q_old", answers: { "Which way?": "Left" } });
  const { run } = await setup({ api });
  const input = await run.input();
  expect(input.text).toBe('Answer from Ada to your question q_old:\n"Which way?": Left');
});

/* ------------------------------------------------------------------ */
/* Stopping a turn                                                     */
/* ------------------------------------------------------------------ */

test("stop interrupts the turn and the thread says who stopped it", async () => {
  const { api, runner, run } = await setup();
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
  const stop = api.push({ kind: "stop", payload: {} });
  runner.poke();
  await until(() => run.interrupts === 1);
  await until(() => api.delivered.includes(stop.id));
  run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(() => api.items().some((i) => i.kind === "notice" && i.payload.type === "stopped"));
  const stopped = api.items().find((i) => i.kind === "notice" && i.payload.type === "stopped");
  expect(stopped?.payload).toEqual({ type: "stopped", by: ADA });
  await until(() => api.lastState?.state === "idle");
});

test("stop with no turn running is acknowledged and interrupts nothing", async () => {
  const { api, runner, run } = await setup();
  const stop = api.push({ kind: "stop", payload: {} });
  runner.poke();
  await until(() => api.delivered.includes(stop.id));
  expect(run.interrupts).toBe(0);
});

/* ------------------------------------------------------------------ */
/* The canvas                                                          */
/* ------------------------------------------------------------------ */

test("the canvas tools edit a real replica and the edits reach the API", async () => {
  const { api, runner, run } = await setup({ doc: emptyDoc("Fern") });
  api.push({ kind: "message", payload: { text: "Draw a card" } });
  runner.poke();
  run.take(await run.input());
  const result = await run.call("create_artboard", {
    name: "Card",
    html: "<div><h1>Hi</h1></div>",
  });
  expect(result.isError).toBeFalsy();
  await until(() => api.doc.snapshot().doc.pages[0]?.artboards[0]?.name === "Card");
  await until(() => api.items().some((i) => i.kind === "tool"));
  const work = api.items().find((i) => i.kind === "tool");
  expect(work?.payload).toMatchObject({ label: 'Drawing "Card"', steps: 1 });
});

test("an edit the API undid is in the next tool result", async () => {
  const { api, runner, run } = await setup({ doc: pricing() });
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
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
  const { api, runner, run } = await setup({ doc: pricing() });
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
  run.emit({ type: "tool", id: "t1", name: "Read", input: { file_path: "/w/src/app.tsx" } });
  await until(() => api.lastState?.status === "Reading the repo");
  await run.call("set_status", { status: "tightening the hero" });
  await until(() => api.lastState?.status === "Tightening the hero");
  run.say("msg_1", "Done.");
  await until(() => api.items().some((i) => i.kind === "assistant"));
  const work = api.items().find((i) => i.kind === "tool")!;
  expect(work.streaming).toBe(false);
  expect(work.payload).toMatchObject({ label: "Tightening the hero", steps: 2 });
});

/* ------------------------------------------------------------------ */
/* The thread and the state                                            */
/* ------------------------------------------------------------------ */

test("streaming text is a few writes, not one per token, and ends finished", async () => {
  const { api, runner, run } = await setup({ timing: { threadGapMs: 100 } });
  api.push({ kind: "message", payload: { text: "Talk" } });
  runner.poke();
  run.take(await run.input());
  let text = "";
  for (let i = 0; i < 200; i++) {
    text += "word ";
    run.say("msg_1", text, false);
    if (i % 20 === 0) await Bun.sleep(10);
  }
  run.say("msg_1", text, true);
  await until(() => api.items().some((i) => i.kind === "assistant" && !i.streaming));
  const writes = api.threadWrites.filter((w) => w.some((i) => i.kind === "assistant")).length;
  expect(writes).toBeLessThan(10);
  expect(api.items().find((i) => i.kind === "assistant")?.payload).toEqual({ text });
});

test("the state is reported on every heartbeat while the runner lives", async () => {
  const { api } = await setup({ timing: { heartbeatMs: 30 } });
  const before = api.states.length;
  await Bun.sleep(150);
  expect(api.states.length).toBeGreaterThanOrEqual(before + 3);
});

test("a turn's usage is recorded by model, as the change in the running totals", async () => {
  const { api, runner, run } = await setup();
  run.ready("sess_1");
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
  const total = (input: number, cost: number) => ({
    model: "claude-haiku",
    inputTokens: input,
    outputTokens: input / 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: cost,
  });
  run.end({ id: "res_1", usage: [total(100, 0.01)] });
  await until(() => api.usage.has("res_1"));
  api.push({ kind: "message", payload: { text: "Again" } });
  runner.poke();
  run.take(await run.input(2));
  run.end({ id: "res_2", usage: [total(250, 0.03)] });
  await until(() => api.usage.has("res_2"));
  const [used] = api.usage.get("res_2")!.models;
  expect(used).toMatchObject({ model: "claude-haiku", inputTokens: 150, outputTokens: 15 });
  expect(used!.costUsd).toBeCloseTo(0.02);
  expect(api.usage.get("res_2")?.claudeSessionId).toBe("sess_1");
});

test("a failed turn is said in the thread", async () => {
  const { api, runner, run } = await setup();
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
  run.end({ error: { code: "claude_auth", message: "Claude refused the credential." } });
  await until(() => api.items().some((i) => i.kind === "notice" && i.payload.type === "error"));
  expect(api.lastState?.state).toBe("idle");
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

test("a message a repo's hook refused leaves the design idle, and is not acknowledged", async () => {
  const { api, runner, run } = await setup();
  const event = api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  const input = await run.input();
  await until(() => api.lastState?.state === "working");
  run.emit({ type: "dropped", uuids: [input.uuid] });
  await until(() => api.lastState?.state === "idle");
  await Bun.sleep(20);
  expect(api.delivered).not.toContain(event.id);
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
  const { api, runner, run } = await setup({ doc: emptyDoc("Fern"), renderer });
  api.push({ kind: "message", payload: { text: "Draw" } });
  runner.poke();
  run.take(await run.input());
  await run.call("create_artboard", { name: "Card", html: "<p>Hi</p>" });
  await run.call("write_html", { target: "n_missing", html: "<p>x</p>" });
  await until(() => api.uploads.length === 2);
  expect(api.uploads.map((u) => [u.purpose, u.name, u.seq])).toEqual([
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
  const { api, runner, run } = await setup({ doc: pricing() });
  api.push({ kind: "message", payload: { text: "Go" } });
  runner.poke();
  run.take(await run.input());
  api.down = true;
  await run.call("set_text", { updates: [{ id: "n_plan", text: "Paid" }] });
  setTimeout(() => {
    api.down = false;
  }, 100);
  await runner.stop();
  const plan = api.doc.snapshot().doc.pages[0]!.artboards[0]!.root.children[0];
  expect(JSON.stringify(plan)).toContain("Paid");
  expect(api.lastState?.state).toBe("idle");
  expect(run.interrupts).toBe(1);
  expect(run.closed).toBe(true);
});
