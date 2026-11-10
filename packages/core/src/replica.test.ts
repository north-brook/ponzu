import { describe, expect, test } from "bun:test";
import { type Doc, locate, type Op, OpError } from "./doc.ts";
import { el, sampleDoc, text } from "./fixtures/ops.ts";
import { Sequencer, wire } from "./fixtures/sequencer.ts";
import { MAX_NODES } from "./limits.ts";
import { type DroppedOp, type OpInfo, Replica, type Scheduler } from "./replica.ts";
import {
  type ClientOp,
  CommitRefusedError,
  MAX_COMMIT_BYTES,
  MAX_COMMIT_OPS,
  type SyncTransport,
} from "./sync.ts";
import type { Actor } from "./types.ts";
import { InvalidOpError } from "./validate.ts";

const ada: Actor = { kind: "user", id: "user_ada", name: "Ada" };
const bo: Actor = { kind: "user", id: "user_bo", name: "Bo" };

/** Let every promise that can settle, settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Request {
  kind: "commit" | "fetchOps" | "fetchDoc";
  /** The ops of a commit, or the seq a fetch asked after. */
  sent: unknown;
  serve: () => unknown;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/** A transport to a sequencer where each request waits until the test answers it. */
class Line implements SyncTransport {
  waiting: Request[] = [];
  /** Every request made, by kind, in order. */
  asked: Request["kind"][] = [];
  /** The largest body the API takes, in bytes, as a host in front of it would enforce. */
  maxBody = Number.POSITIVE_INFINITY;

  constructor(
    private api: Sequencer,
    private actor: Actor,
  ) {}

  commit(ops: ClientOp[]) {
    return this.ask<ReturnType<Sequencer["commit"]>>("commit", ops, () => {
      if (JSON.stringify({ ops }).length > this.maxBody)
        throw new CommitRefusedError("The post is too large.");
      try {
        return this.api.commit(ops, this.actor);
      } catch (err) {
        // A post that isn't one: the API answers 400, and that never changes.
        if (err instanceof InvalidOpError) throw new CommitRefusedError(err.message);
        throw err;
      }
    });
  }

  fetchOps(after: number) {
    return this.ask<ReturnType<Sequencer["opsAfter"]>>("fetchOps", after, () =>
      this.api.opsAfter(after),
    );
  }

  fetchDoc() {
    return this.ask<ReturnType<Sequencer["snapshot"]>>("fetchDoc", null, () => this.api.snapshot());
  }

  /**
   * Answer the oldest request. Lost as a "request", it never reaches the API; lost as a
   * "response", the API handles it and the answer never comes back.
   */
  async answer(lost?: "request" | "response"): Promise<void> {
    const request = this.waiting.shift();
    if (!request) throw new Error("No request is waiting.");
    if (lost === "request") request.reject(new Error("The request was lost."));
    else {
      try {
        const value = request.serve();
        if (lost) request.reject(new Error("The response was lost."));
        else request.resolve(value);
      } catch (err) {
        request.reject(err as Error);
      }
    }
    await tick();
  }

  async drain(): Promise<void> {
    while (this.waiting.length) await this.answer();
  }

  private ask<T>(kind: Request["kind"], sent: unknown, serve: () => T): Promise<T> {
    this.asked.push(kind);
    return new Promise((resolve, reject) => {
      this.waiting.push({ kind, sent, serve, resolve, reject });
    });
  }
}

/** A scheduler that only moves when the test says so. */
class Timers {
  waits: { run: () => void; ms: number }[] = [];

  schedule: Scheduler = (run, ms) => {
    const wait = { run, ms };
    this.waits.push(wait);
    return () => {
      this.waits = this.waits.filter((w) => w !== wait);
    };
  };

  async fire(): Promise<void> {
    const wait = this.waits.shift();
    if (!wait) throw new Error("Nothing is scheduled.");
    wait.run();
    await tick();
  }
}

