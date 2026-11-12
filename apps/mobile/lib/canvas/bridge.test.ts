import { describe, expect, test } from "bun:test";
import { DocCache, type KeyValueStorage } from "@ponzu/client";
import { CloudSource } from "@ponzu/client/canvas";
import { createFakeBackend, FakeClock, type FakePerson } from "@ponzu/client/testing";
import { type Actor, applyOp, type Doc, parseArtboardFile } from "@ponzu/core";
import type { ToCanvas } from "../../canvas/protocol";
import { CanvasBridge } from "./bridge";

/*
 * The doc-or-op rule (bridge.ts) over the real CloudSource and the client's fake backend. A
 * page stands in for the web view: it applies what it's sent exactly as canvas/store.ts does
 * (a doc replaces, an op is applied to a copy and dropped when it doesn't fit), so each test
 * can ask the one thing that matters: does the page show what the replica holds?
 */

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

/** The web view, as far as the doc goes: canvas/store.ts's `doc` and `op`. */
class Page {
  doc: Doc | null = null;
  got: ToCanvas[] = [];
  /** A page that has said `ready`: it hears; before that, nothing reaches it. */
  ready = false;
  receive = (msg: ToCanvas) => {
    if (!this.ready) return;
    this.got.push(msg);
    if (msg.t === "doc") this.doc = msg.doc;
    if (msg.t === "op" && this.doc) {
      const next = structuredClone(this.doc);
      try {
        applyOp(next, msg.op);
      } catch {
        return;
      }
      this.doc = next;
    }
  };
  kinds = () => this.got.map((m) => m.t).filter((t) => t === "doc" || t === "op");
  clear = () => {
    this.got = [];
  };
}

async function harness() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ines = backend.addPerson({ login: "ines", name: "Ines" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin", [ines.id]: "member" },
    repos: [{ name: "site" }],
  });
  const mayaClient = backend.connect(maya);
  const canvas = await mayaClient.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Kettle",
  });
  const pageId = backend.canvas(canvas.id).sequencer.doc.pages[0]!.id;
  const agent = backend.agent(canvas.id);
  agent.commit([{ op: "artboard.create", page: pageId, index: 0, artboard: board("ab_home") }]);
  const settle = () => clock.advance(0);

  /** Someone's phone with the canvas open: its source, its bridge, and a ready page. */
  const open = (person: FakePerson, opts: { cache?: DocCache } = {}) => {
    const client = person === maya ? mayaClient : backend.connect(person);
    const source = new CloudSource({
      api: client.api,
      live: client.live,
      canvasId: canvas.id,
      me: actorOf(person),
      clock,
      ...opts,
    });
    const bridge = new CanvasBridge(source, { canvasId: canvas.id, me: { id: person.id } });
    const page = new Page();
    bridge.connect(page.receive, { theme: () => "light" });
    /** The page loads (or loads again after iOS ended it) and says `ready`. */
    const ready = () => {
      page.ready = true;
      for (const msg of bridge.all()) page.receive(msg);
    };
    ready();
    return { source, bridge, page, ready };
  };
  return { clock, backend, canvas, pageId, agent, maya, ines, open, settle };
}

const boards = (doc: Doc | null) => doc?.pages[0]?.artboards ?? [];

