import { expect, test } from "bun:test";
import { createLogger, type LogLine } from "../http/log.ts";
import { MemoryAnalytics } from "../testing/fake-analytics.ts";
import {
  cachedOptOuts,
  createAnalytics,
  HELD_MAX,
  noAnalytics,
  scrubbed,
  stableUuid,
  withoutOptedOut,
} from "./analytics.ts";
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
  canvasId: () => null,
  sessionId: "0192e0a0-0000-7000-8000-000000000001",
  requestId: "req_1",
  route: () => "POST /v1/canvases/:id/messages",
  workspaceId: null,
  ...over,
});

test("inside a request, a capture is the person's, in the workspace they reached, in their app session", () => {
  const { tracked, sink } = analytics();
  withScope(request(), () => {
    noteWorkspace("ws_1");
    // The first workspace is the request's: one read on the way does not move it.
    noteWorkspace("ws_other");
    tracked.capture("turn stopped", { canvas_id: "cnv_1" });
  });
  expect(sink.events).toEqual([
    {
      event: "turn stopped",
      distinctId: "usr_ada",
      properties: {
        canvas_id: "cnv_1",
        workspace_id: "ws_1",
        $session_id: "0192e0a0-0000-7000-8000-000000000001",
      },
      groups: { workspace: "ws_1" },
    },
  ]);
});

test("an event about no one is kept off every profile, keyed by its workspace or its canvas", () => {
  const { tracked, sink } = analytics();
  tracked.capture(
    "sandbox restored",
    { canvas_id: "cnv_1", kind: "rebuilt" },
    { distinctId: null, workspaceId: "ws_1" },
  );
  tracked.capture("sandbox restored", { canvas_id: "cnv_2", kind: "rebuilt" });
  expect(sink.events.map((e) => [e.distinctId, e.properties.$process_person_profile])).toEqual([
    ["ws_1", false],
    ["cnv_2", false],
  ]);
});