function setup(doc: Doc = sampleDoc()) {
  const api = new Sequencer(doc);
  const timers = new Timers();
  const open = (actor: Actor) => {
    const line = new Line(api, actor);
    let made = 0;
    const replica = new Replica({
      transport: line,
      schedule: timers.schedule,
      actor,
      ...api.snapshot(),
      newId: () => `${actor.name.toLowerCase()}-${++made}`,
    });
    const heard: { op: Op; by: string }[] = [];
    /** Which op each of `heard` was, in the same order. */
    const infos: OpInfo[] = [];
    replica.onOp((op, by, doc, info) => {
      expect(doc).toBe(replica.doc);
      heard.push({ op, by: by.name });
      infos.push(info);
    });
    const dropped: DroppedOp[] = [];
    replica.onDrop((d) => dropped.push(d));
    /** Commit an op as this person and let it through, without the others hearing of it. */
    const commit = async (op: Op) => {
      replica.apply(op);
      await line.drain();
    };
    return { replica, line, heard, infos, dropped, commit };
  };
  return { api, timers, open };
}

/** The replica shows exactly what the API has, to the last key. */
function expectInSync(replica: Replica, api: Sequencer): void {
  expect(replica.pending).toEqual([]);
  expect(replica.seq).toBe(api.seq);
  expect(JSON.stringify(replica.doc)).toBe(JSON.stringify(api.doc));
}

const red: Op = { op: "style", id: "n_1", style: { color: "red" } };
const say = (id: string, words: string): Op => ({
  op: "thread.message",
  id: "th_1",
  message: { id, author: { kind: "user", name: "Someone else" }, text: words, createdAt: 1 },
});