describe("the doc-or-op rule", () => {
  test("the agent's ops reach the page as ops, so they develop in, and the page keeps up", async () => {
    const h = await harness();
    const { source, page } = h.open(h.maya);
    await h.settle();
    expect(page.doc).toEqual(source.getState().doc);
    page.clear();

    h.agent.commit([
      { op: "artboard.create", page: h.pageId, index: 1, artboard: board("ab_price", 900) },
    ]);
    h.agent.commit([{ op: "artboard.update", id: "ab_price", y: 40 }]);
    await h.settle();

    expect(page.kinds()).toEqual(["op", "op"]);
    expect(page.got.filter((m) => m.t === "op").map((m) => m.t === "op" && m.origin?.kind)).toEqual(
      ["agent", "agent"],
    );
    expect(page.doc).toEqual(source.getState().doc);
    expect(boards(page.doc).map((a) => a.id)).toEqual(["ab_home", "ab_price"]);
  });

  test("an op refused after it was drawn sends the whole doc, never a stale op", async () => {
    const h = await harness();
    const maya = h.open(h.maya);
    const ines = h.open(h.ines);
    await h.settle();

    // Ines deletes the board while Maya, not having heard yet, renames it: Maya's page draws
    // the rename at once, and the API then refuses it.
    h.backend.online = false;
    ines.source.apply({ op: "artboard.delete", id: "ab_home" });
    maya.source.apply({ op: "artboard.update", id: "ab_home", name: "Landing" });
    expect(boards(maya.page.doc)[0]?.name).toBe("Landing");
    maya.page.clear();
    h.backend.online = true;
    ines.source.retryNow();
    await h.settle();
    maya.source.retryNow();
    await h.clock.advance(1_000);

    expect(boards(maya.source.getState().doc)).toEqual([]);
    expect(maya.page.kinds()).toContain("doc");
    expect(maya.page.doc).toEqual(maya.source.getState().doc);
  });

  test("an op of the person's, then a refusal in the same answer as another op: the page is right", async () => {
    const h = await harness();
    const maya = h.open(h.maya);
    await h.settle();
    h.agent.commit([
      { op: "artboard.create", page: h.pageId, index: 1, artboard: board("ab_price", 900) },
    ]);
    // Maya moves Home while offline; meanwhile the agent deletes it and moves Price.
    h.backend.online = false;
    maya.source.apply({ op: "artboard.update", id: "ab_home", x: 300 });
    h.agent.commit([{ op: "artboard.delete", id: "ab_home" }]);
    h.agent.commit([{ op: "artboard.update", id: "ab_price", y: 500 }]);
    maya.page.clear();
    h.backend.online = true;
    maya.source.retryNow();
    await h.clock.advance(1_000);

    expect(boards(maya.source.getState().doc).map((a) => [a.id, a.y])).toEqual([["ab_price", 500]]);
    expect(maya.page.kinds()).toContain("doc");
    expect(maya.page.doc).toEqual(maya.source.getState().doc);
  });

  test("an op from someone else landing under the person's own: the page ends where the replica does", async () => {
    const h = await harness();
    const maya = h.open(h.maya);
    await h.settle();
    // Both move Home; the agent's lands first at the API, then Maya's on top of it.
    h.backend.online = false;
    maya.source.apply({ op: "artboard.update", id: "ab_home", x: 10 });
    h.agent.commit([{ op: "artboard.update", id: "ab_home", x: 20, y: 7 }]);
    h.backend.online = true;
    maya.source.retryNow();
    await h.clock.advance(1_000);

    const server = h.backend.canvas(h.canvas.id).sequencer.doc;
    expect(maya.source.getState().doc).toEqual(server);
    expect(boards(server)[0]).toMatchObject({ x: 10, y: 7 });
    expect(maya.page.doc).toEqual(server);
  });

  test("a page iOS ended and loaded again gets the whole doc, with what came while it was gone", async () => {
    const h = await harness();
    const { source, page, ready } = h.open(h.maya);
    await h.settle();

    page.ready = false;
    page.doc = null;
    page.clear();
    h.agent.commit([
      { op: "artboard.create", page: h.pageId, index: 1, artboard: board("ab_price", 900) },
    ]);
    await h.settle();
    expect(page.got).toEqual([]);

    ready();
    expect(page.got.map((m) => m.t)).toEqual(["doc", "presence", "working"]);
    const drawn = page.doc as Doc | null;
    expect(drawn).toEqual(source.getState().doc);
    expect(boards(drawn).map((a) => a.id)).toEqual(["ab_home", "ab_price"]);
  });

  test("the cached copy goes as a doc, then the live one as another", async () => {
    const h = await harness();
    const cache = new DocCache(new MemoryStorage());
    const first = h.open(h.maya, { cache });
    await h.settle();
    first.source.close();
    await h.settle();

    // The phone opens it again with the API out of reach: the last copy, read only.
    h.backend.online = false;
    const again = h.open(h.maya, { cache });
    await h.settle();
    expect(again.page.kinds()).toEqual(["doc"]);
    expect(boards(again.page.doc).map((a) => a.id)).toEqual(["ab_home"]);
    expect(again.source.writable).toBe(false);

    h.agent.commit([{ op: "artboard.update", id: "ab_home", x: 77 }]);
    h.backend.online = true;
    again.source.retryNow();
    await h.clock.advance(2_000);
    expect(again.page.kinds()).toEqual(["doc", "doc"]);
    expect(again.page.doc).toEqual(again.source.getState().doc);
    expect(boards(again.page.doc)[0]?.x).toBe(77);
  });

  test("the doc message carries the assets base, the canvas's id and the page asked for", async () => {
    const h = await harness();
    const client = h.backend.connect(h.maya);
    const source = new CloudSource({
      api: client.api,
      live: client.live,
      canvasId: h.canvas.id,
      me: actorOf(h.maya),
      clock: h.clock,
    });
    const bridge = new CanvasBridge(source, { canvasId: h.canvas.id, me: { id: h.maya.id } });
    const got: ToCanvas[] = [];
    bridge.connect((m) => got.push(m), { theme: () => "dark", page: () => h.pageId });
    await h.settle();
    expect(got.find((m) => m.t === "doc")).toMatchObject({
      t: "doc",
      assetBase: `https://assets.test/${h.canvas.id}/`,
      theme: "dark",
      file: h.canvas.id,
      page: h.pageId,
    });
  });
});

describe("rings", () => {
  test("the head's boards go as `working`, once per change, and closing stops everything", async () => {
    const h = await harness();
    const { bridge, page } = h.open(h.maya);
    await h.settle();
    page.clear();
    bridge.setWorking(["ab_home"]);
    bridge.setWorking(["ab_home"]);
    bridge.setWorking([]);
    expect(page.got).toEqual([
      { t: "working", artboards: ["ab_home"] },
      { t: "working", artboards: [] },
    ]);

    bridge.close();
    page.clear();
    h.agent.commit([{ op: "artboard.update", id: "ab_home", x: 5 }]);
    await h.settle();
    bridge.setWorking(["ab_home"]);
    expect(page.got).toEqual([]);
  });
});
