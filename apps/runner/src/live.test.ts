/*
 * The runner with the real Agent SDK and Claude Code, on this machine, against the fake API. It
 * runs only when asked for, with RUNNER_LIVE=1 as well as the key: the key alone is not enough,
 * because it also sits in a developer's `.env`, which Bun loads for every `bun test`. A request
 * as a person would make it, with no script for the model, and a comment on the board it draws
 * while it works, on the cheapest model: about two cents.
 *
 *   RUNNER_LIVE=1 ANTHROPIC_API_KEY=… bun test apps/runner/src/live.test.ts
 *
 * It prints the thread it produced, its timings and what the turn cost.
 */

import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDoc, type Op } from "@ponzu/core";
import { ChromiumRenderer, findChromium } from "@ponzu/render/chromium";
import { ClaudeAgent } from "./agent/sdk.ts";
import { FakeRunnerApi } from "./api/fake.ts";
import { SECRETS_FOLDER, type WorkItem } from "./api/protocol.ts";
import { eventUuid } from "./ids.ts";
import { Runner } from "./run.ts";
import { localSecretWriter } from "./secret-tool.ts";

const live =
  process.env.RUNNER_LIVE === "1" &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  !process.env.CLAUDE_CODE_OAUTH_TOKEN;
const dirs: string[] = [];
const logs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test.skipIf(!live)(
  "a request and a comment mid-turn: Claude draws, takes the comment up, and the run ends idle",
  async () => {
    const work = realpathSync(await mkdtemp(join(tmpdir(), "ponzu-live-work-")));
    const state = await mkdtemp(join(tmpdir(), "ponzu-live-state-"));
    // Claude Code keeps the session's transcript under ~/.claude/projects, by working directory.
    const transcripts = join(homedir(), ".claude", "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
    dirs.push(work, state, transcripts);
    const api = new FakeRunnerApi({ doc: emptyDoc("Untitled"), session: { model: "haiku" } });
    const agent = new ClaudeAgent({ client: "ponzu-runner/live-test", log: (l) => logs.push(l) });
    const chromium = findChromium();
    const runner = new Runner({
      api: api.client(),
      agent,
      renderer: chromium ? new ChromiumRenderer({ executablePath: chromium }) : undefined,
      prepare: async () => work,
      stateDir: state,
      log: (m) => logs.push(m),
    });
    const started = performance.now();
    const at = () => Math.round(performance.now() - started);
    const timings: Record<string, number> = {};

    await runner.start();
    timings.started = at();
    const message = api.push({
      kind: "message",
      payload: {
        text: "A small pricing card with three tiers: Free, Pro and Team. Keep it simple.",
      },
    });
    runner.poke();

    const deadline = Date.now() + 180_000;
    const wait = async (what: string, check: () => unknown) => {
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${what}\n${logs.join("\n")}`);
        await Bun.sleep(50);
      }
      timings[what] = at();
    };
    const board = () => api.doc.snapshot().doc.pages[0]?.artboards[0];
    await wait("working", () => api.lastState?.state === "working");
    await wait("acknowledged", () => api.delivered.includes(message.id));
    await wait("artboard committed", board);
    // A person comments on the board while Claude is still on it.
    const comment = api.push({
      kind: "comment",
      payload: {
        threadId: "th_live",
        messageId: "m_live",
        text: "Make the Pro tier stand out.",
        reply: false,
        artboardId: board()!.id,
        artboardName: board()!.name,
        nodeId: null,
      },
    });
    runner.poke();
    await wait("comment acknowledged", () => api.delivered.includes(comment.id));
    await wait(
      "idle",
      () =>
        api.lastState?.state === "idle" &&
        api.usage.size > 0 &&
        api.items().every((i) => !i.streaming),
    );
    await runner.stop();
    timings.stopped = at();

    const log = api.doc.opsAfter(0);
    const ops = log === "gone" ? [] : log.ops;
    const kinds = (op: Op): string[] => (op.op === "batch" ? op.ops.flatMap(kinds) : [op.op]);
    const items = api.items();
    const turns = [...api.usage.values()];
    console.log(
      [
        "Thread:",
        ...items.map(
          (i) => `  ${i.kind}${i.streaming ? " (streaming)" : ""} ${JSON.stringify(i.payload)}`,
        ),
        `Ops: ${ops.map((o) => `${o.seq} ${kinds(o.op).join("+")}`).join(", ")}`,
        `State: ${JSON.stringify(api.lastState)}`,
        `Timings (ms): ${JSON.stringify(timings)}`,
        `Usage: ${JSON.stringify(turns.map((t) => t.models))}`,
        `Cost: $${turns
          .flatMap((t) => t.models)
          .reduce((sum, m) => sum + m.costUsd, 0)
          .toFixed(4)}`,
        `Thread writes: ${api.threadWrites.length}, state reports: ${api.states.length}`,
        `Uploads: ${api.uploads.map((u) => `${u.purpose} ${u.name} at seq ${u.seq}`).join(", ") || "none"}`,
      ].join("\n"),
    );

    expect(ops.some((o) => kinds(o.op).includes("artboard.create"))).toBe(true);
    expect(items.some((i) => i.kind === "assistant")).toBe(true);
    expect(items.every((i) => !i.streaming)).toBe(true);
    const stretches = items.filter((i) => i.kind === "tool").map((i) => i.payload as WorkItem);
    expect(stretches.some((w) => w.artboards.includes(board()!.id))).toBe(true);
    expect(items[0]).toMatchObject({ kind: "notice", payload: { type: "started" } });
    expect(api.lastState).toMatchObject({ state: "idle" });
    // What a runner that starts again reads to know the event is in the session already.
    const history = await agent.history(api.lastState!.claudeSessionId!);
    expect(history?.messages.has(eventUuid(message.id))).toBe(true);
    expect(history?.messages.has(eventUuid(comment.id))).toBe(true);
  },
  200_000,
);

test.skipIf(!live)(
  "two small boards and a file edit: the working state as it went, and the turn folded",
  async () => {
    const work = realpathSync(await mkdtemp(join(tmpdir(), "ponzu-live-work-")));
    const state = await mkdtemp(join(tmpdir(), "ponzu-live-state-"));
    const transcripts = join(homedir(), ".claude", "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
    dirs.push(work, state, transcripts);
    await Bun.write(join(work, "tokens.css"), ":root {\n  --accent: #3b82f6;\n}\n");
    const api = new FakeRunnerApi({ doc: emptyDoc("Untitled"), session: { model: "haiku" } });
    const agent = new ClaudeAgent({ client: "ponzu-runner/live-test", log: (l) => logs.push(l) });
    const runner = new Runner({
      api: api.client(),
      agent,
      prepare: async () => work,
      stateDir: state,
      log: (m) => logs.push(m),
      secrets: [process.env.ANTHROPIC_API_KEY!],
      timing: { stateGapMs: 50 },
    });
    await runner.start();
    api.push({
      kind: "message",
      payload: {
        text: 'Draw two small boards, "Plan" and "Plan ready", each a 320×200 card with one line of text. Then in tokens.css change --accent to #16a34a. Say a word between the steps. No screenshots.',
      },
    });
    runner.poke();
    const deadline = Date.now() + 180_000;
    while (
      !(
        api.lastState?.state === "idle" &&
        api.usage.size > 0 &&
        api.items().every((i) => !i.streaming)
      )
    ) {
      if (Date.now() > deadline) throw new Error(`timed out\n${logs.join("\n")}`);
      await Bun.sleep(50);
    }
    await runner.stop();

    // Every state reported, as the head would hold it in turn, repeats folded.
    const states = api.states
      .map((s) => (s.state === "working" ? s.status : s.state))
      .filter((s, i, all) => s !== all[i - 1]);
    const items = api.items();
    const turn = items.find((i) => i.kind === "tool")!.payload as WorkItem;
    const cost = [...api.usage.values()]
      .flatMap((t) => t.models)
      .reduce((sum, m) => sum + m.costUsd, 0);
    console.log(
      [
        "States:",
        ...states.map((s) => `  ${s}`),
        "Thread:",
        ...items.map((i) => `  ${i.kind} ${JSON.stringify(i.payload).slice(0, 160)}`),
        `Turn label: ${turn.label}`,
        `Turn record: ${JSON.stringify(turn.turn, null, 2)}`,
        `Cost: $${cost.toFixed(4)}`,
      ].join("\n"),
    );

    const working = api.states.filter((s) => s.state === "working");
    expect(working.every((s) => typeof s.status === "string" && s.status.length > 0)).toBe(true);
    expect(states).toContain("Thinking");
    expect(states.some((s) => s?.startsWith('Drawing "Plan'))).toBe(true);
    expect(JSON.stringify(api.states)).not.toContain(process.env.ANTHROPIC_API_KEY!);
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(turn.turn).toMatchObject({ ended: "done" });
    expect(turn.turn!.boards).toBeGreaterThanOrEqual(2);
    expect(turn.turn!.files).toBeGreaterThanOrEqual(1);
    expect(items.find((i) => i.id === turn.turn!.final)?.kind).toBe("assistant");
    expect(await Bun.file(join(work, "tokens.css")).text()).toContain("#16a34a");
  },
  200_000,
);

/*
 * Needs you, live (docs/cloud.md, "Needs you"), on Haiku at low effort: the agent asks for a
 * secret with `request_secret`, a person gives a made-up value, and a command reads it from the
 * file; and AskUserQuestion, under bypassPermissions, reaches `canUseTool` and becomes a question
 * row. The second is the owed proof: if it fails at "question raised", AskUserQuestion is not
 * reaching canUseTool, and the runner must stop bypassing permissions for that one tool.
 *
 *   RUNNER_LIVE=1 ANTHROPIC_API_KEY=<dev key> bun test apps/runner/src/live.test.ts -t "Needs you"
 */

/** Made up: never a real key. Twenty-eight characters, which the agent is asked to count. */
const FAKE_SECRET = "sk_test_live_fake_0123456789";

/** A live run on a repo canvas, with the agent's home in a folder of its own. */
async function liveRepoRun() {
  const work = realpathSync(await mkdtemp(join(tmpdir(), "ponzu-live-work-")));
  const state = await mkdtemp(join(tmpdir(), "ponzu-live-state-"));
  const home = realpathSync(await mkdtemp(join(tmpdir(), "ponzu-live-home-")));
  const transcripts = join(homedir(), ".claude", "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
  dirs.push(work, state, home, transcripts);
  const api = new FakeRunnerApi({
    doc: emptyDoc("Untitled"),
    session: {
      model: "haiku",
      effort: "low",
      repo: { owner: "north-brook", name: "ponzu-test", defaultBranch: "main" },
      branch: "pz/live-secret",
    },
  });
  const agent = new ClaudeAgent({
    client: "ponzu-runner/live-test",
    log: (l) => logs.push(l),
    // `~` is this folder for the agent's commands, so `~/.ponzu/secrets` is the writer's.
    env: { ...process.env, HOME: home },
  });
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: async () => work,
    stateDir: state,
    log: (m) => logs.push(m),
    secrets: [process.env.ANTHROPIC_API_KEY!],
    secretWriter: localSecretWriter(join(home, SECRETS_FOLDER)),
  });
  const deadline = Date.now() + 180_000;
  const wait = async (what: string, check: () => unknown) => {
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}\n${logs.join("\n")}`);
      await Bun.sleep(50);
    }
  };
  const idle = () =>
    api.lastState?.state === "idle" && api.usage.size > 0 && api.items().every((i) => !i.streaming);
  const report = (title: string) => {
    const cost = [...api.usage.values()]
      .flatMap((t) => t.models)
      .reduce((sum, m) => sum + m.costUsd, 0);
    console.log(
      [
        `${title}:`,
        ...api.items().map((i) => `  ${i.kind} ${JSON.stringify(i.payload).slice(0, 200)}`),
        `Questions: ${JSON.stringify([...api.questions.values()].map((q) => [q.kind, q.status]))}`,
        `Cost: $${cost.toFixed(4)}`,
      ].join("\n"),
    );
  };
  return { api, runner, home, wait, idle, report };
}

