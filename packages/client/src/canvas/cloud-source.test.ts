import { describe, expect, test } from "bun:test";
import type { CanvasSource, CanvasState } from "@ponzu/canvas";
import { type Actor, type Doc, type Op, parseArtboardFile } from "@ponzu/core";
import { DocCache } from "../doc-cache.ts";
import type { KeyValueStorage } from "../session.ts";
import { createFakeBackend, type FakePerson } from "../testing/backend.ts";
import { FakeClock } from "../testing/clock.ts";
import { CloudSource, type Unsaved } from "./cloud-source.ts";

const actorOf = (person: FakePerson): Actor => ({
  kind: "user",
  id: person.id,
  name: person.name ?? person.githubLogin,
});

const board = (id: string, x = 0) => {
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="${id}" data-name="Home" style="width:400px;height:300px"><p>Hi</p></section>`,
    { id, name: "Home" },
  );
  return { ...artboard, x };
};

class MemoryStorage implements KeyValueStorage {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

/**
 * A design with one board, which Maya and Ines can both edit, Omar can only read, and the
 * agent works on; `open` gives each of them a CloudSource on it, as their app would.
 */
async function harness() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ines = backend.addPerson({ login: "ines", name: "Ines" });
  const omar = backend.addPerson({ login: "omar", name: "Omar" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin", [ines.id]: "member", [omar.id]: "member" },
    repos: [{ name: "site", access: { [omar.id]: "read" } }],
  });
  const mayaClient = backend.connect(maya);
  const design = await mayaClient.api.designs.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Kettle",
  });
  const page = backend.design(design.id).sequencer.doc.pages[0]!.id;
  backend
    .agent(design.id)
    .commit([{ op: "artboard.create", page, index: 0, artboard: board("ab_home") }]);

  const open = (person: FakePerson, opts: { cache?: DocCache } = {}) => {
    const client = person === maya ? mayaClient : backend.connect(person);
    const source = new CloudSource({
      api: client.api,
      live: client.live,
      designId: design.id,
      me: actorOf(person),
      clock,
      ...opts,
    });
    const ops: { op: Op; who: string; doc: Doc; before: Doc | null }[] = [];
    source.onOp?.((op, origin, doc) =>
      ops.push({ op, who: origin.name, doc, before: source.getState().doc }),
    );
    const unsaved: Unsaved[] = [];
    source.onUnsaved((u) => unsaved.push(u));
    const states: CanvasState[] = [];
    source.subscribe((state) => states.push(state));
    return { source, ops, unsaved, states, client };
  };
  const doc = (source: CloudSource) => source.getState().doc!;
  const home = (source: CloudSource) =>
    doc(source).pages[0]!.artboards.find((a) => a.id === "ab_home");
  /** Let the API answer, Realtime deliver and the replicas fetch what it told them of. */
  const settle = () => clock.advance(0);
  return { clock, backend, design, page, maya, ines, omar, open, doc, home, settle };
}

describe("opening", () => {
  test("a design opens ready, with its assets and live DOM for every board", async () => {
    const h = await harness();
    const { source } = h.open(h.maya);
    expect(source.getState().status).toBe("connecting");
    await h.settle();

    const state = source.getState();
    expect([state.status, state.path, state.doc?.name]).toEqual(["ready", "Kettle", "Kettle"]);
    expect(h.home(source)?.name).toBe("Home");
    expect(source.writable).toBe(true);
    expect(source.assetBase).toBe(`https://assets.test/${h.design.id}/`);
    expect(source.renditions).toBe(false);
    const canvas: CanvasSource = source;
    expect(canvas.snapshotUrl).toBeUndefined();
    expect(canvas.loopsUrl).toBeUndefined();
  });

  test("a design the person may only look at refuses every edit up front", async () => {
    const h = await harness();
    const omar = h.open(h.omar);
    await h.settle();
    expect(omar.source.writable).toBe(false);

    const before = h.backend.design(h.design.id).sequencer.seq;
    omar.source.apply({ op: "artboard.update", id: "ab_home", x: 500 });
    omar.source.undo();
    await h.settle();
    expect(h.home(omar.source)?.x).toBe(0);
    expect(omar.unsaved.map((u) => u.reason)).toEqual([
      "This design can only be looked at right now.",
    ]);
    expect(h.backend.design(h.design.id).sequencer.seq).toBe(before);
  });

  test("a design that is not there, or not theirs, is an error, not a spinner", async () => {
    const h = await harness();
    const stranger = h.backend.addPerson({ login: "stranger" });
    const { source } = h.open(stranger);
    await h.settle();
    expect(source.getState().status).toBe("error");
    expect(source.getState().error).toBe("There is no such design.");
  });

  test("opened after something else already watches the design's head, it still hears it", async () => {
    const h = await harness();
    h.backend.agent(h.design.id).work(["ab_home"], "Drawing Home");
    const client = h.backend.connect(h.ines);
    // The app's header, watching the same query before the canvas opens.
    client.live.subscribe("design.head", { designId: h.design.id }, () => {});
    await h.settle();

    const source = new CloudSource({
      api: client.api,
      live: client.live,
      designId: h.design.id,
      me: actorOf(h.ines),
      clock: h.clock,
    });
    await h.settle();
    expect(source.getState().presence.map((p) => p.name)).toEqual(["Claude"]);
  });

  test("a design deleted while open stops at the API's first no, and what waited is unsaved", async () => {
    const h = await harness();
    const client = h.backend.connect(h.ines);
    const asked: string[] = [];
    const designs = new Proxy(client.api.designs, {
      get(target, key) {
        const method = Reflect.get(target, key) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          asked.push(String(key));
          return method.apply(target, args);
        };
      },
    });
    const source = new CloudSource({
      api: { designs },
      live: client.live,
      designId: h.design.id,
      me: actorOf(h.ines),
      clock: h.clock,
    });
    const unsaved: Unsaved[] = [];
    source.onUnsaved((u) => unsaved.push(u));
    await h.settle();
    await h.backend.connect(h.maya).api.designs.delete(h.design.id);

    source.apply({ op: "artboard.update", id: "ab_home", x: 70 });
    await h.settle();
    expect(source.getState()).toMatchObject({ status: "error", error: "There is no such design." });
    expect(source.writable).toBe(false);
    expect(unsaved.map((u) => u.op)).toEqual([{ op: "artboard.update", id: "ab_home", x: 70 }]);

    // Nothing more is asked of the API for it: no retries, and no presence kept up.
    asked.length = 0;
    source.setPage(h.page);
    await h.clock.advance(5 * 60_000);
    expect(asked).toEqual([]);
  });

  test("presence is said on opening, every 30 seconds after, and taken back on closing", async () => {
    const h = await harness();
    const { source } = h.open(h.maya);
    const ines = h.open(h.ines);
    await h.settle();
    source.setPage(h.page);
    await h.settle();
    const present = () => h.backend.design(h.design.id).presence;
    expect(present().get(h.maya.id)?.pageId).toBe(h.page);

    const seen = present().get(h.maya.id)!.seenAt;
    await h.clock.advance(30_000);
    expect(present().get(h.maya.id)!.seenAt > seen).toBe(true);
    // Ines sees Maya, and not herself.
    expect(ines.source.getState().presence.map((p) => p.name)).toEqual(["Maya"]);

    source.close();
    await h.settle();
    expect(present().has(h.maya.id)).toBe(false);
    expect(ines.source.getState().presence).toEqual([]);
  });
});

