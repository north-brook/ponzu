// The proof that the API and the runner agree: the runner's own code (`Runner` over its HTTP
// client, with the scripted agent in place of Claude Code) against these routes in this
// process. A person's message goes in through the API, the runner claims it, writes the
// thread, asks a question that the person answers through the API, reports its state and
// usage, uploads a file; a newer runner then takes the lease and the old one stops for good.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  createRunnerToken,
  getDesignHead,
  getQuestion,
  listAssets,
  listThreadItems,
} from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import type { AskedQuestion } from "@ponzu/runner/protocol";
// The runner's own modules, as its main.ts wires them. Its package exports only its protocol.
import { ScriptedAgent } from "../../../runner/src/agent/scripted.ts";
import { HttpRunnerApi } from "../../../runner/src/api/http.ts";
import { derivedId } from "../../../runner/src/ids.ts";
import { Runner, type Timing } from "../../../runner/src/run.ts";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, MemoryStorage, type TestApp } from "../testing/index.ts";

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 500,
  stopStepMs: 300,
  previewDelayMs: 10,
  restartMs: 10,
  backoff: () => 20,
};

const HEADLINE: AskedQuestion = {
  header: "Headline",
  question: "The headline runs to three lines. Which way?",
  options: [
    { label: "Shorten it", description: "Two lines on phones." },
    { label: "Let it wrap", description: "Three lines." },
  ],
  multiSelect: false,
};

let t: TestApp;
let ws: Workspace;
const open: Runner[] = [];
const dirs: string[] = [];
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((runner) => runner.stop()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function until(check: () => unknown | Promise<unknown>, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/**
 * Everything the runner's `fetch` reaches: the API in this process, and the storage fake at the
 * addresses it signs. Nothing leaves the process.
 */
const inProcess: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === MemoryStorage.ORIGIN) return t.storage.fetch(input, init);
    return t.app.request(new Request(input, init));
  },
  { preconnect: () => {} },
);

/** The runner as a sandbox starts it, for a design of Maya's. */
async function startRunner(designId: string) {
  const { token } = await createRunnerToken(t.db, { designId, ttlSeconds: 3600 });
  const work = await mkdtemp(join(tmpdir(), "ponzu-e2e-"));
  dirs.push(work);
  const agent = new ScriptedAgent();
  const fatal: string[] = [];
  const logs: string[] = [];
  const api = new HttpRunnerApi({
    baseUrl: "https://api.test",
    token,
    client: "runner/0.1.0",
    designId,
    fetch: inProcess,
  });
  const runner = new Runner({
    api,
    agent,
    prepare: async () => work,
    stateDir: work,
    log: (line) => logs.push(line),
    onFatal: (reason) => fatal.push(reason),
    timing: FAST,
  });
  open.push(runner);
  await runner.start();
  return { runner, agent, api, run: agent.last, fatal, logs };
}

const as = (login: string) => ws.people[login]!.headers;