test.skipIf(!live)(
  "Needs you: a secret asked for, given, and read from its file by a command",
  async () => {
    const { api, runner, home, wait, idle, report } = await liveRepoRun();
    await runner.start();
    api.push({
      kind: "message",
      payload: {
        text: "We need STRIPE_TEST_KEY to go on; ask me for it with request_secret. Once you have it, run `wc -c < ~/.ponzu/secrets/STRIPE_TEST_KEY` and tell me only the number it prints. Don't print the key.",
      },
    });
    runner.poke();

    const asked = () => [...api.questions.values()].find((q) => q.kind === "secret");
    await wait("secret asked", asked);
    const question = asked()!;
    expect(question).toMatchObject({ kind: "secret", payload: { name: "STRIPE_TEST_KEY" } });
    api.giveSecret(question.id, FAKE_SECRET);
    runner.poke();
    await wait("idle", idle);
    await runner.stop();
    report("Secret");

    expect(await Bun.file(join(home, SECRETS_FOLDER, "STRIPE_TEST_KEY")).text()).toBe(FAKE_SECRET);
    expect(api.secrets.get(question.id)?.delivered).toBe(true);
    const said = api
      .items()
      .filter((i) => i.kind === "assistant")
      .map((i) => (i.payload as { text: string }).text)
      .join("\n");
    expect(said).toContain(String(FAKE_SECRET.length));
    // The value is nowhere the runner wrote: the thread, the state, a question, the feed.
    for (const written of [api.threadWrites, api.states, [...api.questions.values()], api.events]) {
      expect(JSON.stringify(written)).not.toContain(FAKE_SECRET);
    }
  },
  200_000,
);

test.skipIf(!live)(
  "Needs you: AskUserQuestion under bypassPermissions reaches canUseTool and raises a question row",
  async () => {
    const { api, runner, wait, idle, report } = await liveRepoRun();
    await runner.start();
    const message = api.push({
      kind: "message",
      payload: {
        text: "Before anything else, use the AskUserQuestion tool to ask me one question: should the card be blue or green, with those two options. Wait for my answer, then tell me in one sentence which I chose. Don't draw anything.",
      },
    });
    runner.poke();

    const asked = () => [...api.questions.values()].find((q) => q.kind === "question");
    await wait("question raised", asked);
    const question = asked()!;
    if (question.kind !== "question") throw new Error("not a question");
    const text = question.payload.questions[0]!.question;
    const answer = api.answer({ questionId: question.id, answers: { [text]: "Green" } });
    runner.poke();
    await wait("idle", idle);
    await runner.stop();
    report("AskUserQuestion");

    expect(api.delivered).toContain(message.id);
    expect(api.delivered).toContain(answer.id);
    const said = api
      .items()
      .filter((i) => i.kind === "assistant")
      .map((i) => (i.payload as { text: string }).text)
      .join("\n");
    expect(said.toLowerCase()).toContain("green");
  },
  200_000,
);