describe("editing", () => {
  test("an edit shows at once, is posted, and is confirmed without being heard twice", async () => {
    const { api, open } = setup();
    const a = open(ada);
    let changes = 0;
    a.replica.subscribe(() => changes++);

    const applied = a.replica.apply(red);
    expect(applied).toEqual({ id: "ada-1", inverse: { op: "style", id: "n_1", style: {} } });
    expect(locate(a.replica.doc, "n_1")!.node.style).toEqual({ color: "red" });
    expect(a.replica.pending).toEqual([{ id: "ada-1", op: red }]);
    expect(a.replica.seq).toBe(0);
    expect(a.heard).toEqual([{ op: red, by: "Ada" }]);
    expect(a.infos).toEqual([{ id: "ada-1", echo: false }]);
    expect(changes).toBe(1);
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([
      ["commit", [{ id: "ada-1", op: red }]],
    ]);

    await a.line.answer();
    expectInSync(a.replica, api);
    expect(a.replica.seq).toBe(1);
    expect(a.heard).toHaveLength(1);
    expect(changes).toBe(2);
    expect(a.line.waiting).toEqual([]);
  });

  test("an op that doesn't fit throws as applyOp does, and leaves nothing behind", () => {
    const { open } = setup();
    const a = open(ada);
    const before = JSON.stringify(a.replica.doc);
    expect(() => a.replica.apply({ op: "remove", id: "n_missing" })).toThrow(OpError);
    expect(() =>
      a.replica.apply({ op: "batch", ops: [red, { op: "remove", id: "n_missing" }] }),
    ).toThrow(OpError);
    expect(JSON.stringify(a.replica.doc)).toBe(before);
    expect(a.replica.pending).toEqual([]);
    expect(a.heard).toEqual([]);
    expect(a.line.asked).toEqual([]);
  });

  test("an op the API would refuse on sight throws as validateOp does, and leaves nothing behind", () => {
    const { open } = setup();
    const a = open(ada);
    const before = JSON.stringify(a.replica.doc);
    // Each fits the document, so applyOp alone would have shown it and queued it.
    const refused: Op[] = [
      { op: "page.create", index: 0, page: { id: "not an id", name: "Bad" } },
      { op: "note", name: "design.system", content: "x" },
      { op: "file.rename", name: "a\u0000b" },
      {
        op: "children",
        id: "n_1",
        children: Array.from({ length: MAX_NODES + 1 }, () => text("x")),
      },
    ];
    for (const op of refused) expect(() => a.replica.apply(op)).toThrow(InvalidOpError);
    expect(JSON.stringify(a.replica.doc)).toBe(before);
    expect(a.replica.pending).toEqual([]);
    expect(a.heard).toEqual([]);
    expect(a.line.asked).toEqual([]);
  });

  test("pending is a copy: changing it changes nothing here", () => {
    const { open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    const pending = a.replica.pending;
    expect(pending).toEqual([{ id: "ada-1", op: red }]);
    pending.length = 0;
    expect(a.replica.pending).toEqual([{ id: "ada-1", op: red }]);
  });

  test("pending ops go out in order, one batch in flight", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const ops: Op[] = [1, 2, 3].map((n) => ({ op: "file.rename", name: `Name ${n}` }));
    for (const op of ops) a.replica.apply(op);
    const sent = () => a.line.waiting.map((r) => (r.sent as ClientOp[]).map((c) => c.id));
    expect(sent()).toEqual([["ada-1"]]);
    await a.line.answer();
    expect(sent()).toEqual([["ada-2", "ada-3"]]);
    expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-2", "ada-3"]);
    await a.line.answer();
    expect(sent()).toEqual([]);
    expectInSync(a.replica, api);
    expect(api.log.map((c) => c.id)).toEqual(["ada-1", "ada-2", "ada-3"]);
    expect(api.doc.name).toBe("Name 3");
  });

  test("a long queue goes out a post's worth at a time", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const count = MAX_COMMIT_OPS + 6;
    for (let n = 1; n <= count; n++) a.replica.apply({ op: "file.rename", name: `Name ${n}` });
    const sizes: number[] = [];
    while (a.line.waiting.length) {
      sizes.push((a.line.waiting[0]!.sent as ClientOp[]).length);
      await a.line.answer();
    }
    expect(sizes).toEqual([1, MAX_COMMIT_OPS, 5]);
    expectInSync(a.replica, api);
    expect(api.seq).toBe(count);
  });

  test("a queue of large ops goes out in posts the API's host will take", async () => {
    const { api, open } = setup();
    const a = open(ada);
    // What a Vercel function accepts. Forty ops of 150 KB in one post would be 6 MB.
    a.line.maxBody = 4.5 * 1024 * 1024;
    const filler = "x".repeat(150 * 1024);
    for (let n = 1; n <= 40; n++)
      a.replica.apply({ op: "children", id: "n_3", children: [text(`${n} ${filler}`)] });
    const posts: { ops: number; bytes: number }[] = [];
    while (a.line.waiting.length) {
      const sent = a.line.waiting[0]!.sent as ClientOp[];
      posts.push({ ops: sent.length, bytes: JSON.stringify(sent).length });
      await a.line.answer();
    }
    expect(posts.map((p) => p.ops)).toEqual([1, 20, 19]);
    for (const post of posts) expect(post.bytes).toBeLessThanOrEqual(MAX_COMMIT_BYTES);
    expectInSync(a.replica, api);
    expect(api.seq).toBe(40);
    expect(a.replica.offline).toBe(false);
    expect(a.dropped).toEqual([]);
  });

  test("a post is measured in bytes, not characters", async () => {
    const { api, open } = setup();
    const a = open(ada);
    // Three bytes a character: 600 KB an op, so five to a post where characters would say fifteen.
    const filler = "漢".repeat(200 * 1024);
    for (let n = 1; n <= 11; n++)
      a.replica.apply({ op: "children", id: "n_3", children: [text(`${n} ${filler}`)] });
    const sizes: number[] = [];
    while (a.line.waiting.length) {
      sizes.push((a.line.waiting[0]!.sent as ClientOp[]).length);
      await a.line.answer();
    }
    expect(sizes).toEqual([1, 5, 5]);
    expectInSync(a.replica, api);
  });
});

