import { describe, expect, test } from "bun:test";
import { type Api, ApiError } from "@ponzu/client";
import { CloudSource } from "@ponzu/client/canvas";
import { createFakeBackend, FakeClock, type FakePerson } from "@ponzu/client/testing";
import { parseArtboardFile } from "@ponzu/core";
import { CANVAS_WORDS, COMMENT_WORDS } from "../copy";
import { type DraftStorage, Drafts, draftKey, draftsStorageKey } from "../drafts";
import { actorOf } from "./actor";
import {
  CommentRefusedError,
  commit,
  newThreadOp,
  readOnlyLine,
  replyOp,
  statusOp,
} from "./comments";

/*
 * Comments on the phone (comments.ts) over the real CloudSource and the client's fake backend,
 * and their drafts (lib/drafts.ts) over a storage that outlives the app, as AsyncStorage does.
 */

const board = (id: string) => {
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="${id}" data-name="Home" style="width:400px;height:300px"><p>Hi</p></section>`,
    { id, name: "Home" },
  );
  return { ...artboard, x: 0 };
};

/** AsyncStorage, as far as drafts go: it survives the app. */
class Disk implements DraftStorage {
  map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  async removeItem(key: string) {
    this.map.delete(key);
  }
}

async function harness() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ines = backend.addPerson({ login: "ines", name: "Ines" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin", [ines.id]: "member" },
    repos: [{ name: "site", access: { [ines.id]: "read" } }],
  });
  const client = backend.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Kettle",
  });
  const pageId = backend.canvas(canvas.id).sequencer.doc.pages[0]!.id;
  backend
    .agent(canvas.id)
    .commit([{ op: "artboard.create", page: pageId, index: 0, artboard: board("ab_home") }]);
  const settle = () => clock.advance(0);
  const open = (person: FakePerson, api?: Api) => {
    const c = person === maya ? client : backend.connect(person);
    return new CloudSource({
      api: api ?? c.api,
      live: c.live,
      canvasId: canvas.id,
      me: actorOf({ ...person, avatarUrl: null }),
      clock,
    });
  };
  const server = () => backend.canvas(canvas.id).sequencer.doc;
  const spot = { pageId, artboardId: "ab_home", x: 40.4, y: 60.6 };
  return { clock, backend, canvas, maya, ines, open, settle, server, spot, pageId };
}

describe("a comment from the phone", () => {
  test("shows at once, and is the API's once committed, stamped with who wrote it", async () => {
    const h = await harness();
    const source = h.open(h.maya);
    await h.settle();
    const op = newThreadOp(h.spot, "Tighter gap under the title", actorOf(h.maya));
    let done = false;
    const sent = commit(source, op).then(() => {
      done = true;
    });
    // In the canvas the moment it is applied, before the API has answered.
    const here = source.getState().doc!.threads;
    expect(here.map((t) => [t.id, t.artboardId, t.x, t.y])).toEqual([
      [op.thread.id, "ab_home", 40, 61],
    ]);
    expect(done).toBe(false);
    await h.settle();
    await sent;
    expect(done).toBe(true);
    const there = h.server().threads.find((t) => t.id === op.thread.id)!;
    expect(there.messages[0]).toMatchObject({
      text: "Tighter gap under the title",
      author: { kind: "user", id: h.maya.id, name: "Maya" },
    });
  });

  test("a refused one rejects with the API's words, and leaves the canvas as it was", async () => {
    const h = await harness();
    const client = h.backend.connect(h.maya);
    // The API turns the next commit away, as it does an op it won't take.
    const api: Api = {
      ...client.api,
      canvases: {
        ...client.api.canvases,
        commit: async () => {
          throw new ApiError(400, "invalid_request", "That comment is too long to keep.");
        },
      },
    };
    const source = h.open(h.maya, api);
    await h.settle();
    const op = newThreadOp(h.spot, "x".repeat(10), actorOf(h.maya));
    const sent = commit(source, op).then(
      () => null,
      (e: unknown) => e,
    );
    expect(source.getState().doc!.threads).toHaveLength(1);
    await h.settle();
    const error = await sent;
    expect(error).toBeInstanceOf(CommentRefusedError);
    expect((error as Error).message).toBe("That comment is too long to keep.");
    expect(source.getState().doc!.threads).toHaveLength(0);
    expect(h.server().threads).toHaveLength(0);
  });

  test("on a canvas the person may only read, it is refused before it is drawn", async () => {
    const h = await harness();
    const source = h.open(h.ines);
    await h.settle();
    expect(source.writable).toBe(false);
    const error = await commit(source, newThreadOp(h.spot, "Can I?", actorOf(h.ines))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommentRefusedError);
    expect(source.getState().doc!.threads).toHaveLength(0);
    expect(
      readOnlyLine({
        writable: source.writable,
        status: source.getState().status,
        hasDoc: true,
        repo: "acme/site",
      }),
    ).toBe(CANVAS_WORDS.readOnly("acme/site"));
  });

  test("offline, it is drawn and waits; back online, it lands", async () => {
    const h = await harness();
    const source = h.open(h.maya);
    await h.settle();
    h.backend.online = false;
    const op = newThreadOp(h.spot, "When you can", actorOf(h.maya));
    let done = false;
    const sent = commit(source, op).then(() => {
      done = true;
    });
    await h.clock.advance(5_000);
    expect(source.getState().status).toBe("offline");
    expect(source.getState().doc!.threads.map((t) => t.id)).toEqual([op.thread.id]);
    expect(done).toBe(false);
    h.backend.online = true;
    source.retryNow();
    await h.settle();
    await sent;
    expect(h.server().threads.map((t) => t.id)).toEqual([op.thread.id]);
  });

  test("a reply in a resolved thread opens it again; Resolve and Reopen are one op each", async () => {
    const h = await harness();
    const source = h.open(h.maya);
    await h.settle();
    const create = newThreadOp(h.spot, "First", actorOf(h.maya));
    const first = commit(source, create);
    await h.settle();
    await first;
    const resolving = commit(source, statusOp(create.thread.id, "resolved"));
    await h.settle();
    await resolving;
    expect(h.server().threads[0]!.status).toBe("resolved");
    const { op, messageId } = replyOp(h.server().threads[0]!, "One more thing", actorOf(h.maya));
    const replying = commit(source, op);
    await h.settle();
    await replying;
    const thread = h.server().threads[0]!;
    expect(thread.status).toBe("open");
    expect(thread.messages.map((m) => m.id)).toContain(messageId);
  });
});

describe("drafts", () => {
  test("killed between the comment being applied and the API answering: the words survive", async () => {
    const h = await harness();
    const disk = new Disk();
    const drafts = new Drafts(disk);
    const source = h.open(h.maya);
    await h.settle();
    const file = h.canvas.id;
    const key = draftKey.comment(file, h.spot);
    drafts.set(key, { file, pin: h.spot, text: "Tighter gap" });
    h.backend.online = false;
    const op = newThreadOp(h.spot, "Tighter gap", actorOf(h.maya));
    drafts.markSending(key, op.thread.id);
    void commit(source, op).catch(() => {});
    await drafts.flush();
    // The app is killed: the replica and what it was waiting to send go with it.
    source.close();
    h.backend.online = true;

    const next = new Drafts(disk);
    await next.load(file);
    expect(next.get(key)).toMatchObject({ text: "Tighter gap", sending: op.thread.id });
    // The canvas the API holds has no such thread: the words stay, to send again.
    const reopened = h.open(h.maya);
    await h.settle();
    next.settle(file, reopened.getState().doc!);
    expect(next.get(key)?.text).toBe("Tighter gap");
  });

  test("killed after the API took it but before the app heard: the draft goes on the next open", async () => {
    const h = await harness();
    const disk = new Disk();
    const drafts = new Drafts(disk);
    const file = h.canvas.id;
    const key = draftKey.comment(file, h.spot);
    drafts.set(key, { file, pin: h.spot, text: "Landed" });
    const source = h.open(h.maya);
    await h.settle();
    const op = newThreadOp(h.spot, "Landed", actorOf(h.maya));
    drafts.markSending(key, op.thread.id);
    // While it is this run's own, the doc that has it already doesn't settle it.
    drafts.settle(file, source.getState().doc!);
    expect(drafts.get(key)).toBeDefined();
    void commit(source, op);
    await h.settle();
    await drafts.flush();
    source.close();

    const next = new Drafts(disk);
    await next.load(file);
    next.settle(file, h.server());
    expect(next.get(key)).toBeUndefined();
    await next.flush();
    expect(disk.map.has(draftsStorageKey(file))).toBe(false);
  });

  test("left while it waited offline: released, it is unsent again and settles on the next open", async () => {
    const h = await harness();
    const drafts = new Drafts(new Disk());
    const file = h.canvas.id;
    const key = draftKey.comment(file, h.spot);
    drafts.set(key, { file, pin: h.spot, text: "Later" });
    const source = h.open(h.maya);
    await h.settle();
    h.backend.online = false;
    const op = newThreadOp(h.spot, "Later", actorOf(h.maya));
    drafts.markSending(key, op.thread.id);
    void commit(source, op).catch(() => {});
    await h.clock.advance(5_000);
    // The person leaves the canvas: its replica drops what it was waiting to send.
    source.close();
    drafts.release(file);
    expect(drafts.isSending(key)).toBe(false);
    h.backend.online = true;
    const reopened = h.open(h.maya);
    await h.settle();
    drafts.settle(file, reopened.getState().doc!);
    // Never got there: the words stay, to send again, as an unsent pin.
    expect(drafts.get(key)?.text).toBe("Later");
    // Got there after all (another device, say): the next doc with it settles the draft.
    drafts.settle(file, { ...h.server(), threads: [op.thread] });
    expect(drafts.get(key)).toBeUndefined();
  });

  test("a reply written while one is out: landing takes only the sent words away", () => {
    const drafts = new Drafts();
    const key = draftKey.reply("cnv_1", "th_1");
    drafts.set(key, { file: "cnv_1", thread: "th_1", text: "and the lid" });
    drafts.markSending(key, "m_2");
    expect(drafts.sentWords(key)).toBe("and the lid");
    // A field opened again meanwhile keeps what's written after the sent words, with them.
    drafts.set(key, { file: "cnv_1", thread: "th_1", sending: "m_2", text: "and the lid also" });
    drafts.landed(key);
    expect(drafts.get(key)).toEqual({ file: "cnv_1", thread: "th_1", text: "also" });
    expect(drafts.isSending(key)).toBe(false);
    // Nothing written since: the draft goes.
    drafts.markSending(key, "m_3");
    drafts.landed(key);
    expect(drafts.get(key)).toBeUndefined();
  });

  test("a reply sent: its draft goes once its message is in the thread", async () => {
    const disk = new Disk();
    const drafts = new Drafts(disk);
    const key = draftKey.reply("cnv_1", "th_1");
    drafts.set(key, { file: "cnv_1", thread: "th_1", text: "and the lid" });
    drafts.markSending(key, "m_2");
    await drafts.flush();
    const next = new Drafts(disk);
    await next.load("cnv_1");
    const thread = (messages: string[]) => ({
      threads: [{ id: "th_1", messages: messages.map((id) => ({ id })) }],
    });
    next.settle("cnv_1", thread(["m_1"]) as never);
    expect(next.get(key)?.text).toBe("and the lid");
    next.settle("cnv_1", thread(["m_1", "m_2"]) as never);
    expect(next.get(key)).toBeUndefined();
  });

  test("refused, the draft is unsent again; emptied, it is gone from disk", async () => {
    const disk = new Disk();
    const drafts = new Drafts(disk);
    const pin = { pageId: "pg_1", artboardId: "ab_1", x: 1, y: 2 };
    const key = draftKey.comment("cnv_1", pin);
    drafts.set(key, { file: "cnv_1", pin, text: "words" });
    drafts.markSending(key, "th_9");
    expect(drafts.isSending(key)).toBe(true);
    drafts.markSending(key, undefined);
    expect(drafts.isSending(key)).toBe(false);
    expect(drafts.get(key)).toEqual({ file: "cnv_1", pin, text: "words" });
    await drafts.flush();
    expect(JSON.parse(disk.map.get(draftsStorageKey("cnv_1"))!)).toEqual({
      [key]: { file: "cnv_1", pin, text: "words" },
    });
    drafts.set(key, { file: "cnv_1", pin, text: "" });
    await drafts.flush();
    expect(disk.map.size).toBe(0);
  });

  test("what this run holds wins over what is read from disk, and a bad entry is skipped", async () => {
    const disk = new Disk();
    const key = draftKey.reply("cnv_1", "th_1");
    disk.map.set(
      draftsStorageKey("cnv_1"),
      JSON.stringify({ [key]: { file: "cnv_1", thread: "th_1", text: "old" }, junk: null }),
    );
    const drafts = new Drafts(disk);
    drafts.set(key, { file: "cnv_1", thread: "th_1", text: "new" });
    await drafts.load("cnv_1");
    expect(drafts.get(key)?.text).toBe("new");
    expect(drafts.get("junk")).toBeUndefined();
    disk.map.set(draftsStorageKey("cnv_2"), "{not json");
    await drafts.load("cnv_2");
    expect(drafts.snapshot().map(([k]) => k)).toEqual([key]);
  });

  test("signing out forgets them in memory", () => {
    const drafts = new Drafts();
    drafts.set("k", { file: "cnv_1", text: "x" });
    drafts.clear();
    expect(drafts.snapshot()).toEqual([]);
  });
});

describe("the read-only line", () => {
  const line = (over: Partial<Parameters<typeof readOnlyLine>[0]>) =>
    readOnlyLine({ writable: false, status: "ready", hasDoc: true, repo: "acme/site", ...over });
  test("a canvas the person can steer says nothing", () => {
    expect(line({ writable: true })).toBeNull();
  });
  test("still opening says nothing; the last copy says it is offline", () => {
    expect(line({ status: "connecting" })).toBeNull();
    expect(line({ status: "offline" })).toBe(CANVAS_WORDS.offline);
    expect(line({ status: "offline", hasDoc: false })).toBeNull();
  });
  test("read access says what steering takes; Scratch says only that it can be looked at", () => {
    expect(line({})).toBe(
      "You can look at this canvas. Steering it takes push access to acme/site.",
    );
    expect(line({ repo: null })).toBe(COMMENT_WORDS.readOnlyScratch);
  });
});