test("a fact reported again carries the same id and time, which PostHog keeps once", () => {
  const { tracked, sink } = analytics();
  const at = new Date("2026-11-11T10:00:00Z");
  for (let i = 0; i < 2; i++) {
    tracked.capture(
      "turn started",
      { canvas_id: "cnv_1", turn_id: "res-1" },
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
    route: "POST /v1/canvases/:id/messages",
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
  expect(() => noAnalytics.sharingChanged()).not.toThrow();
});

/* Share usage data. */

/** Opt-outs from a list a test changes, on a clock it moves, counting each read. */
function optOutsOf(ids: string[], ttlMs?: number) {
  let clock = 0;
  const reads: number[] = [];
  let failing = false;
  const optOuts = cachedOptOuts(
    async () => {
      reads.push(clock);
      if (failing) throw new Error("database down");
      return [...ids];
    },
    () => clock,
    ttlMs,
  );
  return {
    optOuts,
    ids,
    reads,
    advance: (ms: number) => {
      clock += ms;
    },
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

function sharing(ids: string[], ttlMs?: number) {
  const o = optOutsOf(ids, ttlMs);
  const sink = new MemoryAnalytics();
  const kept: Promise<void>[] = [];
  const lines: LogLine[] = [];
  const tracked = createAnalytics({
    sink,
    keep: (work) => kept.push(work),
    log: createLogger((line) => lines.push(line)),
    optOuts: o.optOuts,
  });
  const sent = async () => {
    while (kept.length) await kept.shift();
  };
  return { ...o, tracked, sink, lines, sent };
}

const ADA = { userId: "usr_ada", name: "Ada", email: "ada@example.com", githubLogin: "ada" };
const person = (userId: string) => ({ ...ADA, userId, signedUpAt: new Date(0) });

test("the sink drops an opted-out person's captures, profile and errors, and keeps everyone else's", async () => {
  const s = sharing(["usr_off"]);
  for (const who of ["usr_off", "usr_on"]) {
    s.tracked.capture("user signed out", {}, { distinctId: who });
    s.tracked.identify(person(who));
    withScope(request({ userId: () => who }), () => s.tracked.exception(new Error("boom")));
  }
  // Nothing was read on the way: until a send has read who is out, everything waits.
  expect(s.sink.events).toEqual([]);
  expect(s.reads).toEqual([]);

  await s.sent();
  expect(s.reads).toHaveLength(1);
  expect(s.sink.events.map((e) => e.distinctId)).toEqual(["usr_on"]);
  expect(s.sink.people.map((p) => p.distinctId)).toEqual(["usr_on"]);
  expect(s.sink.exceptions.map((e) => e.distinctId)).toEqual(["usr_on"]);
  expect(JSON.stringify([s.sink.events, s.sink.people, s.sink.exceptions])).not.toContain(
    "usr_off",
  );
});

test("events about no person, workspace groups and person-less errors are never held or dropped", async () => {
  const s = sharing(["usr_off"]);
  s.tracked.capture(
    "sandbox restored",
    { canvas_id: "cnv_1", kind: "rebuilt" },
    {
      distinctId: null,
      workspaceId: "ws_1",
    },
  );
  s.tracked.group({
    workspaceId: "ws_1",
    name: "north-brook",
    kind: "organization",
    repos: 1,
    repositorySelection: "all",
  });
  s.tracked.exception(new Error("no one's"));
  // Before any read, and with nothing to read for them.
  expect(s.sink.events).toHaveLength(1);
  expect(s.sink.groups).toHaveLength(1);
  expect(s.sink.exceptions).toHaveLength(1);
});

test("a held capture keeps the time it was made; one checked against a fresh copy goes at once", async () => {
  const s = sharing([]);
  const before = Date.now();
  s.tracked.capture("user signed out", {}, { distinctId: "usr_on" });
  await s.sent();
  expect(s.sink.events[0]!.timestamp!.getTime()).toBeGreaterThanOrEqual(before);

  // The copy is fresh now: the next capture is checked against it and goes as it is made.
  s.tracked.capture("user signed out", {}, { distinctId: "usr_on" });
  expect(s.sink.events).toHaveLength(2);
  expect(s.sink.events[1]!.timestamp).toBeUndefined();
  expect(s.reads).toHaveLength(1);
});

test("who is out is read at most once a minute per instance, and at once after a switch here", async () => {
  const s = sharing([]);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  await s.sent();
  expect(s.reads).toEqual([0]);

  // Ada turns it off on another instance: this one learns within the minute, not before.
  s.ids.push("usr_ada");
  s.advance(59_999);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  await s.sent();
  expect(s.sink.events).toHaveLength(2);
  s.advance(1);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  await s.sent();
  expect(s.reads).toEqual([0, 60_000]);
  expect(s.sink.events).toHaveLength(2);

  // Turned on again through this instance: the next capture waits for the read after it.
  s.ids.length = 0;
  s.tracked.sharingChanged();
  s.tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  expect(s.sink.events).toHaveLength(2);
  await s.sent();
  expect(s.reads).toEqual([0, 60_000, 60_000]);
  expect(s.sink.events).toHaveLength(3);
});

test("a read that fails falls back on the last copy, and with none, holds everything for later", async () => {
  const s = sharing(["usr_off"], 0);
  s.fail(true);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_on" });
  await s.sent();
  // No copy yet: nothing goes, nothing is lost.
  expect(s.sink.events).toEqual([]);
  expect(s.lines.map((l) => l.event)).toEqual(["analytics_opt_outs_unread"]);

  s.fail(false);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_off" });
  await s.sent();
  expect(s.sink.events.map((e) => e.distinctId)).toEqual(["usr_on"]);

  // Every copy is stale at once here (a zero lifetime): the failed read leaves the last one.
  s.fail(true);
  s.tracked.capture("user signed out", {}, { distinctId: "usr_off" });
  s.tracked.capture("user signed out", {}, { distinctId: "usr_on" });
  await s.sent();
  expect(s.sink.events.map((e) => e.distinctId)).toEqual(["usr_on", "usr_on"]);
});

test("at most HELD_MAX captures wait for a read, the oldest dropped first", async () => {
  const s = sharing([]);
  for (let i = 0; i < HELD_MAX + 5; i++) {
    s.tracked.capture("user signed out", {}, { distinctId: `usr_${i}` });
  }
  await s.sent();
  expect(s.sink.events).toHaveLength(HELD_MAX);
  expect(s.sink.events[0]!.distinctId).toBe("usr_5");
});

test("captures that sends under way are deciding count toward HELD_MAX too", async () => {
  // One read, held open, that every send shares while it is out.
  let answer: ((ids: string[]) => void) | null = null;
  const optOuts = cachedOptOuts(
    () =>
      new Promise<string[]>((resolve) => {
        answer = resolve;
      }),
    () => 0,
  );
  const memory = new MemoryAnalytics();
  const sink = withoutOptedOut(memory, optOuts);
  const sends: Promise<void>[] = [];
  sink.capture({ event: "user signed out", distinctId: "usr_first", properties: {} });
  sends.push(sink.flush());
  // Each capture is taken by its own send while the read is slow.
  for (let i = 0; i < HELD_MAX + 5; i++) {
    sink.capture({ event: "user signed out", distinctId: `usr_${i}`, properties: {} });
    sends.push(sink.flush());
  }
  for (let turn = 0; turn < 1_000 && !answer; turn++) await Promise.resolve();
  answer!([]);
  await Promise.all(sends);
  expect(memory.events).toHaveLength(HELD_MAX);
  expect(memory.events[0]!.distinctId).toBe("usr_5");
});

test("a read that began before a switch here is not trusted for what comes after it", async () => {
  // The read the send starts is held open until the test lets it answer, with what it saw then.
  const answers: ((ids: string[]) => void)[] = [];
  const optOuts = cachedOptOuts(
    () => new Promise<string[]>((resolve) => answers.push(resolve)),
    () => 0,
  );
  const sink = new MemoryAnalytics();
  const kept: Promise<void>[] = [];
  const tracked = createAnalytics({
    sink,
    keep: (work) => kept.push(work),
    log: createLogger(() => {}),
    optOuts,
  });
  // Lets queued work run until `count` reads have begun, or a bounded number of turns pass.
  const readsBegun = async (count: number) => {
    for (let turn = 0; turn < 1_000 && answers.length < count; turn++) await Promise.resolve();
    expect(answers).toHaveLength(count);
  };
  tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  await readsBegun(1);

  // Ada turns sharing off through this instance while that read is still out.
  tracked.sharingChanged();
  expect(optOuts.known()).toBeNull();
  tracked.capture("user signed out", {}, { distinctId: "usr_ada" });
  answers[0]!([]);
  await readsBegun(2);
  answers[1]!(["usr_ada"]);
  while (kept.length) await kept.shift();

  // The read from before the switch decided only what came before it; the one after it decided
  // what came after.
  expect(answers).toHaveLength(2);
  expect(sink.events).toHaveLength(1);
  expect(optOuts.fresh()).toEqual(new Set(["usr_ada"]));
  expect(optOuts.known()).toEqual(new Set(["usr_ada"]));
});

test("two sends at once read who is out once", async () => {
  const o = optOutsOf([]);
  const [a, b] = await Promise.all([o.optOuts.current(), o.optOuts.current()]);
  expect(a).toBe(b);
  expect(o.reads).toHaveLength(1);
  expect(o.optOuts.known()).toBe(a);
});