describe("a post the API refuses whole", () => {
  test("is sent again one op at a time, and the op refused alone is dropped and reported", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    a.line.maxBody = 1000;
    const small = (n: number): Op => ({ op: "file.rename", name: `Name ${n}` });
    const large: Op = { op: "children", id: "n_3", children: [text("x".repeat(2000))] };
    a.replica.apply(small(1));
    a.replica.apply(large);
    a.replica.apply(small(2));
    a.replica.apply(small(3));
    expect(locate(a.replica.doc, "n_3")!.node.children).toEqual(large.children);

    const posts: string[][] = [];
    while (a.line.waiting.length) {
      posts.push((a.line.waiting[0]!.sent as ClientOp[]).map((c) => c.id));
      await a.line.answer();
    }
    // The three together are refused, then the large one alone; after that, posts fill up again.
    expect(posts).toEqual([
      ["ada-1"],
      ["ada-2", "ada-3", "ada-4"],
      ["ada-2"],
      ["ada-3"],
      ["ada-4"],
    ]);
    expect(a.dropped).toEqual([
      { id: "ada-2", op: large, cause: "rejected", reason: "The post is too large." },
    ]);
    expectInSync(a.replica, api);
    expect(api.log.map((c) => c.id)).toEqual(["ada-1", "ada-3", "ada-4"]);
    expect(locate(a.replica.doc, "n_3")!.node.children).toEqual([text("World")]);
    // The API answered every time, so there was nothing to wait out.
    expect(a.replica.offline).toBe(false);
    expect(timers.waits).toEqual([]);
  });

  test("two ops under one id, which no post may carry, don't wedge the queue", async () => {
    const { api, timers } = setup();
    const line = new Line(api, ada);
    // A fault in whatever makes the ids. The API takes the first op under an id as that op.
    const ids = ["first", "same", "same", "last"];
    const replica = new Replica({
      transport: line,
      schedule: timers.schedule,
      actor: ada,
      ...api.snapshot(),
      newId: () => ids.shift()!,
    });
    replica.apply({ op: "file.rename", name: "Name 1" });
    replica.apply({ op: "file.rename", name: "Name 2" });
    replica.apply({ op: "file.icon", icon: "star" });
    replica.apply(red);
    await line.drain();
    expectInSync(replica, api);
    expect(api.log.map((c) => c.id)).toEqual(["first", "same", "last"]);
    expect(line.asked).toEqual(["commit", "commit", "commit", "commit"]);
    expect(timers.waits).toEqual([]);
  });

  test("an op confirmed while its post was being refused is not dropped", async () => {
    const { api, open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    // The API commits it and the answer is lost; the retry is refused; the op arrives as committed.
    await a.line.answer("response");
    a.replica.notify(0);
    a.line.maxBody = 0;
    a.replica.ingest(api.log);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.dropped).toEqual([]);
    expect(a.heard).toEqual([{ op: red, by: "Ada" }]);
  });
});

