import { afterAll, beforeAll, expect, test } from "bun:test";
import { getSandbox } from "@ponzu/db";
import recorded from "@ponzu/runner/fixtures/supported-models.api-key.json";
import { reportedModels } from "@ponzu/runner/models";
import { IMAGE_COMMANDS, type ReportedModel, RUNNER_HEADER } from "@ponzu/runner/protocol";
import { canvasSandboxName } from "@ponzu/sandbox";
import { call, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_SCOPE, type TestApp } from "../testing/index.ts";

/*
 * What a person's Claude account is offered, from a runner on it reporting what Claude Code
 * offers, through to the picker's query, the choices it takes and what a turn runs on
 * (docs/cloud.md, "Models"). On the fake sandboxes, with a real wake.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-first-key-0000000000";
const OTHER_KEY = "sk-ant-api03-maya-second-key-000000000";

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
  await connectKey(KEY);
});
afterAll(() => t.close());

const maya = async () => (await t.signInAs({ login: "maya" })).headers;

async function connectKey(key: string) {
  t.anthropic.keys.add(key);
  const connected = await call(t, await maya(), "POST", "/v1/claude/api-key", { key });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
}

/** The runner the canvas's last start started, with the session it was answered. */
async function runnerIn(canvasId: string) {
  const name = canvasSandboxName(TEST_SCOPE, canvasId);
  const start = t.sandboxes
    .commands(name)
    .filter((c) => c.kind === "start" && c.command.cmd === IMAGE_COMMANDS.start)
    .at(-1)!;
  const token = start.command.env!.PONZU_RUNNER_TOKEN!;
  const session = await call(t, { authorization: `Bearer ${token}` }, "POST", "/v1/runner/session");
  expect(session.status).toBe(200);
  const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: session.body.runnerId };
  return {
    session: session.body,
    report: (models: ReportedModel[], claudeCode = "2.1.322") =>
      call(t, headers, "POST", "/v1/runner/models", { claudeCode, models }),
  };
}

/** A canvas of Maya's, made as the composer makes it, its sandbox awake. */
async function newCanvas(body: Record<string, unknown> = {}) {
  const made = await call(t, await maya(), "POST", "/v1/canvases", {
    workspaceId: ws.id,
    message: { text: "Draw a calmer pricing page" },
    ...body,
  });
  expect(made.status).toBe(201);
  await t.backgroundDone();
  expect((await getSandbox(t.db, made.body.id))?.state).toBe("awake");
  return made.body.id as string;
}

const RECORDED = reportedModels(recorded.models as Parameters<typeof reportedModels>[0]);
/** The account as it could be after Anthropic ships Opus 6: no Fable for it, and Opus 6 new. */
const LATER: ReportedModel[] = [
  ...RECORDED.filter((m) => m.value !== "fable"),
  {
    value: "claude-opus-6",
    resolvedModel: "claude-opus-6",
    displayName: "Opus 6",
    description: "Opus 6 · The newest Opus",
    efforts: ["low", "medium", "high"],
  },
];

const labels = (body: { models: { label: string }[] }) => body.models.map((m) => m.label);

test("an account is offered what its runner reported, and the hand-kept list before and after", async () => {
  // Connected, never run: the hand-kept list, so the picker is never empty.
  const before = await call(t, await maya(), "GET", "/v1/claude/defaults");
  expect(before.body).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  expect(labels(before.body)).toEqual(["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);

  // Made on Fable while the account was offered it.
  const onFable = await newCanvas({ model: "claude-fable-5-2", effort: "max" });
  const runner = await runnerIn(onFable);
  expect(runner.session).toMatchObject({ model: "claude-fable-5-2", effort: "max", models: null });

  // The recorded answer: the same four, by full id, named as Ponzu names them.
  expect((await runner.report(RECORDED)).body).toEqual({ kept: true });
  const recordedView = await call(t, await maya(), "GET", "/v1/claude/defaults");
  expect(recordedView.body.models.map((m: { id: string }) => m.id)).toEqual([
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);

  // Later: Opus 6 is new, under Claude Code's name, with its own efforts; Fable is gone.
  expect((await runner.report(LATER, "2.1.400")).body).toEqual({ kept: true });
  const later = await call(t, await maya(), "GET", "/v1/claude/defaults");
  expect(later.body).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  expect(later.body.models).toContainEqual({
    id: "claude-opus-6",
    label: "Opus 6",
    efforts: ["low", "medium", "high"],
  });
  expect(labels(later.body)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Opus 6"]);

  // The next runner hears what the API holds, and the canvas made on Fable runs on the
  // default in its place, at the effort it chose while that model takes it.
  const next = await runnerIn(onFable);
  expect(next.session.models).toMatchObject({ claudeCode: "2.1.400", models: LATER });
  expect(next.session.models.at).toEqual(expect.any(String));
  expect(next.session).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
  expect(t.logs.findLast((l) => l.event === "model_unoffered")).toMatchObject({
    canvasId: onFable,
    chosen: "claude-fable-5-2",
    runs: "claude-opus-5-5",
  });
});

test("only what the account offers can be chosen, and a saved choice it no longer offers gives way", async () => {
  const headers = await maya();
  const setTo = (body: Record<string, unknown>) =>
    call(t, headers, "PATCH", "/v1/claude/defaults", body);
  const create = (body: Record<string, unknown>) =>
    call(t, headers, "POST", "/v1/canvases", { workspaceId: ws.id, ...body });

  // Offered now (the last test's report): Opus 6, on its efforts.
  expect((await setTo({ model: "claude-opus-6", effort: "high" })).body).toMatchObject({
    model: "claude-opus-6",
    effort: "high",
  });
  for (const refused of [
    await setTo({ model: "claude-fable-5-2" }),
    await setTo({ effort: "max" }),
    await create({ model: "claude-fable-5-2" }),
    await create({ model: "opus" }),
    await create({ model: "claude-opus-6", effort: "xhigh" }),
  ]) {
    expect([refused.status, refused.body.error.code]).toEqual([400, "model_not_offered"]);
  }
  const made = await create({ model: "claude-opus-6" });
  expect(made.status).toBe(201);

  // Another key: nothing is known of what it is offered, so the hand-kept list, and what will
  // run in place of the saved Opus 6 shows: Opus 5.5, on the saved effort, which it takes.
  await connectKey(OTHER_KEY);
  const after = await call(t, headers, "GET", "/v1/claude/defaults");
  expect(labels(after.body)).toEqual(["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  expect(after.body).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
});

test("a runner on a credential since replaced reports nothing for the one there now", async () => {
  const canvasId = await newCanvas();
  const runner = await runnerIn(canvasId);
  expect((await runner.report(LATER)).body).toEqual({ kept: true });

  // Connected again before this runner was restarted: it still holds the old key.
  await connectKey(KEY);
  expect((await runner.report(LATER)).body).toEqual({ kept: false });
  const now = await call(t, await maya(), "GET", "/v1/claude/defaults");
  expect(labels(now.body)).toEqual(["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
});

test("a report is the protocol's shape or is refused", async () => {
  const id = await newCanvas();
  const runner = await runnerIn(id);
  for (const bad of [
    [],
    [{ value: "", resolvedModel: null, displayName: "", description: "", efforts: null }],
    [{ ...LATER[0]!, efforts: ["extreme"] }],
    Array.from({ length: 51 }, (_, i) => ({ ...LATER[0]!, value: `m${i}` })),
  ]) {
    const answer = await runner.report(bad as ReportedModel[]);
    expect([answer.status, answer.body.error.code]).toEqual([400, "invalid_request"]);
  }
});
