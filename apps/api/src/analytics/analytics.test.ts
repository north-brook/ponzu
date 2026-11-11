import { expect, test } from "bun:test";
import { createLogger, type LogLine } from "../http/log.ts";
import { MemoryAnalytics } from "../testing/fake-analytics.ts";
import { createAnalytics, noAnalytics, scrubbed, stableUuid } from "./analytics.ts";
import { type AnalyticsScope, noteWorkspace, withScope } from "./scope.ts";

function analytics(sink = new MemoryAnalytics(), flushMs?: number) {
  const kept: Promise<void>[] = [];
  const lines: LogLine[] = [];
  const tracked = createAnalytics({
    sink,
    keep: (work) => kept.push(work),
    log: createLogger((line) => lines.push(line)),
    ...(flushMs === undefined ? {} : { flushMs }),
  });
  return { tracked, sink, kept, lines };
}

const request = (over: Partial<AnalyticsScope> = {}): AnalyticsScope => ({
  userId: () => "usr_ada",
  designId: () => null,
  sessionId: "0192e0a0-0000-7000-8000-000000000001",
  requestId: "req_1",
  route: () => "POST /v1/designs/:id/messages",
  workspaceId: null,
  ...over,
});

test("inside a request, a capture is the person's, in the workspace they reached, in their app session", () => {
  const { tracked, sink } = analytics();
  withScope(request(), () => {
    noteWorkspace("ws_1");
    // The first workspace is the request's: one read on the way does not move it.
    noteWorkspace("ws_other");
    tracked.capture("turn stopped", { design_id: "des_1" });
  });
  expect(sink.events).toEqual([
    {
      event: "turn stopped",
      distinctId: "usr_ada",
      properties: {
        design_id: "des_1",
        workspace_id: "ws_1",
        $session_id: "0192e0a0-0000-7000-8000-000000000001",
      },
      groups: { workspace: "ws_1" },
    },
  ]);
});

test("an event about no one is kept off every profile, keyed by its workspace or its design", () => {
  const { tracked, sink } = analytics();
  tracked.capture(
    "sandbox restored",
    { design_id: "des_1", kind: "rebuilt" },
    { distinctId: null, workspaceId: "ws_1" },
  );
  tracked.capture("sandbox restored", { design_id: "des_2", kind: "rebuilt" });
  expect(sink.events.map((e) => [e.distinctId, e.properties.$process_person_profile])).toEqual([
    ["ws_1", false],
    ["des_2", false],
  ]);
});

test("a fact reported again carries the same id and time, which PostHog keeps once", () => {
  const { tracked, sink } = analytics();
  const at = new Date("2026-11-11T10:00:00Z");
  for (let i = 0; i < 2; i++) {
    tracked.capture(
      "turn started",
      { design_id: "des_1", turn_id: "res-1" },
      { distinctId: "usr_ada", timestamp: at, uuid: stableUuid("res-1/started") },
    );
  }
  expect(sink.events[0]).toEqual(sink.events[1]!);
  expect(sink.events[0]!.uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(stableUuid("res-1/finished")).not.toBe(stableUuid("res-1/started"));
});

test("everything captured in one turn of the event loop is sent once, kept alive by `keep`", async () => {
  const { tracked, sink, kept } = analytics();
  tracked.capture("user signed out", {});
  tracked.capture("user signed out", {});
  expect(kept).toHaveLength(1);
  await Promise.all(kept);
  expect(sink.flushes).toBe(1);
  tracked.capture("user signed out", {});
  expect(kept).toHaveLength(2);
});

test("a sink that throws costs a log line, never the request", () => {
  const sink = new MemoryAnalytics();
  sink.capture = () => {
    throw new Error("queue full");
  };
  const { tracked, lines } = analytics(sink);
  expect(() => tracked.capture("user signed out", {})).not.toThrow();
  expect(lines.map((l) => l.event)).toEqual(["analytics_failed"]);
});

test("a send that hangs is given up after its time, and one that fails is logged", async () => {
  const hanging = new MemoryAnalytics();
  hanging.flush = () => new Promise<void>(() => {});
  const slow = analytics(hanging, 20);
  slow.tracked.capture("user signed out", {});
  await Promise.all(slow.kept);

  const failing = new MemoryAnalytics();
  failing.flush = () => Promise.reject(new Error("PostHog is down"));
  const down = analytics(failing);
  down.tracked.capture("user signed out", {});
  await Promise.all(down.kept);
  expect(down.lines.map((l) => l.event)).toEqual(["analytics_flush_failed"]);
});

test("an exception carries the request's route, id, person, workspace and session, and no secret", () => {
  const { tracked, sink } = analytics();
  withScope(request({ workspaceId: "ws_1" }), () =>
    tracked.exception(
      new Error("GitHub said Bearer ghs_abcdefghijklmnopqrstuvwxyz for postgres://u:hunter2@db"),
      { status: 500 },
    ),
  );
  const [{ error, distinctId, properties }] = sink.exceptions as [(typeof sink.exceptions)[number]];
  expect(distinctId).toBe("usr_ada");
  expect(properties).toMatchObject({
    status: 500,
    route: "POST /v1/designs/:id/messages",
    request_id: "req_1",
    workspace_id: "ws_1",
    $session_id: "0192e0a0-0000-7000-8000-000000000001",
    $groups: { workspace: "ws_1" },
  });
  expect(error.message).not.toContain("ghs_");
  expect(error.message).not.toContain("hunter2");
  expect(error.stack ?? "").not.toContain("hunter2");
});

test("what is thrown that is not an Error is still an Error, and causes are scrubbed too", () => {
  expect(scrubbed("plain").message).toBe("plain");
  const nested = scrubbed(new Error("outer", { cause: new Error("token=abc123") }));
  expect((nested.cause as Error).message).toBe("token=[redacted]");
});

test("with no key, analytics is a no-op that loads no tracing", async () => {
  expect(() => noAnalytics.capture("user signed out", {})).not.toThrow();
  expect(noAnalytics.ai).toBeNull();
  await noAnalytics.flush();
});