describe("other people's ops", () => {
  test("land under the pending ones, and are heard once", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    a.replica.apply(red);
    await b.commit({ op: "name", id: "n_1", name: "Card" });

    // Bo's op was committed first, while Ada's is still on its way.
    a.replica.ingest(api.log);
    expect(a.replica.seq).toBe(1);
    expect(locate(a.replica.doc, "n_1")!.node).toMatchObject({
      name: "Card",
      style: { color: "red" },
    });
    expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-1"]);

    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.heard).toEqual([
      { op: red, by: "Ada" },
      { op: { op: "name", id: "n_1", name: "Card" }, by: "Bo" },
    ]);
    expect(a.infos).toEqual([
      { id: "ada-1", echo: false },
      { id: "bo-1", seq: 1, echo: false },
    ]);
  });

  test("arrive through notify, however late, repeated or out of order the calls are", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });

    a.replica.notify(3);
    a.replica.notify(1);
    a.replica.notify(3);
    a.replica.notify(2);
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([["fetchOps", 0]]);
    await a.line.answer();
    expectInSync(a.replica, api);
    expect(a.heard.map((h) => h.by)).toEqual(["Bo", "Bo", "Bo"]);

    // Old news, and the same ops again, change nothing and ask nothing.
    a.replica.notify(2);
    a.replica.notify(3);
    a.replica.ingest(api.log);
    a.replica.ingest([api.log[1]!]);
    await tick();
    expect(a.line.asked).toEqual(["fetchOps"]);
    expect(a.heard).toHaveLength(3);
  });

  test("word of a head the API doesn't have is asked about once, then forgotten", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    const b = open(bo);
    // Word of another design's head, or of this one before it was reset: nothing is at 5.
    a.replica.notify(5);
    await a.line.drain();
    for (let turn = 0; turn < 20; turn++) await tick();
    expect(a.line.asked).toEqual(["fetchOps"]);
    expect(timers.waits).toEqual([]);
    expect(a.replica.offline).toBe(false);
    expectInSync(a.replica, api);

    // Hearing it again asks again, once. And true word still gets through.
    a.replica.notify(5);
    await a.line.drain();
    expect(a.line.asked).toEqual(["fetchOps", "fetchOps"]);
    await b.commit(red);
    a.replica.notify(1);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["fetchOps", "fetchOps", "fetchOps"]);
  });

  test("with ops to post as well, a head the API doesn't have still isn't asked about twice", async () => {
    const { api, open } = setup();
    const a = open(ada);
    a.replica.notify(5);
    a.replica.apply(red);
    a.replica.apply({ op: "file.rename", name: "Renamed" });
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["fetchOps", "commit"]);
  });

  test("an answer from before the head moved doesn't unsay word that came while asking", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    await b.commit({ op: "file.rename", name: "Name 1" });
    a.replica.notify(1);
    // The API reads the design a moment before Bo's first op lands in it...
    a.line.waiting[0]!.serve = () => ({ ops: [], seq: 0 });
    // ...and while its answer is on the way, Bo commits again and Ada hears of it.
    await b.commit({ op: "file.rename", name: "Name 2" });
    a.replica.notify(2);
    await a.line.answer();
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([["fetchOps", 0]]);
    await a.line.drain();
    expectInSync(a.replica, api);
  });

  test("ops past a hole wait for the fetch that fills it", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });

    a.replica.ingest([api.log[2]!, api.log[0]!]);
    expect(a.replica.seq).toBe(1);
    expect(a.replica.doc.name).toBe("Name 1");
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([["fetchOps", 1]]);
    await a.line.answer();
    expectInSync(a.replica, api);
    expect(a.heard).toHaveLength(3);
  });

  test("a post answered with a hole before it is not posted again", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    a.replica.apply(red);
    // Bo gets in first, and nobody has told Ada.
    await b.commit({ op: "file.rename", name: "Bo's" });
    await a.line.answer();
    // The answer says Ada's op is seq 2. She has to hear seq 1 before she can use it.
    expect(a.replica.seq).toBe(0);
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([["fetchOps", 0]]);
    await a.line.answer();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["commit", "fetchOps"]);
    expect(a.heard.map((h) => h.by)).toEqual(["Ada", "Bo"]);
  });
});