describe("editing as the canvas expects", () => {
  test("a dragged board stays where it was dropped: at once, and once the API has it", async () => {
    const h = await harness();
    const { source, ops } = h.open(h.maya);
    await h.settle();

    source.apply({ op: "artboard.update", id: "ab_home", x: 640, y: 80 });
    // Synchronously: the canvas draws the next frame from this.
    expect(h.home(source)).toMatchObject({ x: 640, y: 80 });
    const states: number[] = [];
    source.subscribe((state) => states.push(state.doc!.pages[0]!.artboards[0]!.x));
    await h.settle();

    expect(h.home(source)).toMatchObject({ x: 640, y: 80 });
    expect(states.every((x) => x === 640)).toBe(true);
    expect(h.backend.design(h.design.id).sequencer.doc.pages[0]!.artboards[0]!.x).toBe(640);
    // Heard once, as Maya's: her own edit is not animated as someone else's arriving.
    expect(ops.map((o) => [o.op.op, o.who])).toEqual([["artboard.update", "Maya"]]);
  });

  test("a sent comment stays on screen while the API stamps it, and is heard once", async () => {
    const h = await harness();
    const { source, ops } = h.open(h.maya);
    await h.settle();
    const me = { kind: "user" as const, id: h.maya.id, name: "Maya" };
    source.apply({
      op: "thread.create",
      thread: {
        id: "th_aaaaaaaaaa",
        artboardId: "ab_home",
        x: 10,
        y: 10,
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        messages: [{ id: "m_aaaaaaaaaa", author: me, text: "Bigger?", createdAt: 1 }],
      },
    });
    const shown: number[] = [source.getState().doc!.threads.length];
    source.subscribe((state) => shown.push(state.doc!.threads.length));
    await h.settle();

    expect(shown.every((n) => n === 1)).toBe(true);
    const [thread] = source.getState().doc!.threads;
    // The API's clock, not the one the canvas wrote.
    expect(thread!.createdAt).not.toBe(1);
    expect(thread!.messages[0]!.author).toMatchObject({ id: h.maya.id });
    expect(ops.filter((o) => o.op.op === "thread.create")).toHaveLength(1);
  });

  test("two people and the agent converge, and each remote op is heard once, by its maker", async () => {
    const h = await harness();
    const maya = h.open(h.maya);
    const ines = h.open(h.ines);
    await h.settle();

    maya.source.apply({ op: "artboard.update", id: "ab_home", x: 100 });
    ines.source.apply({ op: "artboard.update", id: "ab_home", y: 200 });
    h.backend
      .agent(h.design.id)
      .commit([
        { op: "artboard.create", page: h.page, index: 1, artboard: board("ab_price", 900) },
      ]);
    await h.clock.advance(1_000);

    const server = h.backend.design(h.design.id).sequencer.doc;
    expect(maya.source.getState().doc).toEqual(server);
    expect(ines.source.getState().doc).toEqual(server);
    expect(h.home(maya.source)).toMatchObject({ x: 100, y: 200 });

    // Each op once on each canvas, under who made it: the person's own first, as they made it.
    const heard = (ops: typeof maya.ops) => ops.map((o) => `${o.who}:${o.op.op}`);
    const everyone = ["Claude:artboard.create", "Ines:artboard.update", "Maya:artboard.update"];
    expect(heard(maya.ops)[0]).toBe("Maya:artboard.update");
    expect(heard(maya.ops).sort()).toEqual(everyone);
    expect(heard(ines.ops)[0]).toBe("Ines:artboard.update");
    expect(heard(ines.ops).sort()).toEqual(everyone);
    // The agent's board reaches the canvas with the document it arrives in, to animate.
    const arrival = maya.ops.find((o) => o.who === "Claude")!;
    expect(arrival.doc.pages[0]!.artboards.map((a) => a.id)).toContain("ab_price");
    // While it hears the op, the canvas still shows the document from before it (arrive.ts
    // compares the two), untouched by the replica changing its own in place.
    expect(arrival.before!.pages[0]!.artboards.map((a) => a.id)).not.toContain("ab_price");
  });

  test("an edit the API rejects is taken back, and said so", async () => {
    const h = await harness();
    const maya = h.open(h.maya);
    const ines = h.open(h.ines);
    await h.settle();

    // Ines deletes the board while Maya, not having heard yet, renames it.
    h.backend.online = false;
    ines.source.apply({ op: "artboard.delete", id: "ab_home" });
    maya.source.apply({ op: "artboard.update", id: "ab_home", name: "Landing" });
    expect(h.home(maya.source)?.name).toBe("Landing");
    h.backend.online = true;
    ines.source.retryNow();
    await h.settle();
    maya.source.retryNow();
    await h.clock.advance(1_000);

    expect(h.home(maya.source)).toBeUndefined();
    expect(maya.unsaved).toHaveLength(1);
    expect(maya.unsaved[0]!.op).toEqual({ op: "artboard.update", id: "ab_home", name: "Landing" });
  });

  test("undo waits for the edits before it, then takes back the newest through the API", async () => {
    const h = await harness();
    const { source } = h.open(h.maya);
    await h.settle();

    source.apply({ op: "artboard.update", id: "ab_home", x: 10 });
    source.apply({ op: "artboard.update", id: "ab_home", x: 20 });
    source.undo();
    await h.clock.advance(1_000);
    expect(h.home(source)?.x).toBe(10);
    expect(h.backend.design(h.design.id).sequencer.doc.pages[0]!.artboards[0]!.x).toBe(10);

    source.redo();
    await h.clock.advance(1_000);
    expect(h.home(source)?.x).toBe(20);

    // Nothing more to redo: quietly nothing.
    source.redo();
    await h.clock.advance(1_000);
    expect(h.home(source)?.x).toBe(20);
  });

  test("the agent at work shows as presence on the boards it is on", async () => {
    const h = await harness();
    const { source } = h.open(h.maya);
    await h.settle();
    h.backend.agent(h.design.id).work(["ab_home"], "Drawing Home");
    await h.settle();
    expect(source.getState().presence).toEqual([
      expect.objectContaining({
        kind: "agent",
        name: "Claude",
        working: ["ab_home"],
        status: "Drawing Home",
      }),
    ]);
    h.backend.agent(h.design.id).idle();
    await h.settle();
    expect(source.getState().presence).toEqual([]);
  });
});

