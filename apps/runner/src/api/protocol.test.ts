import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDoc } from "@ponzu/core";
import { ScriptedAgent } from "../agent/scripted.ts";
import { randomId } from "../ids.ts";
import { Runner } from "../run.ts";
import { ApiError } from "./api.ts";
import { FakeRunnerApi } from "./fake.ts";
import { fakeApiHandler } from "./fake-http.ts";
import { HttpRunnerApi } from "./http.ts";

const TOKEN = "pzr_test";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** The fake API behind the protocol's routes on a real port, and the HTTP client pointed at it. */
function served(fake = new FakeRunnerApi()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: fakeApiHandler(fake, { designId: "des_test", token: TOKEN }),
  });
  stops.push(() => server.stop(true));
  const http = (token = TOKEN) =>
    new HttpRunnerApi({
      baseUrl: `http://127.0.0.1:${server.port}`,
      designId: "des_test",
      token,
      client: "runner/test",
    });
  /** A client that has taken the lease. */
  const connected = async () => {
    const client = http();
    await client.session();
    return client;
  };
  return { fake, http, connected };
}

test("a token the API does not know is refused on every route", async () => {
  const { http } = served();
  const err = await http("pzr_wrong")
    .session()
    .catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 401, code: "token_invalid" });
});

test("the runner over HTTP: an event in, an artboard drawn, the thread and state out", async () => {
  const { fake, http } = served(new FakeRunnerApi({ doc: emptyDoc("Fern") }));
  const agent = new ScriptedAgent();
  const dir = await mkdtemp(join(tmpdir(), "ponzu-protocol-"));
  stops.push(() => rm(dir, { recursive: true, force: true }));
  const runner = new Runner({
    api: http(),
    agent,
    prepare: async () => dir,
    stateDir: dir,
    log: () => {},
    timing: { threadGapMs: 5, stateGapMs: 5, batchGapMs: 5, settleMs: 2_000 },
  });
  stops.push(() => runner.stop());
  await runner.start();
  const run = agent.last;
  run.ready("sess_http");

  const event = fake.push({ kind: "message", payload: { text: "A card, please." } });
  runner.poke();
  const input = await run.input();
  expect(input.text).toBe("Message from Ada:\nA card, please.");
  run.take(input);
  await run.call("create_artboard", { name: "Card", html: "<p>Hi</p>" });
  run.say("msg_1", "Drew a card.");
  run.end({
    id: "res_1",
    usage: [
      {
        model: "claude-haiku",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
    ],
  });

  const deadline = Date.now() + 3_000;
  // Thread writes have a pacer of their own, so the last can land just after the idle report.
  while (
    fake.lastState?.state !== "idle" ||
    !fake.usage.has("res_1") ||
    !fake.delivered.length ||
    fake.items().some((item) => item.streaming) ||
    fake.items().length < 3
  ) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
  expect(fake.delivered).toEqual([event.id]);
  expect(fake.doc.snapshot().doc.pages[0]?.artboards[0]?.name).toBe("Card");
  expect(fake.items().map((i) => i.kind)).toEqual(["notice", "tool", "assistant"]);
  expect(fake.lastState?.claudeSessionId).toBe("sess_http");
});

test("an upload goes to the address the API gave, and comes back as a reference", async () => {
  const { fake, connected } = served();
  const [stored] = await (await connected()).upload([
    {
      purpose: "asset",
      name: "logo.svg",
      contentType: "image/svg+xml",
      bytes: new Uint8Array([60]),
    },
  ]);
  expect(stored).toEqual({
    name: "logo.svg",
    ref: "assets/logo.svg",
    url: "https://assets.ponzu.test/key/logo.svg",
  });
  expect(fake.uploads[0]?.bytes).toEqual(new Uint8Array([60]));
});

test("a Scratch design has no git credential, and another repository's is refused", async () => {
  const { fake, connected } = served();
  const http = await connected();
  const ask = { protocol: "https", host: "github.com", path: "north/fern.git" };
  await expect(http.gitCredential(ask)).rejects.toMatchObject({ status: 404 });
  fake.sessionInfo.repo = { owner: "north", name: "fern", defaultBranch: "main" };
  expect(await http.gitCredential(ask)).toMatchObject({ username: "x-access-token" });
  await expect(http.gitCredential({ ...ask, path: "north/other.git" })).rejects.toMatchObject({
    status: 403,
    code: "forbidden",
  });
});

test("only the runner that started last is answered: an older one is told it was superseded", async () => {
  const { connected } = served();
  const older = await connected();
  const newer = await connected();
  expect(await newer.claim({ claimId: randomId("clm") })).toMatchObject({ events: [] });
  await expect(older.claim({ claimId: randomId("clm") })).rejects.toMatchObject({
    status: 409,
    code: "superseded",
  });
  await expect(older.sync.fetchDoc()).rejects.toMatchObject({ status: 409, code: "superseded" });
});

test("a notice only the API writes is refused from a runner", async () => {
  const { fake, connected } = served();
  const http = await connected();
  const pr = {
    id: "ti_pr",
    kind: "notice" as const,
    payload: {
      type: "pull_request",
      number: 12,
      url: "https://evil.test",
      title: "",
      state: "open",
    },
    streaming: false,
  };
  await expect(http.writeThread([pr as never])).rejects.toMatchObject({ status: 400 });
  // Who stopped the run is the API's to say, from the stop event.
  const stop = fake.push({ kind: "stop", payload: {} });
  await http.writeThread([
    {
      id: "ti_stop",
      kind: "notice",
      payload: { type: "stopped", eventId: stop.id },
      streaming: false,
    },
  ]);
  expect(fake.thread.get("ti_stop")?.payload).toEqual({
    type: "stopped",
    by: fake.events[0]!.event.from,
  });
});

test("a checkpoint over HTTP: archives up, recorded only forward, and read back as they were", async () => {
  const { fake, connected } = served();
  const http = await connected();
  const session = new TextEncoder().encode("a gzipped transcript");
  const workspace = new TextEncoder().encode("a gzipped folder");
  const none = { claudeSessionId: null, wipCommit: null, session: null, workspace: null };
  const saved = await http.saveCheckpoint({
    ...none,
    turn: 2,
    claudeSessionId: "s1",
    session,
    workspace,
  });
  expect(saved).toMatchObject({ turn: 2, claudeSessionId: "s1", session: true, workspace: true });
  // Late, or sent again: the API keeps the newer one.
  expect((await http.saveCheckpoint({ ...none, turn: 1 })).turn).toBe(2);
  // The archives never go where the design's files are.
  expect(fake.uploads).toEqual([]);

  const back = await http.restore();
  expect(back.saved?.turn).toBe(2);
  expect(new TextDecoder().decode(back.session!)).toBe("a gzipped transcript");
  expect(new TextDecoder().decode(back.workspace!)).toBe("a gzipped folder");

  await http.reportRestored({
    kind: "rollback",
    disk: { turn: 1, at: saved.at, bootId: "b1" },
    saved: { turn: 2, at: saved.at },
    bootId: "b2",
    bootAt: null,
    restored: { session: true, workspace: false },
  });
  expect(fake.restored).toMatchObject([{ kind: "rollback", bootId: "b2" }]);
  // The next runner starts with it.
  expect((await connected().then((c) => c.session())).saved?.turn).toBe(2);
});

test("the state answer says when the sandbox is going to sleep, and the pull request summary goes through", async () => {
  const { fake, connected } = served();
  const http = await connected();
  const state = { state: "idle" as const, status: null, artboards: [], claudeSessionId: null };
  expect(await http.putState(state)).toEqual({ seq: 0, sleep: null });
  fake.sleep = "2026-11-11T10:00:00.000Z";
  expect((await http.putState({ ...state, quiesced: fake.sleep })).sleep).toBe(fake.sleep);
  expect(fake.quiesced).toEqual([fake.sleep]);
  expect(await http.pullRequestSummary("What the branch does.")).toEqual({
    pullRequest: null,
    open: null,
    kept: "none_open",
  });
  expect(fake.summaries).toEqual(["What the branch does."]);
});