describe("what the API changes or refuses", () => {
  test("the committed op replaces what was sent, and is heard again", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const node = {
      ...el("n_new", "button", [text("Go")]),
      attrs: { onclick: "steal()", class: "x" },
    };
    const insert: Op = { op: "insert", parent: "n_1", index: 0, nodes: [node] };
    a.replica.apply(insert);
    a.replica.apply(say("m_9", "Looks good"));
    a.replica.apply(red);
    expect(locate(a.replica.doc, "n_new")!.node.attrs).toEqual({ onclick: "steal()", class: "x" });
    expect(a.replica.doc.threads[0]!.messages[1]!.author.name).toBe("Someone else");

    await a.line.drain();
    expectInSync(a.replica, api);
    // Sanitized and stamped by the API, and that is what the document holds.
    expect(locate(a.replica.doc, "n_new")!.node.attrs).toEqual({ class: "x" });
    expect(a.replica.doc.threads[0]!.messages[1]).toEqual({
      id: "m_9",
      author: { kind: "user", name: "Ada", id: "user_ada" },
      text: "Looks good",
      createdAt: Date.parse(api.log[1]!.at),
    });
    // Heard as made, then again as committed where the two differ. The style never changed.
    expect(a.heard.map((h) => h.op)).toEqual([
      insert,
      say("m_9", "Looks good"),
      red,
      api.log[0]!.op,
      api.log[1]!.op,
    ]);
    expect(api.log[0]!.op).not.toEqual(insert);
    // The second hearing says which op it is, and that it has been heard before: a listener
    // that counts comments counts this one once.
    expect(a.infos).toEqual([
      { id: "ada-1", echo: false },
      { id: "ada-2", echo: false },
      { id: "ada-3", echo: false },
      { id: "ada-1", seq: 1, echo: true },
      { id: "ada-2", seq: 2, echo: true },
    ]);
  });

  test("a rejected op is taken back out and reported", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    // Bo removes the paragraph, and nobody has told Ada: her op fits here and not at the API.
    await b.commit({ op: "remove", id: "n_2" });
    const rename: Op = { op: "name", id: "n_2", name: "Greeting" };
    const { id } = a.replica.apply(rename);
    a.replica.apply(red);
    expect(locate(a.replica.doc, "n_2")!.node.name).toBe("Greeting");

    await a.line.drain();
    expectInSync(a.replica, api);
    expect(locate(a.replica.doc, "n_2")).toBeNull();
    expect(locate(a.replica.doc, "n_1")!.node.style).toEqual({ color: "red" });
    expect(a.dropped).toEqual([
      { id, op: rename, cause: "rejected", reason: expect.stringContaining("n_2") },
    ]);
    expect(api.log.map((c) => c.id)).toEqual(["bo-1", "ada-2"]);
  });

  test("an op undone by a committed one is dropped and reported; one in flight waits for the API", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    const restyle: Op = { op: "style", id: "n_2", style: { color: "blue" } };
    const rename: Op = { op: "name", id: "n_2", name: "Greeting" };
    a.replica.apply(restyle);
    a.replica.apply(rename);
    expect(a.line.waiting.map((r) => (r.sent as ClientOp[]).map((c) => c.id))).toEqual([["ada-1"]]);
    await b.commit({ op: "remove", id: "n_2" });

    a.replica.ingest(api.log);
    expect(locate(a.replica.doc, "n_2")).toBeNull();
    // The rename never left: it's gone for good. The restyle did, so the API decides.
    expect(a.dropped).toEqual([
      { id: "ada-2", op: rename, cause: "conflict", reason: expect.stringContaining("n_2") },
    ]);
    expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-1"]);

    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.dropped.map((d) => [d.id, d.cause])).toEqual([
      ["ada-2", "conflict"],
      ["ada-1", "rejected"],
    ]);
    expect(api.log.map((c) => c.id)).toEqual(["bo-1"]);
  });

  test("an op that stopped fitting here is still taken if the API commits it", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    const restyle: Op = { op: "style", id: "n_2", style: { color: "blue" } };
    // Ada's restyle reaches the API, but its answer is lost.
    a.replica.apply(restyle);
    await a.line.answer("response");
    // Then Bo removes the node, and Ada hears of that first.
    await b.commit({ op: "remove", id: "n_2" });
    a.replica.ingest([api.log[1]!]);
    expect(a.replica.seq).toBe(0);
    a.replica.notify(2);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.dropped).toEqual([]);
    expect(api.log.map((c) => c.id)).toEqual(["ada-1", "bo-1"]);
  });
});

