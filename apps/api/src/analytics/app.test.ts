import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { appendEvent, newId } from "@ponzu/db";
import { Hono } from "hono";
import { access } from "../auth/access.ts";
import { createApp } from "../create-app.ts";
import { reconcileInstallation } from "../github/installations.ts";
import type { AppEnv } from "../http/context.ts";
import { call, canvasWithRunner, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type FakeInstallation, type TestApp } from "../testing/index.ts";
import { DISTINCT_ID_HEADER, SESSION_HEADER } from "./middleware.ts";
import { withScope } from "./scope.ts";

// The server's analytics through the real app: what each request captures, about whom, in which
// workspace and app session, as PostHog would be handed it.

const SESSION = "0192e0a0-0000-7000-8000-00000000abcd";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read" });
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.backgroundDone();
  t.analytics.events.length = 0;
  t.analytics.exceptions.length = 0;
});

/** Maya's headers, as the app sends them with posthog-js's tracing headers. */
const maya = (extra: Record<string, string> = {}) => ({
  ...ws.people.maya!.headers,
  [SESSION_HEADER]: SESSION,
  ...extra,
});

describe("accounts", () => {
  test("a first sign-in is a sign-up and a sign-in, with the person's profile; the next only a sign-in", async () => {
    const first = await t.signInAs({ login: "newcomer" });
    expect(t.analytics.names()).toEqual(
      expect.arrayContaining(["user signed up", "user signed in"]),
    );
    expect(t.analytics.of("user signed in")[0]).toMatchObject({
      distinctId: first.userId,
      properties: { new_user: true },
    });
    expect(t.analytics.people.at(-1)).toMatchObject({
      distinctId: first.userId,
      set: { name: "Newcomer", email: "newcomer@example.com", github_login: "newcomer" },
      setOnce: { signed_up_at: expect.any(String) },
    });

    t.analytics.events.length = 0;
    await t.signInAs({ login: "newcomer" });
    expect(t.analytics.of("user signed up")).toEqual([]);
    expect(t.analytics.of("user signed in")[0]!.properties.new_user).toBe(false);
  });

  test("signing out is the person's", async () => {
    const person = await t.signInAs({ login: "leaver" });
    await call(t, person.headers, "POST", "/v1/auth/sign-out");
    expect(t.analytics.of("user signed out")[0]!.distinctId).toBe(person.userId);
  });
});

describe("workspaces and ideas", () => {
  test("a workspace connected through the App is captured once, with its group's profile", async () => {
    const installation: FakeInstallation = {
      id: 7_700_001,
      account: { id: 7_700_002, login: "north-brook", type: "Organization" },
      repositorySelection: "all",
      repositories: [{ id: 7_700_003, fullName: "north-brook/site", private: true, access: {} }],
    };
    t.github.installations.push(installation);
    const installer = ws.people.maya!.userId;

    const workspace = await reconcileInstallation(t.deps, installation.id, {
      installedByUserId: installer,
    });
    // Read again (a sync, the sweep): nothing new happened.
    await reconcileInstallation(t.deps, installation.id);

    const connected = t.analytics.of("workspace connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      distinctId: installer,
      groups: { workspace: workspace!.id },
      properties: { workspace_id: workspace!.id, kind: "organization", repos: 1 },
    });
    expect(t.analytics.groups.at(-1)).toEqual({
      groupType: "workspace",
      groupKey: workspace!.id,
      properties: {
        name: "north-brook",
        kind: "organization",
        repos: 1,
        repository_selection: "all",
      },
    });

    // GitHub no longer has it: the workspace is disconnected, once.
    t.github.installations.splice(t.github.installations.indexOf(installation), 1);
    await reconcileInstallation(t.deps, installation.id);
    await reconcileInstallation(t.deps, installation.id);
    expect(t.analytics.of("workspace disconnected").map((e) => e.properties)).toEqual([
      { workspace_id: workspace!.id, reason: "uninstalled", $process_person_profile: false },
    ]);
  });

  test("an install read at once by its webhook and the setup is connected once, and so is each change after", async () => {
    const installation: FakeInstallation = {
      id: 7_700_011,
      account: { id: 7_700_012, login: "fernwood", type: "User" },
      repositorySelection: "all",
      repositories: [],
    };
    t.github.installations.push(installation);
    const installer = ws.people.maya!.userId;
    // The App's webhook, which names the installer, and the setup they came back to, which runs
    // in their request.
    const setup = {
      userId: () => installer,
      canvasId: () => null,
      sessionId: SESSION,
      requestId: "req_setup",
      route: () => "GET /v1/github/accounts",
      workspaceId: null,
    };
    const both = () =>
      Promise.all([
        reconcileInstallation(t.deps, installation.id, { installedByUserId: installer }),
        withScope(setup, () => reconcileInstallation(t.deps, installation.id)),
      ]);

    const [workspace] = await both();
    const connected = t.analytics.of("workspace connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]!.distinctId).toBe(installer);
    await both();
    expect(t.analytics.of("workspace connected")).toHaveLength(1);

    // Suspended: said by both, under one id and GitHub's time, which PostHog keeps once.
    installation.suspendedAt = new Date("2026-11-10T12:00:00.000Z");
    await both();
    const suspended = t.analytics.of("workspace disconnected");
    expect(suspended.length).toBeGreaterThan(0);
    expect(new Set(suspended.map((e) => e.uuid)).size).toBe(1);
    expect(suspended[0]).toMatchObject({
      properties: { workspace_id: workspace!.id, reason: "suspended" },
      timestamp: installation.suspendedAt,
    });

    // Lifted: connected again, once.
    installation.suspendedAt = null;
    t.analytics.events.length = 0;
    await both();
    expect(t.analytics.of("workspace connected")).toHaveLength(1);

    // Uninstalled: only the reader that took the installation off says so.
    t.analytics.events.length = 0;
    t.github.installations.splice(t.github.installations.indexOf(installation), 1);
    await both();
    expect(t.analytics.of("workspace disconnected").map((e) => e.properties.reason)).toEqual([
      "uninstalled",
    ]);
  });

  test("a repo's ideas are generated or skipped, under its workspace, for whoever asked", async () => {
    await call(t, maya(), "GET", `/v1/repos/${ws.repo.id}/ideas`);
    await t.backgroundDone();
    const said = [...t.analytics.of("ideas generated"), ...t.analytics.of("ideas skipped")];
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      distinctId: ws.people.maya!.userId,
      groups: { workspace: ws.id },
      properties: { repo_id: ws.repo.id, $session_id: SESSION },
    });
  });
});