test("a message, a reply, a question and its answer, state and usage, between a person and the runner", async () => {
  const design = await designIn(t, ws, "maya", sampleDoc());
  const { runner, run, api } = await startRunner(design.id);
  run.ready("sess_e2e");

  // Maya says something; the runner hears of it and puts it into the run.
  const sent = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, {
    text: "Pick a headline",
  });
  expect(sent.status).toBe(201);
  runner.poke();
  const input = await run.input();
  expect(input.text).toBe("Message from Maya:\nPick a headline");
  run.take(input);
  await until(async () => (await feedOf(t.db, design.id))[0]?.deliveredAt);

  // The agent says something and asks a question.
  run.say("msg_1", "Two ways to go.");
  const replied = run.ask("toolu_ask", { kind: "question", questions: [HEADLINE] });
  const questionId = derivedId("q", "toolu_ask");
  await until(() => getQuestion(t.db, { designId: design.id, id: questionId }));
  await until(async () => (await getDesignHead(t.db, design.id))?.agentState === "needs_you");
  expect((await getDesignHead(t.db, design.id))!.needsYouCount).toBe(1);

  // Maya answers it; the answer goes back to the waiting question.
  const answered = await call(
    t,
    as("maya"),
    "POST",
    `/v1/designs/${design.id}/questions/${questionId}/answer`,
    { answers: { [HEADLINE.question]: "Shorten it" } },
  );
  expect(answered.body).toEqual({ id: questionId, status: "answered" });
  runner.poke();
  expect(await replied).toEqual({
    answers: { [HEADLINE.question]: "Shorten it" },
    approved: undefined,
    note: undefined,
  });
  run.answered("toolu_ask");
  await until(async () => (await feedOf(t.db, design.id)).every((event) => event.deliveredAt));

  // A file the agent adds, through the upload protocol, to the storage fake.
  const [stored] = await api.upload([
    {
      purpose: "asset",
      name: "hero.png",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    },
  ]);
  expect(stored!.ref).toBe("assets/hero.png");
  expect(await listAssets(t.db, { designId: design.id, paths: ["assets/hero.png"] })).toHaveLength(
    1,
  );

  // The turn ends.
  run.say("msg_2", "Shortened it.");
  run.end({
    id: "8f0c2b1e-0000-4000-8000-00000000e2e0",
    usage: [
      {
        model: "claude-test",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        costUsd: 0.01,
      },
    ],
  });
  await until(async () => (await getDesignHead(t.db, design.id))?.agentState === "idle");
  await until(async () => {
    const result = await t.db.execute(
      `select 1 from usage_events where design_id = '${design.id}'`,
    );
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  });

  // What a client reads from the thread: Maya's message, the agent's words, the stretch of
  // work the question was, and the question.
  const thread = await call(t, as("maya"), "GET", `/v1/designs/${design.id}/thread`);
  const shown = thread.body.items.map(
    ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) =>
      `${kind}:${payload[{ notice: "type", tool: "label" }[kind] ?? "text"]}`,
  );
  expect(shown).toEqual([
    "notice:started",
    "message:Pick a headline",
    "assistant:Two ways to go.",
    expect.stringMatching(/^tool:/),
    "notice:question",
    "assistant:Shortened it.",
  ]);
  expect(thread.body.items.every((item: { streaming: boolean }) => !item.streaming)).toBe(true);
  expect((await getQuestion(t.db, { designId: design.id, id: questionId }))!.status).toBe(
    "answered",
  );
  // The session the events went into is the one a runner that starts again resumes.
  const { token } = await createRunnerToken(t.db, { designId: design.id, ttlSeconds: 60 });
  const next = await call(
    t,
    { authorization: `Bearer ${token}` },
    "POST",
    "/v1/runner/session",
    {},
  );
  expect(next.body.claudeSessionId).toBe("sess_e2e");
}, 20_000);

test("a stop from a person ends the turn, and the runner's stopped notice names them; a newer runner stops the old one", async () => {
  const design = await designIn(t, ws, "maya", sampleDoc());
  const first = await startRunner(design.id);
  first.run.ready("sess_stop");
  await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, { text: "Go" });
  first.runner.poke();
  first.run.take(await first.run.input());

  await call(t, as("maya"), "POST", `/v1/designs/${design.id}/stop`);
  first.runner.poke();
  await until(() => first.run.interrupts > 0);
  first.run.end({ error: { code: "interrupted", message: "The turn was stopped." } });
  await until(async () =>
    (await listThreadItems(t.db, { designId: design.id })).some(
      (item) => (item.payload as { type?: string }).type === "stopped",
    ),
  );
  const stopped = (await listThreadItems(t.db, { designId: design.id })).find(
    (item) => (item.payload as { type?: string }).type === "stopped",
  );
  expect(stopped!.payload).toEqual({
    type: "stopped",
    by: { id: ws.people.maya!.userId, name: "Maya", login: "maya" },
  });

  // A second sandbox for the design takes the lease; the first is refused at its next call.
  await startRunner(design.id);
  first.runner.poke();
  await until(() => first.fatal.length > 0);
  expect(first.fatal[0]).toContain("Another runner took over this design");
}, 20_000);