describe("a failing connection", () => {
  test("a post that failed is tried again with the same ids, and nothing is committed twice", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    a.replica.apply(say("m_9", "Once"));
    // The API commits it, and the answer is lost on the way back.
    await a.line.answer("response");
    expect(api.seq).toBe(1);
    expect(a.replica.offline).toBe(true);
    expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-1"]);
    expect(a.line.waiting).toEqual([]);
    expect(timers.waits.map((w) => w.ms)).toEqual([500]);

    // A second op made meanwhile rides along on the retry.
    a.replica.apply(red);
    await timers.fire();
    expect(a.line.waiting.map((r) => (r.sent as ClientOp[]).map((c) => c.id))).toEqual([
      ["ada-1", "ada-2"],
    ]);
    await a.line.answer();
    expect(a.replica.offline).toBe(false);
    expectInSync(a.replica, api);
    expect(api.log.map((c) => c.id)).toEqual(["ada-1", "ada-2"]);
    expect(a.replica.doc.threads[0]!.messages.map((m) => m.text)).toEqual(["Tighter?", "Once"]);
  });

  test("waits longer after each failure, and starts over after a success", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await a.line.answer("request");
      waits.push(timers.waits[0]!.ms);
      await timers.fire();
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(api.seq).toBe(0);
    await a.line.answer();
    expectInSync(a.replica, api);

    a.replica.apply({ op: "file.rename", name: "Again" });
    await a.line.answer("request");
    expect(timers.waits.map((w) => w.ms)).toEqual([500]);
  });

  test("word from the API cuts a wait short", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    await a.line.answer("request");
    expect(timers.waits).toHaveLength(1);
    a.replica.notify(0);
    expect(timers.waits).toEqual([]);
    await a.line.drain();
    expectInSync(a.replica, api);
  });

  test("a failed fetch is tried again", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    const b = open(bo);
    await b.commit(red);
    a.replica.notify(1);
    await a.line.answer("request");
    expect(a.replica.offline).toBe(true);
    await timers.fire();
    await a.line.answer();
    expect(a.replica.offline).toBe(false);
    expectInSync(a.replica, api);
  });

  test("an answer that leaves an op out is no answer, and the waits grow as for any failure", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    for (const wait of [500, 1000, 2000]) {
      a.line.waiting[0]!.serve = () => ({ committed: [], rejected: [], seq: 0 });
      await a.line.answer();
      expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-1"]);
      expect(a.replica.offline).toBe(true);
      expect(timers.waits.map((w) => w.ms)).toEqual([wait]);
      await timers.fire();
    }
    await a.line.answer();
    expectInSync(a.replica, api);
    expect(a.replica.offline).toBe(false);
  });

  test("a closed replica asks nothing more and takes no more answers", async () => {
    const { timers, open } = setup();
    const a = open(ada);
    a.replica.apply(red);
    a.replica.close();
    await a.line.answer();
    expect(a.replica.pending.map((p) => p.id)).toEqual(["ada-1"]);
    a.replica.notify(5);
    a.replica.apply({ op: "file.rename", name: "Later" });
    await tick();
    expect(a.line.asked).toEqual(["commit"]);
    expect(timers.waits).toEqual([]);
  });
});