describe("offline", () => {
  test("the last copy shows, read only, until the API answers; then it is live again", async () => {
    const h = await harness();
    const cache = new DocCache(new MemoryStorage());
    const first = h.open(h.maya, { cache });
    await h.settle();
    first.source.apply({ op: "artboard.update", id: "ab_home", x: 333 });
    await h.clock.advance(5_000);
    first.source.close();
    await h.settle();

    h.backend.online = false;
    const again = h.open(h.maya, { cache });
    await h.settle();
    expect(again.source.getState().status).toBe("offline");
    expect(h.home(again.source)?.x).toBe(333);
    expect(again.source.writable).toBe(false);
    again.source.apply({ op: "artboard.update", id: "ab_home", x: 1 });
    expect(h.home(again.source)?.x).toBe(333);

    h.backend.online = true;
    await h.clock.advance(2_000);
    expect(again.source.getState().status).toBe("ready");
    expect(again.source.writable).toBe(true);
  });

  test("the cache keeps the last few designs and forgets the oldest", async () => {
    const storage = new MemoryStorage();
    const cache = new DocCache(storage, 2);
    const entry = (designId: string) => ({
      designId,
      name: designId,
      doc: { name: designId, pages: [], tokens: "", threads: [], notes: {} },
      seq: 1,
      assetsUrl: "https://assets.test/x/",
    });
    await Promise.all([cache.write(entry("a")), cache.write(entry("b")), cache.write(entry("c"))]);
    expect(await cache.read("a")).toBeNull();
    expect((await cache.read("c"))?.name).toBe("c");
    expect(JSON.parse(storage.map.get("ponzu.docs")!)).toEqual(["c", "b"]);
  });
});
