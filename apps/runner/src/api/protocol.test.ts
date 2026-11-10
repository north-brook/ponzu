import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDoc } from "@ponzu/core";
import { ScriptedAgent } from "../agent/scripted.ts";
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
  return { fake, http };
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
    timing: { threadGapMs: 5, stateGapMs: 5, ackGapMs: 5, settleMs: 2_000 },
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
  while (fake.lastState?.state !== "idle" || !fake.usage.has("res_1") || !fake.delivered.length) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
  expect(fake.delivered).toEqual([event.id]);
  expect(fake.doc.snapshot().doc.pages[0]?.artboards[0]?.name).toBe("Card");
  expect(fake.items().map((i) => i.kind)).toEqual(["notice", "tool", "assistant"]);
  expect(fake.lastState?.claudeSessionId).toBe("sess_http");
});

test("an upload goes to the address the API gave, and comes back as a reference", async () => {
  const { fake, http } = served();
  const [stored] = await http().upload([
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
  const { fake, http } = served();
  const ask = { protocol: "https", host: "github.com", path: "north/fern.git" };
  await expect(http().gitCredential(ask)).rejects.toMatchObject({ status: 404 });
  fake.sessionInfo.repo = { owner: "north", name: "fern", defaultBranch: "main" };
  expect(await http().gitCredential(ask)).toMatchObject({ username: "x-access-token" });
  await expect(http().gitCredential({ ...ask, path: "north/other.git" })).rejects.toMatchObject({
    status: 403,
    code: "forbidden",
  });
});
