import { expect, test } from "bun:test";
import { createFakeBackend, settle } from "@ponzu/client/testing";
import type { Doc, Op, Origin } from "@ponzu/core";
import { CommentPictures } from "./comment-pictures.ts";

/*
 * The pictures of the viewer's own comments, against Ponzu Cloud in memory: drawn as each is
 * sent, shown from here meanwhile, kept with the comment once it is in the thread, and let go of
 * when they can't be drawn or kept, so the comment reads as everyone else's does.
 */

async function world({
  draw,
  drawable,
}: {
  draw?: () => Promise<{ light: Blob; dark: Blob }>;
  drawable?: () => boolean;
} = {}) {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const sam = backend.addPerson({ login: "sam", name: "Sam Lee" });
  const ws = backend.addWorkspace({
    login: "north-brook",
    members: { [maya.id]: "admin", [sam.id]: "member" },
    repos: [{ name: "site" }],
  });
  const client = backend.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Pricing",
  });
  const listeners = new Set<(op: Op, origin: Origin, doc: Doc) => void>();
  let committed: Promise<void> = Promise.resolve();
  const drawn: string[] = [];
  const released: string[] = [];
  let urls = 0;
  const pictures = new CommentPictures({
    canvasId: canvas.id,
    meId: maya.id,
    source: {
      onOp: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      saved: () => committed,
    },
    api: client.api.canvases,
    draw:
      draw ??
      (async ({ messageId }) => {
        drawn.push(messageId);
        return { light: new Blob(["l"]), dark: new Blob(["d"]) };
      }),
    ...(drawable ? { drawable } : {}),
    wait: async () => {},
    preview: () => `blob:${++urls}`,
    release: (url) => released.push(url),
  }).start();

  const me = { kind: "user" as const, id: maya.id, name: "Maya Ortiz" };
  /** Maya leaves a comment: the canvas hears its op, and it is committed (or not yet). */
  const leave = async (messageId: string, opts: { commit?: boolean; createdAt?: number } = {}) => {
    const op: Op = {
      op: "thread.create",
      thread: {
        id: `th_${messageId}`,
        pageId: backend.canvas(canvas.id).sequencer.doc.pages[0]!.id,
        x: 10,
        y: 10,
        status: "open",
        createdAt: 0,
        updatedAt: 0,
        messages: [
          { id: messageId, author: me, text: "Here", createdAt: opts.createdAt ?? Date.now() },
        ],
      },
    };
    const commit = () => client.api.canvases.commit(canvas.id, [{ id: `op_${messageId}`, op }]);
    if (opts.commit !== false) await commit();
    for (const listener of listeners) listener(op, me, backend.canvas(canvas.id).sequencer.doc);
    return commit;
  };
  const kept = (messageId: string) =>
    backend
      .canvas(canvas.id)
      .thread.map(({ item }) => item)
      .find((item) => item.kind === "comment" && item.payload.messageId === messageId);
  return {
    backend,
    pictures,
    leave,
    kept,
    drawn,
    released,
    listeners,
    sam,
    setCommitted: (p: Promise<void>) => {
      committed = p;
    },
  };
}

test("the viewer's comment is drawn as it is sent, shown from here, and kept with the comment", async () => {
  const w = await world();
  await w.leave("m_1");
  // At once, before anything is drawn: the scene to draw live in its place.
  expect(w.pictures.getSnapshot().get("m_1")).toMatchObject({
    state: "drawing",
    threadId: "th_m_1",
  });
  await settle();
  await settle();
  expect(w.drawn).toEqual(["m_1"]);
  expect(w.pictures.getSnapshot().get("m_1")).toEqual({
    state: "drawn",
    light: "blob:1",
    dark: "blob:2",
  });
  const item = w.kept("m_1");
  expect(item?.kind === "comment" && item.payload.picture).toMatchObject({
    light: expect.stringMatching(/^comments\/m_1-light-/),
    width: 240,
    height: 160,
  });
  w.pictures.close();
  expect(w.released).toEqual(["blob:1", "blob:2"]);
});

test("only the viewer's own new comments are drawn", async () => {
  const w = await world();
  const sam = { kind: "user" as const, id: w.sam.id, name: "Sam Lee" };
  const op: Op = {
    op: "thread.message",
    id: "th_x",
    message: { id: "m_sam", author: sam, text: "Hi", createdAt: Date.now() },
  };
  for (const listener of w.listeners) listener(op, sam, {} as Doc);
  // A comment an undo or a redo puts back is one they made long ago.
  await w.leave("m_old", { createdAt: Date.now() - 10 * 60_000 });
  await settle();
  expect(w.drawn).toEqual([]);
  expect(w.pictures.getSnapshot().size).toBe(0);
});

test("a picture waits for its comment's op, and one that can't be drawn or kept is let go of", async () => {
  // The op still on its way when the picture is ready: it is attached once the op is in.
  const w = await world();
  let commitNow!: () => void;
  w.setCommitted(new Promise((resolve) => (commitNow = resolve)));
  const commit = await w.leave("m_slow", { commit: false });
  await settle();
  await settle();
  expect(w.pictures.getSnapshot().get("m_slow")?.state).toBe("drawn");
  await commit();
  commitNow();
  await settle();
  await settle();
  const item = w.kept("m_slow");
  expect(item?.kind === "comment" && item.payload.picture).toBeTruthy();

  // Never committed: after a few tries, the comment goes without.
  await w.leave("m_lost", { commit: false });
  for (let i = 0; i < 12; i++) await settle();
  expect(w.pictures.getSnapshot().has("m_lost")).toBe(false);

  // Drawing fails: nothing to show but where it was left.
  const broken = await world({ draw: () => Promise.reject(new Error("no")) });
  await broken.leave("m_2");
  await settle();
  expect(broken.pictures.getSnapshot().has("m_2")).toBe(false);
  const item2 = broken.kept("m_2");
  expect(item2?.kind === "comment" && item2.payload.picture).toBeUndefined();
});

test("a comment with nothing round its pin to show is never drawn: it reads without a picture", async () => {
  const w = await world({ drawable: () => false });
  await w.leave("m_far");
  // Not even for a moment.
  expect(w.pictures.getSnapshot().has("m_far")).toBe(false);
  await settle();
  expect(w.drawn).toEqual([]);
  const item = w.kept("m_far");
  expect(item?.kind === "comment" && item.payload.picture).toBeUndefined();
});
