import { describe, expect, test } from "bun:test";
import type { Api } from "../api.ts";
import { ApiError, networkError } from "../errors.ts";
import { FakeClock } from "../testing/clock.ts";
import { type FakeQuery, FakeRealtime, fakeSeal } from "../testing/realtime.ts";
import { createLive, type LiveSnapshot } from "./live.ts";
import type { RealtimeTransport } from "./realtime.ts";
import type { RawRow } from "./rows.ts";

type LiveAnswer = Awaited<ReturnType<Api["live"]>>;

const head = (seq: number): Partial<RawRow<"canvas.head">> => ({
  id: "cnv_1",
  name: "Kettle",
  seq: String(seq),
  agent_state: "idle",
  agent_artboards: [],
  last_activity_at: "2026-11-10T12:00:00.000Z",
});

/**
 * `createLive` over an API whose `POST /v1/live` is played here, and a Realtime in memory with
 * the clock the seals expire by. `refuse` decides, per query name, what the API says instead
 * of sealing it.
 */
function harness() {
  const clock = new FakeClock();
  const tables: Record<string, unknown[]> = {
    "canvas.head": [head(1)],
    "canvas.thread": [],
    "workspace.canvases": [],
  };
  const realtime = new FakeRealtime((query: FakeQuery) => tables[query.name] ?? [], clock);
  const calls: string[][] = [];
  const refuse: Record<string, string | undefined> = {};
  let online = true;
  const api = {
    async live(queries: { name: string; args?: unknown }[]): Promise<LiveAnswer> {
      calls.push(queries.map((q) => q.name));
      if (!online) throw networkError(new Error("offline"));
      // As the API does: too many in one call, or one it cannot read, and the call is refused.
      const unreadable = queries.some((q) => (q.args as { canvasId?: string }).canvasId === "bad");
      if (queries.length > 32 || unreadable) {
        throw new ApiError(400, "invalid_request", "That is not what this route takes.");
      }
      return {
        url: realtime.url,
        results: queries.map(({ name, args }) => {
          const code = refuse[name];
          if (code) return { name, error: { code, message: `Refused: ${code}.` } };
          const query = { name, args: (args ?? {}) as Record<string, unknown>, userId: "usr_1" };
          return { name, sealed: fakeSeal(query, clock.now()) };
        }),
      };
    },
  };
  const live = createLive({ api, transport: realtime, clock });
  const watch = <Name extends "canvas.head" | "canvas.thread">(name: Name) => {
    const seen: LiveSnapshot<unknown>[] = [];
    const off = live.subscribe(name, { canvasId: "cnv_1" }, (snapshot) => seen.push(snapshot));
    return { seen, off, last: () => seen.at(-1) };
  };
  return {
    clock,
    tables,
    realtime,
    calls,
    refuse,
    live,
    watch,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("sealing and renewing", () => {
  test("queries asked for together are sealed in one call, and delivered decoded", async () => {
    const h = harness();
    const headWatch = h.watch("canvas.head");
    h.watch("canvas.thread");
    h.live.subscribe("workspace.canvases", { workspaceId: "ws_1" }, () => {});
    await h.clock.advance(0);

    expect(h.calls).toEqual([["canvas.head", "canvas.thread", "workspace.canvases"]]);
    const snapshot = headWatch.last() as LiveSnapshot<{ seq: number; name: string }>;
    expect(snapshot.status).toBe("live");
    // A bigint arrives as text; the row says it as a number.
    expect(snapshot.rows?.map((row) => [row.name, row.seq])).toEqual([["Kettle", 1]]);
  });

  test("every subscription is renewed in one call every 50 seconds, and none goes stale", async () => {
    const h = harness();
    const a = h.watch("canvas.head");
    const b = h.watch("canvas.thread");
    await h.clock.advance(0);
    await h.clock.advance(10 * 60_000);

    expect(h.calls).toHaveLength(13);
    expect(h.calls.slice(1).every((names) => names.length === 2)).toBe(true);
    expect(h.realtime.open().map((sub) => sub.renewals)).toEqual([12, 12]);
    for (const watch of [a, b]) {
      expect(watch.seen.map((s) => s.status)).not.toContain("offline");
    }
  });

  test("a query asked for later brings forward a renewal that was nearly due", async () => {
    const h = harness();
    h.watch("canvas.head");
    await h.clock.advance(40_000);
    h.watch("canvas.thread");
    await h.clock.advance(60_000);

    // The head, due at 50 s, rode along with the thread at 40 s; from then on they renew as one.
    expect(h.calls).toEqual([
      ["canvas.head"],
      ["canvas.head", "canvas.thread"],
      ["canvas.head", "canvas.thread"],
    ]);
  });

  test("the same query watched twice is one subscription, and lives until the last lets go", async () => {
    const h = harness();
    const first = h.watch("canvas.head");
    const second = h.watch("canvas.head");
    await h.clock.advance(0);
    expect(h.realtime.open()).toHaveLength(1);
    expect(h.live.snapshot("canvas.head", { canvasId: "cnv_1" }) as unknown).toBe(second.last());

    first.off();
    expect(h.realtime.open()).toHaveLength(1);
    second.off();
    expect(h.realtime.open()).toHaveLength(0);
    await h.clock.advance(5 * 60_000);
    expect(h.calls).toHaveLength(1);
  });

  test("more queries than one call takes are sealed in as many calls, at the same time", async () => {
    const h = harness();
    const seen = new Map<string, LiveSnapshot<unknown>>();
    for (let i = 0; i < 33; i++) {
      const canvasId = `cnv_${i}`;
      h.live.subscribe("canvas.head", { canvasId }, (snapshot) => seen.set(canvasId, snapshot));
    }
    await h.clock.advance(0);
    expect(h.calls.map((names) => names.length)).toEqual([32, 1]);
    expect([...seen.values()].filter((s) => s.status === "live")).toHaveLength(33);

    await h.clock.advance(50_000);
    expect(h.calls.map((names) => names.length)).toEqual([32, 1, 32, 1]);
  });

  test("a call refused whole is halved until the query at fault ends alone", async () => {
    const h = harness();
    const seen = new Map<string, LiveSnapshot<unknown>>();
    for (const canvasId of ["cnv_1", "cnv_2", "bad", "cnv_3"]) {
      h.live.subscribe("canvas.head", { canvasId }, (snapshot) => seen.set(canvasId, snapshot));
    }
    await h.clock.advance(0);

    expect(h.calls.map((names) => names.length)).toEqual([4, 2, 2, 1, 1]);
    expect(seen.get("bad")?.status).toBe("ended");
    expect(seen.get("bad")?.error?.code).toBe("invalid_request");
    for (const id of ["cnv_1", "cnv_2", "cnv_3"]) expect(seen.get(id)?.status).toBe("live");
    // From then on the rest renew together, without it.
    await h.clock.advance(50_000);
    expect(h.calls.at(-1)).toHaveLength(3);
  });

  test("joining a query already answered hears where it stands, ended or live", async () => {
    const h = harness();
    h.refuse["canvas.thread"] = "forbidden";
    h.watch("canvas.head");
    h.watch("canvas.thread");
    await h.clock.advance(0);

    const head = h.watch("canvas.head");
    const thread = h.watch("canvas.thread");
    // Not before `subscribe` has returned, so the caller has its way to let go first.
    expect([head.seen, thread.seen]).toEqual([[], []]);
    await Promise.resolve();
    expect(head.seen.map((s) => s.status)).toEqual(["live"]);
    expect(thread.seen.map((s) => [s.status, s.error?.code])).toEqual([["ended", "forbidden"]]);

    const gone = h.watch("canvas.head");
    gone.off();
    await Promise.resolve();
    expect(gone.seen).toEqual([]);
  });

  test("a snapshot is the same object until something changes", async () => {
    const h = harness();
    h.watch("canvas.head");
    await h.clock.advance(0);
    const before = h.live.snapshot("canvas.head", { canvasId: "cnv_1" });
    await h.clock.advance(50_000);
    expect(h.live.snapshot("canvas.head", { canvasId: "cnv_1" })).toBe(before);

    h.tables["canvas.head"] = [head(2)];
    h.realtime.refresh();
    const after = h.live.snapshot("canvas.head", { canvasId: "cnv_1" }) as LiveSnapshot<{
      seq: number;
    }>;
    expect(after).not.toBe(before);
    expect(after.rows?.[0]?.seq).toBe(2);
  });
});

describe("one query failing", () => {
  test("no access ends that query alone, and it is not asked for again", async () => {
    const h = harness();
    h.refuse["canvas.thread"] = "not_found";
    const thread = h.watch("canvas.thread");
    const headWatch = h.watch("canvas.head");
    await h.clock.advance(0);
    await h.clock.advance(3 * 60_000);

    const ended = thread.last()!;
    expect(ended.status).toBe("ended");
    expect(ended.error).toBeInstanceOf(ApiError);
    expect([ended.error?.status, ended.error?.code]).toEqual([404, "not_found"]);
    expect(headWatch.last()?.status).toBe("live");
    expect(h.calls.slice(1).every((names) => names.join() === "canvas.head")).toBe(true);
  });

  test("a query the API could not seal for now is tried again alone, sooner and sooner no more", async () => {
    const h = harness();
    h.refuse["canvas.thread"] = "upstream_unavailable";
    const thread = h.watch("canvas.thread");
    h.watch("canvas.head");
    await h.clock.advance(0);
    expect(thread.seen).toEqual([]);

    // Retried after 1 s, then 2 s, alone: the head is not renewed early for it.
    await h.clock.advance(1_000);
    await h.clock.advance(2_000);
    expect(h.calls).toEqual([
      ["canvas.thread", "canvas.head"],
      ["canvas.thread"],
      ["canvas.thread"],
    ]);
    h.refuse["canvas.thread"] = undefined;
    await h.clock.advance(4_000);
    expect(thread.last()?.status).toBe("live");
  });

  test("a subscription that errors is made again, and brings its whole result", async () => {
    const h = harness();
    const watch = h.watch("canvas.head");
    await h.clock.advance(0);
    const [broken] = h.realtime.open();

    h.tables["canvas.head"] = [head(5)];
    h.realtime.fail("canvas.head");
    expect(watch.last()?.status).toBe("offline");
    await h.clock.advance(1_000);

    const [fresh] = h.realtime.open();
    expect(fresh).not.toBe(broken);
    expect(broken!.closed).toBe(true);
    const last = watch.last() as LiveSnapshot<{ seq: number }>;
    expect([last.status, last.rows?.[0]?.seq]).toEqual(["live", 5]);
  });
});

describe("offline and in the background", () => {
  test("the API out of reach: rows stay, seals run out, and coming back renews with a fresh result", async () => {
    const h = harness();
    const watch = h.watch("canvas.head");
    await h.clock.advance(0);
    h.setOnline(false);
    h.realtime.disconnect();
    h.tables["canvas.head"] = [head(9)];
    await h.clock.advance(3 * 60_000);

    const offline = watch.last() as LiveSnapshot<{ seq: number }>;
    expect([offline.status, offline.rows?.[0]?.seq]).toEqual(["offline", 1]);
    // Each try waited longer than the last.
    expect(h.calls.length).toBeLessThan(10);

    h.setOnline(true);
    h.realtime.reconnect();
    await h.clock.advance(60_000);
    const back = watch.last() as LiveSnapshot<{ seq: number }>;
    expect([back.status, back.rows?.[0]?.seq]).toEqual(["live", 9]);
  });

  test("paused, nothing is held open or renewed; resumed, each query starts again whole", async () => {
    const h = harness();
    const watch = h.watch("canvas.head");
    await h.clock.advance(0);

    h.live.pause();
    expect(h.realtime.open()).toHaveLength(0);
    expect(watch.last()?.status).toBe("offline");
    h.tables["canvas.head"] = [head(3)];
    await h.clock.advance(10 * 60_000);
    expect(h.calls).toHaveLength(1);

    h.live.resume();
    await h.clock.advance(0);
    expect(h.calls).toHaveLength(2);
    const back = watch.last() as LiveSnapshot<{ seq: number }>;
    expect([back.status, back.rows?.[0]?.seq]).toEqual(["live", 3]);
  });
});

test("a transport that answers before subscribe returns is heard", async () => {
  const clock = new FakeClock();
  const transport: RealtimeTransport = {
    subscribe(_url, _sealed, listener) {
      listener.rows([head(4)]);
      listener.status("live");
      return { renew: async () => {}, close() {} };
    },
    close() {},
  };
  const api = {
    live: async (queries: { name: string }[]): Promise<LiveAnswer> => ({
      url: "wss://realtime.test",
      results: queries.map(({ name }) => ({
        name,
        sealed: fakeSeal({ name, args: {}, userId: "usr_1" }, clock.now()),
      })),
    }),
  };
  const live = createLive({ api, transport, clock });
  live.subscribe("canvas.head", { canvasId: "cnv_1" }, () => {});
  await clock.advance(0);
  const snapshot = live.snapshot("canvas.head", { canvasId: "cnv_1" });
  expect([snapshot.status, snapshot.rows?.[0]?.seq]).toEqual(["live", 4]);
});
