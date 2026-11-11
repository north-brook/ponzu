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
import type { WorkItem } from "./api/protocol.ts";
import { eventUuid } from "./ids.ts";
import { Runner } from "./run.ts";

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
