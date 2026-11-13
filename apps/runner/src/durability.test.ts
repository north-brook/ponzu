import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ScriptedAgent, type ScriptedRun } from "./agent/scripted.ts";
import { FakeRunnerApi } from "./api/fake.ts";
import type { RunnerSession } from "./api/protocol.ts";
import { Runner, type Timing } from "./run.ts";
import { agentShell } from "./save/shell.ts";
import { Transcripts, USAGE_FILE } from "./save/transcripts.ts";
import { ScratchWork } from "./save/work.ts";

/*
 * What lives only on a sandbox's disk, kept through the runner: a checkpoint after each turn,
 * what a stop saves, and a disk that comes back behind the last checkpoint.
 */

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 500,
  stopStepMs: 300,
  previewDelayMs: 10,
  restartMs: 10,
  checkpointMs: 2_000,
  backoff: () => 20,
};

const open: Runner[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.stop()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-durable-"));
  dirs.push(dir);
  return dir;
}

async function until(check: () => unknown, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const SESSION = "0c6e0f0a-1111-4222-8333-944455556666";

/** One sandbox's disk: the runner's state, the Scratch folder and Claude Code's config. */
async function disk() {
  return { stateDir: await temp(), work: await temp(), config: await temp() };
}

async function writeTranscript(config: string, lines: string[]): Promise<string> {
  const project = join(config, "projects", "-home-agent-work-scratch");
  await mkdir(project, { recursive: true });
  const file = join(project, `${SESSION}.jsonl`);
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

async function start(
  api: FakeRunnerApi,
  d: Awaited<ReturnType<typeof disk>>,
  opts: { agent?: ScriptedAgent; session?: Partial<RunnerSession>; timing?: Partial<Timing> } = {},
) {
  const agent = opts.agent ?? new ScriptedAgent();
  const shell = agentShell(undefined, process.env);
  const order: string[] = [];
  const logs: string[] = [];
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: async () => d.work,
    stateDir: d.stateDir,
    saving: () => ({
      transcripts: new Transcripts({ configDir: d.config, shell }),
      work: new ScratchWork({ cwd: d.work, shell }),
    }),
    boot: () => ({ id: "boot-b", at: null }),
    flush: () => {
      order.push(`flush after ${api.checkpoints.length} checkpoints`);
    },
    log: (m) => logs.push(m),
    timing: { ...FAST, ...opts.timing },
  });
  open.push(runner);
  await runner.start();
  return { runner, agent, run: agent.last as ScriptedRun, order, logs };
}

async function turn(api: FakeRunnerApi, s: Awaited<ReturnType<typeof start>>, text = "Go") {
  api.push({ kind: "message", payload: { text } });
  s.runner.poke();
  s.run.take(await s.run.input());
}

test("once a turn has settled its checkpoint is saved, and then the disk is flushed", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  await writeTranscript(d.config, ['{"type":"user"}', '{"type":"assistant"}']);
  await writeFile(join(d.work, "hero.html"), "<h1>Hi</h1>\n");
  s.run.say("m1", "Drawn.");
  expect(api.checkpoints).toHaveLength(0);
  s.run.end();

  await until(() => s.order.length > 0);
  expect(api.saved).toMatchObject({
    turn: 1,
    claudeSessionId: SESSION,
    session: true,
    workspace: true,
  });
  expect(s.order[0]).toBe("flush after 1 checkpoints");
  expect(JSON.parse(readFileSync(join(d.stateDir, "checkpoint.json"), "utf8")).turn).toBe(1);
});

test("a stop saves a checkpoint of the session, flushes the disk and reports the final state", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  await writeTranscript(d.config, ['{"type":"user"}']);
  s.run.say("m1", "Done.");
  s.run.end();
  await until(() => api.checkpoints.length === 1);
  const flushed = s.order.length;
  const states = api.states.length;
  // Claude Code writes the transcript's last lines as it closes.
  await writeTranscript(d.config, ['{"type":"user"}', '{"type":"assistant"}']);

  // ponzu-stop: SIGTERM, which main.ts answers with `stop`.
  await s.runner.stop();
  expect(api.checkpoints).toHaveLength(2);
  expect(api.saved?.session).toBe(true);
  expect(s.order.length).toBeGreaterThan(flushed);
  expect(api.states.length).toBeGreaterThan(states);
  expect(api.lastState?.state).toBe("idle");
  expect(s.run.closed).toBe(true);
  expect(s.runner.health().started).toBe(false);
});

test("a claim in flight when the stop comes puts nothing into the run: the next runner gets it", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d, { timing: { heartbeatMs: 60_000 } });
  s.run.ready(SESSION);
  await until(() => api.calls.includes("claim"));
  api.delays.set("claim", 300);
  const message = api.push({ kind: "message", payload: { text: "Mid-claim" } });
  s.runner.poke();
  await Bun.sleep(20);
  await s.runner.stop();
  await Bun.sleep(400);
  expect(s.run.inputs).toHaveLength(0);
  expect(api.events.find((e) => e.event.id === message.id)!.deliveredAt).toBeUndefined();
});