describe("canvases and the thread", () => {
  test("a canvas made from an idea, with its first message, under the app's session", async () => {
    const { status, body } = await call(t, maya(), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
      message: { text: "Make checkout one page" },
      source: "idea",
    });
    expect(status).toBe(201);

    const [created] = t.analytics.of("canvas created");
    expect(created).toMatchObject({
      distinctId: ws.people.maya!.userId,
      groups: { workspace: ws.id },
      properties: {
        canvas_id: body.id,
        source: "idea",
        with_message: true,
        workspace_id: ws.id,
        $session_id: SESSION,
      },
    });
    expect(t.analytics.of("message sent")[0]!.properties).toMatchObject({
      canvas_id: body.id,
      first: true,
      characters: "Make checkout one page".length,
    });
    // A canvas's name, and what the person typed, never go.
    expect(JSON.stringify(t.analytics.events)).not.toContain("checkout one page");
  });

  test("Scratch is its own source, and a create sent again is no second design", async () => {
    const body = { workspaceId: ws.id, createKey: "scratch-key-1" };
    await call(t, maya(), "POST", "/v1/canvases", body);
    await call(t, maya(), "POST", "/v1/canvases", body);
    const created = t.analytics.of("canvas created");
    expect(created).toHaveLength(1);
    expect(created[0]!.properties.source).toBe("scratch");
  });

  test("the app's distinct id header is never who a request is about", async () => {
    await call(t, maya({ [DISTINCT_ID_HEADER]: "usr_someone_else" }), "POST", "/v1/canvases", {
      workspaceId: ws.id,
    });
    expect(t.analytics.of("canvas created")[0]!.distinctId).toBe(ws.people.maya!.userId);
  });

  test("a session header that is not a PostHog session id is not kept", async () => {
    await call(t, maya({ [SESSION_HEADER]: "not a session" }), "POST", "/v1/canvases", {
      workspaceId: ws.id,
    });
    expect(t.analytics.of("canvas created")[0]!.properties.$session_id).toBeUndefined();
  });

  test("a message's app session goes with it to the runner, which traces the turn under it", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const sent = await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "Make it blue",
    });
    expect(sent.status).toBe(201);
    expect(t.analytics.of("message sent")[0]!.properties).toMatchObject({
      canvas_id: canvas.id,
      first: false,
      $session_id: SESSION,
    });

    const claimed = await call(t, runner.headers, "POST", "/v1/runner/events/claim", {
      claimId: newId("clm"),
    });
    expect(claimed.body.events[0]).toMatchObject({ kind: "message", posthogSessionId: SESSION });
  });

  test("stopping the agent and deleting the canvas are the person's", async () => {
    const { canvas } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/stop`);
    await call(t, maya(), "DELETE", `/v1/canvases/${canvas.id}`);
    expect(t.analytics.names()).toEqual(expect.arrayContaining(["turn stopped", "canvas deleted"]));
    expect(t.analytics.of("canvas deleted")[0]!.properties).toMatchObject({
      canvas_id: canvas.id,
      by_owner: true,
    });
  });
});

describe("turns", () => {
  test("a turn's report is its start and finish, for the person whose message began it", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const event = await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Go" },
      userId: ws.people.maya!.userId,
      posthogSessionId: SESSION,
    });
    const turn = {
      id: "3f1c2a9e-0000-4000-8000-000000000001",
      claudeSessionId: "sess_1",
      at: "2026-11-11T10:00:30.000Z",
      models: [
        {
          model: "claude-haiku-5-5",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5_000,
          cacheWriteTokens: 10,
          costUsd: 0.012,
        },
      ],
      turn: {
        startedAt: "2026-11-11T10:00:00.000Z",
        outcome: "completed",
        errorCode: null,
        durationMs: 30_000,
        toolCalls: 7,
        eventId: event.id,
      },
    };
    // Sent twice, as after an answer that was lost.
    for (let i = 0; i < 2; i++) {
      await call(t, runner.headers, "POST", "/v1/runner/usage", { turns: [turn] });
      await t.backgroundDone();
    }

    const started = t.analytics.of("turn started");
    const finished = t.analytics.of("turn finished");
    expect(started[0]).toMatchObject({
      distinctId: ws.people.maya!.userId,
      groups: { workspace: ws.id },
      timestamp: new Date("2026-11-11T10:00:00.000Z"),
      properties: { canvas_id: canvas.id, turn_id: turn.id, $session_id: SESSION },
    });
    expect(finished[0]).toMatchObject({
      distinctId: ws.people.maya!.userId,
      timestamp: new Date("2026-11-11T10:00:30.000Z"),
      properties: {
        outcome: "completed",
        duration_ms: 30_000,
        tool_calls: 7,
        models: ["claude-haiku-5-5"],
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 5_000,
        cache_write_tokens: 10,
        cost_usd: 0.012,
      },
    });
    // The second report is the same events, which PostHog keeps once.
    expect(finished).toHaveLength(2);
    expect(finished[1]!.uuid).toBe(finished[0]!.uuid);
    expect(started[0]!.uuid).not.toBe(finished[0]!.uuid);
  });

  test("an event of another canvas names nobody: the sandbox cannot say whose a turn is", async () => {
    const { runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const other = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const elsewhere = await appendEvent(t.db, {
      canvasId: other.canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Go" },
      userId: ws.people.ines!.userId,
    });
    await call(t, runner.headers, "POST", "/v1/runner/usage", {
      turns: [
        {
          id: "3f1c2a9e-0000-4000-8000-000000000002",
          claudeSessionId: "sess_1",
          at: "2026-11-11T10:00:30.000Z",
          models: [],
          turn: {
            startedAt: "2026-11-11T10:00:00.000Z",
            outcome: "failed",
            errorCode: "claude_limit",
            durationMs: 30_000,
            toolCalls: 0,
            eventId: elsewhere.id,
          },
        },
      ],
    });
    await t.backgroundDone();
    const [finished] = t.analytics.of("turn finished");
    expect(finished!.distinctId).not.toBe(ws.people.ines!.userId);
    expect(finished!.properties).toMatchObject({ outcome: "failed", error_code: "claude_limit" });
  });
});

describe("error tracking", () => {
  const failing = () =>
    createApp(t.deps).route(
      "/v1/test",
      new Hono<AppEnv>().get("/crash/:id", access.user, () => {
        throw new Error("connect ECONNREFUSED password=hunter2");
      }),
    );

  test("a 500 goes to error tracking with its route as declared, its person and its request id", async () => {
    const response = await failing().request("/v1/test/crash/cnv_123?token=abc", {
      headers: maya(),
    });
    expect(response.status).toBe(500);
    const [exception] = t.analytics.exceptions;
    expect(exception).toMatchObject({
      distinctId: ws.people.maya!.userId,
      properties: {
        route: "GET /v1/test/crash/:id",
        request_id: response.headers.get("x-request-id"),
        status: 500,
        error_code: "internal",
        $session_id: SESSION,
      },
    });
    expect(exception!.error.message).not.toContain("hunter2");
    expect(JSON.stringify(exception!.properties)).not.toContain("token=abc");
  });

  test("a refusal is the API working, and is not an exception", async () => {
    await call(t, {}, "GET", "/v1/me");
    await call(t, maya(), "GET", "/v1/canvases/cnv_nothere");
    expect(t.analytics.exceptions).toEqual([]);
  });
});

test("the app may send its PostHog session to the API from the studio", async () => {
  const response = await t.app.request("/v1/me", {
    method: "OPTIONS",
    headers: {
      origin: "ponzu-studio://app",
      "access-control-request-method": "GET",
      "access-control-request-headers": `${SESSION_HEADER},${DISTINCT_ID_HEADER}`,
    },
  });
  const allowed = response.headers.get("access-control-allow-headers") ?? "";
  expect(allowed).toContain(SESSION_HEADER);
  expect(allowed).toContain(DISTINCT_ID_HEADER);
});