describe("fetching the whole design", () => {
  test("when the ops are gone, the document is fetched whole and pending ops go back on top", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });
    await b.commit({ op: "remove", id: "n_3" });
    api.forget();

    a.replica.notify(4);
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchOps"]);
    // Made while the fetch is out: one that will still fit, one that won't.
    const gone: Op = { op: "name", id: "n_3", name: "Footer" };
    a.replica.apply(red);
    a.replica.apply(gone);

    await a.line.answer();
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchDoc"]);
    await a.line.answer();
    expect(a.replica.seq).toBe(4);
    expect(a.replica.doc.name).toBe("Name 3");
    expect(locate(a.replica.doc, "n_1")!.node.style).toEqual({ color: "red" });
    expect(a.dropped).toEqual([
      { id: "ada-2", op: gone, cause: "conflict", reason: expect.stringContaining("n_3") },
    ]);

    await a.line.drain();
    expectInSync(a.replica, api);
    // Ops that came inside the fetched document aren't heard one by one.
    expect(a.heard.map((h) => h.by)).toEqual(["Ada", "Ada"]);
    expect(a.line.asked).toEqual(["fetchOps", "fetchDoc", "commit"]);
  });

  test("an op of ours that was inside the fetched document isn't applied twice", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    await b.commit({ op: "file.rename", name: "Bo's" });
    a.replica.apply(say("m_9", "Once"));
    // The API commits Ada's message after Bo's rename, then lets go of its ops.
    a.line.waiting[0]!.serve = ((serve) => () => {
      const result = serve();
      api.forget();
      return result;
    })(a.line.waiting[0]!.serve);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["commit", "fetchOps", "fetchDoc", "commit"]);
    expect(a.replica.doc.threads[0]!.messages.map((m) => m.text)).toEqual(["Tighter?", "Once"]);
    expect(api.log.map((c) => c.id)).toEqual(["bo-1", "ada-1"]);
    expect(a.dropped).toEqual([]);
  });

  test("fetched ops with a hole in them, or none when there should be some, mean a whole fetch", async () => {
    for (const answer of [
      (api: Sequencer) => ({ ops: [api.log[0]!, api.log[2]!], seq: 3 }),
      (api: Sequencer) => ({ ops: [api.log[1]!, api.log[2]!], seq: 3 }),
      () => ({ ops: [], seq: 3 }),
    ]) {
      const { api, open } = setup();
      const a = open(ada);
      const b = open(bo);
      for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });
      a.replica.notify(3);
      a.line.waiting[0]!.serve = () => wire(answer(api));
      await a.line.answer();
      expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchDoc"]);
      await a.line.drain();
      expectInSync(a.replica, api);
    }
  });

  test("a committed op that doesn't apply here means this document is wrong: fetch it whole", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    await b.commit(red);
    const impossible = { ...api.log[0]!, op: { op: "remove", id: "n_nowhere" } as Op };
    a.replica.ingest([impossible]);
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchDoc"]);
    await a.line.drain();
    expectInSync(a.replica, api);
  });

  test("ops fetched a page at a time are followed to the end", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });
    a.replica.notify(1);
    a.line.waiting[0]!.serve = () => wire({ ops: [api.log[0]!], seq: 3 });
    await a.line.answer();
    expect(a.line.waiting.map((r) => [r.kind, r.sent])).toEqual([["fetchOps", 1]]);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["fetchOps", "fetchOps"]);
  });

  test("an API whose answers don't add up is asked again later, not in a loop", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    api.opsAfter = () => "gone";
    a.replica.notify(7);
    await a.line.answer();
    await a.line.answer();
    // Fetched whole, and still told the ops after it are gone.
    await a.line.answer();
    expect(a.line.asked).toEqual(["fetchOps", "fetchDoc", "fetchOps"]);
    expect(a.line.waiting).toEqual([]);
    expect(timers.waits.map((w) => w.ms)).toEqual([500]);
    await timers.fire();
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchDoc"]);
    // Round after round gets it nowhere, so each wait is longer than the last.
    for (const wait of [1000, 2000, 4000]) {
      await a.line.answer();
      await a.line.answer();
      expect(a.line.waiting).toEqual([]);
      expect(timers.waits.map((w) => w.ms)).toEqual([wait]);
      await timers.fire();
    }
  });

  test("a whole document older than the one here is not taken", async () => {
    const { api, timers, open } = setup();
    const a = open(ada);
    const b = open(bo);
    await b.commit({ op: "file.rename", name: "Name 1" });
    const stale = api.snapshot();
    for (const n of [2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });
    a.replica.notify(3);
    await a.line.drain();
    expectInSync(a.replica, api);

    // Something sends Ada for the whole document, and a cache answers with an old one.
    a.replica.ingest([{ ...api.log[0]!, seq: 4, op: { op: "remove", id: "n_nowhere" } }]);
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchDoc"]);
    a.line.waiting[0]!.serve = () => stale;
    await a.line.answer();
    expect(a.replica.seq).toBe(3);
    expect(a.replica.doc.name).toBe("Name 3");
    expect(a.replica.offline).toBe(true);
    expect(a.line.waiting).toEqual([]);
    expect(timers.waits.map((w) => w.ms)).toEqual([500]);

    await timers.fire();
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.replica.offline).toBe(false);
    expect(timers.waits).toEqual([]);
  });

  test("Replica.open starts from the design as the API has it", async () => {
    const { api, timers, open } = setup();
    await open(bo).commit(red);
    const line = new Line(api, ada);
    const opening = Replica.open({ transport: line, schedule: timers.schedule, actor: ada });
    await line.answer();
    const replica = await opening;
    expectInSync(replica, api);
    expect(replica.seq).toBe(1);
  });
});

describe("taking turns", () => {
  test("with ops to post and ops to fetch, neither waits for the other to run dry", async () => {
    const { api, open } = setup();
    const a = open(ada);
    const b = open(bo);
    for (const n of [1, 2, 3]) await b.commit({ op: "file.rename", name: `Name ${n}` });

    // Behind, with something to post: the fetch goes first.
    a.replica.notify(3);
    a.replica.apply(red);
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["fetchOps"]);
    // The fetch comes back a page short, so Ada is still behind. Her post goes all the same.
    a.line.waiting[0]!.serve = () => wire({ ops: [api.log[0]!], seq: 3 });
    await a.line.answer();
    expect(a.line.waiting.map((r) => r.kind)).toEqual(["commit"]);
    await a.line.drain();
    expectInSync(a.replica, api);
    expect(a.line.asked).toEqual(["fetchOps", "commit", "fetchOps"]);
  });
});