test("a stop during a turn interrupts it, and the thread says so", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  await s.runner.stop();
  expect(s.run.interrupts).toBe(1);
  expect(
    api
      .items()
      .some(
        (i) =>
          i.kind === "notice" &&
          i.payload.type === "error" &&
          i.payload.message.includes("before Claude finished"),
      ),
  ).toBe(true);
});

test("a disk behind the last checkpoint gets the session and the work back before Claude Code resumes", async () => {
  const api = new FakeRunnerApi();
  const first = await disk();
  const a = await start(api, first);
  a.run.ready(SESSION);
  await turn(api, a, "Write the notes");
  const file = await writeTranscript(first.config, ['{"turn":1}']);
  await writeFile(join(first.work, "notes.md"), "turn one\n");
  a.run.end();
  await until(() => api.saved?.turn === 1);
  const markerAtOne = readFileSync(join(first.stateDir, "checkpoint.json"), "utf8");
  await turn(api, a, "And more");
  await writeTranscript(first.config, ['{"turn":1}', '{"turn":2}']);
  await writeFile(join(first.work, "notes.md"), "turn two\n");
  a.run.end();
  await until(() => api.saved?.turn === 2);
  await a.runner.stop();

  // The disk comes back as it was at turn one: marker, transcript and work all older.
  await writeFile(join(first.stateDir, "checkpoint.json"), markerAtOne);
  await writeTranscript(first.config, ['{"turn":1}']);
  await writeFile(join(first.work, "notes.md"), "turn one\n");
  const { utimesSync } = await import("node:fs");
  utimesSync(file, 1, 1);
  utimesSync(join(first.work, "notes.md"), 1, 1);

  const agent = new ScriptedAgent();
  agent.sessions.set(SESSION, { messages: new Set(), toolResults: new Set() });
  const b = await start(api, first, { agent });

  expect(b.runner.recovery).toEqual({
    kind: "rollback",
    restored: { session: true, workspace: true },
  });
  expect(readFileSync(file, "utf8")).toBe('{"turn":1}\n{"turn":2}\n');
  expect(readFileSync(join(first.work, "notes.md"), "utf8")).toBe("turn two\n");
  expect(b.run.opts.resume).toBe(SESSION);
  expect(api.restored).toMatchObject([{ kind: "rollback", disk: { turn: 1 }, saved: { turn: 2 } }]);
  expect(b.logs.some((l) => l.includes('"event":"sandbox_rollback"'))).toBe(true);
  await until(() => api.items().some((i) => i.kind === "notice" && i.payload.type === "resumed"));
});

test("a new sandbox, with nothing on its disk, starts from the last checkpoint", async () => {
  const api = new FakeRunnerApi();
  const first = await disk();
  const a = await start(api, first);
  a.run.ready(SESSION);
  await turn(api, a);
  await writeTranscript(first.config, ['{"turn":1}']);
  await writeFile(join(first.work, "notes.md"), "kept\n");
  a.run.end();
  await until(() => api.saved?.turn === 1);
  await a.runner.stop();

  const second = await disk();
  const b = await start(api, second);
  expect(b.runner.recovery.kind).toBe("rebuilt");
  expect(readFileSync(join(second.work, "notes.md"), "utf8")).toBe("kept\n");
  expect(
    existsSync(join(second.config, "projects", "-home-agent-work-scratch", `${SESSION}.jsonl`)),
  ).toBe(true);
});

test("the session names this boot, and a message taken in while a checkpoint uploads is not counted as held", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  // `start` gives the runner the boot `boot-b`.
  expect(api.sessionRequests).toEqual([{ boot: "boot-b" }]);
  s.run.ready(SESSION);
  const first = api.push({ kind: "message", payload: { text: "One" } });
  s.runner.poke();
  s.run.take(await s.run.input());
  await writeTranscript(d.config, ['{"turn":1}']);
  s.run.say("m1", "Done.");
  // The checkpoint's archive is on its way up for a while: a new message comes in meanwhile.
  api.delays.set("saveCheckpoint", 400);
  s.run.end();
  await until(() => api.calls.includes("saveCheckpoint"));
  const second = api.push({ kind: "message", payload: { text: "Two" } });
  s.runner.poke();
  s.run.take(await s.run.input());
  await until(() => api.checkpoints.length === 1);
  expect(api.checkpoints[0]).toMatchObject({ turn: 1, heldThrough: first.seq });
  expect(second.seq).toBeGreaterThan(first.seq);
});

test("a runner without a boot sends the session what a runner from before did", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const agent = new ScriptedAgent();
  const runner = new Runner({
    api: api.client(),
    agent,
    prepare: async () => d.work,
    stateDir: d.stateDir,
    log: () => {},
    timing: FAST,
  });
  open.push(runner);
  await runner.start();
  expect(api.sessionRequests).toEqual([{}]);
});

test("a turn's usage totals go in its checkpoint's transcript archive", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  await writeTranscript(d.config, ['{"turn":1}']);
  s.run.say("m1", "Done.");
  const opus = {
    model: "opus",
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.25,
  };
  s.run.end({ usage: [opus] });
  await until(() => api.checkpoints.length === 1);
  const tar = gunzipSync(api.archives.session!).toString("utf8");
  expect(tar).toContain(USAGE_FILE);
  expect(tar).toContain(JSON.stringify({ sessionId: SESSION, totals: [opus] }));
});
