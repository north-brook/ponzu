import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedAgent, type ScriptedRun } from "./agent/scripted.ts";
import { FakeRunnerApi } from "./api/fake.ts";
import type { RunnerSession } from "./api/protocol.ts";
import { Runner, SUMMARY_TOOL, type Timing } from "./run.ts";
import { agentShell } from "./save/shell.ts";
import { Transcripts } from "./save/transcripts.ts";
import { ScratchWork } from "./save/work.ts";

/*
 * What lives only on a sandbox's disk, kept through the runner: a checkpoint after each turn,
 * getting ready before a sleep, and a disk that comes back behind the last checkpoint.
 */

const FAST: Partial<Timing> = {
  threadGapMs: 5,
  stateGapMs: 5,
  batchGapMs: 5,
  settleMs: 500,
  stopStepMs: 300,
  previewDelayMs: 10,
  restartMs: 10,
  quiesceTurnMs: 400,
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
  opts: { agent?: ScriptedAgent; session?: Partial<RunnerSession> } = {},
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
    timing: FAST,
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

test("asked to get ready for sleep, the runner takes no new work, finishes its turn, saves, flushes and says so", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  await writeTranscript(d.config, ['{"type":"user"}']);

  // The API is stopping the sandbox; the runner hears it on its next report.
  api.sleep = "2026-11-11T10:00:00.000Z";
  s.runner.report();
  await until(() => s.logs.some((l) => l.startsWith("getting ready to sleep")));
  // A message now waits in the feed: nothing is claimed while it goes to sleep.
  const waiting = api.push({ kind: "message", payload: { text: "Later" } });
  s.runner.poke();
  await Bun.sleep(30);
  expect(api.events.find((e) => e.event.id === waiting.id)!.claimedBy).toBeUndefined();
  expect(api.quiesced).toEqual([]);

  // The turn ends; then it is ready.
  s.run.say("m1", "Done.");
  s.run.end();
  await until(() => api.quiesced.length === 1);
  expect(api.quiesced).toEqual(["2026-11-11T10:00:00.000Z"]);
  expect(api.saved?.session).toBe(true);
  expect(s.order.length).toBeGreaterThan(0);

  // A warm resume thaws the same process: the API says it is awake, and work goes on.
  api.sleep = null;
  s.runner.report();
  await until(() => api.events.find((e) => e.event.id === waiting.id)!.claimedBy !== undefined);
  await until(() => api.lastState?.quiesced === null);
});

test("a report asked for while the runner is still starting waits: it has no lease to send it under", async () => {
  // A cold boot: the port answers before the session does, and the API's stop or wake asks.
  const api = new FakeRunnerApi();
  api.down = true;
  const d = await disk();
  const fatal: string[] = [];
  const runner = new Runner({
    api: api.client(),
    agent: new ScriptedAgent(),
    prepare: async () => d.work,
    stateDir: d.stateDir,
    log: () => {},
    onFatal: (reason) => fatal.push(reason),
    timing: FAST,
  });
  open.push(runner);
  const started = runner.start();
  runner.report();
  runner.report();
  await Bun.sleep(60);
  api.down = false;
  await started;
  await until(() => api.states.length > 0);
  expect(fatal).toEqual([]);
  expect(api.calls.filter((c) => c === "session")).not.toHaveLength(0);
  // Everything after the session carried its lease.
  expect(api.calls.indexOf("putState")).toBeGreaterThan(api.calls.lastIndexOf("session"));
});

test("a turn that will not finish does not hold the sleep up for long", async () => {
  const api = new FakeRunnerApi();
  const d = await disk();
  const s = await start(api, d);
  s.run.ready(SESSION);
  await turn(api, s);
  api.sleep = "2026-11-11T10:05:00.000Z";
  s.runner.report();
  await until(() => api.quiesced.length === 1, 3_000);
  expect(s.run.interrupts).toBe(0);
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

test("the agent's own words describe its branch, for the pull request", async () => {
  const api = new FakeRunnerApi({
    session: { repo: { owner: "north", name: "fern", defaultBranch: "main" }, branch: "pz/hero" },
  });
  const d = await disk();
  const s = await start(api, d);
  const result = await s.run.call(SUMMARY_TOOL, { summary: "A calmer hero, one CTA." });
  expect(api.summaries).toEqual(["A calmer hero, one CTA."]);
  expect(result.text).toContain("when one is opened");
  expect(s.run.opts.instructions).toContain(SUMMARY_TOOL);

  // Scratch has no branch, so no pull request and no such tool.
  const scratch = await start(new FakeRunnerApi(), await disk());
  expect(scratch.run.opts.tools.some((t) => t.name === SUMMARY_TOOL)).toBe(false);
});
