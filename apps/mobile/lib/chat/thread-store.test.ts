import { describe, expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import { createFakeBackend } from "@ponzu/client/testing";
import { revealStep, THREAD_PAGE, ThreadStore } from "./thread-store";

/*
 * The phone's thread (thread-store.ts) over the client's fake backend: the live rows, pages of
 * history, and the person's messages on their way, including one that doesn't go.
 */

async function world() {
  const fake = createFakeBackend();
  const maya = fake.addPerson({ login: "maya", name: "Maya Lin" });
  const acme = fake.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const client = fake.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: acme.id,
    repoId: acme.repos[0]!.id,
    name: "Pricing page",
  });
  return { fake, maya, client, canvasId: canvas.id };
}

/** Waits for what the store holds to satisfy `ok`, by its own changes: no sleeping. */
function until(store: ThreadStore, ok: () => boolean): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = store.subscribe(() => {
      if (!ok()) return;
      stop();
      resolve();
    });
  });
}

describe("the phone's thread", () => {
  test("the live rows, in order; a message shows at once and gives way to its own item", async () => {
    const { fake, maya, client, canvasId } = await world();
    fake.agent(canvasId).say("Hello from Ponzu");
    const store = new ThreadStore({
      api: client.api,
      live: client.live,
      canvasId,
      meId: maya.id,
    }).start();
    await until(store, () => (store.getSnapshot().items?.length ?? 0) === 1);
    const sending = store.send("Make it bigger");
    expect(store.getSnapshot().pending.map((m) => m.text)).toEqual(["Make it bigger"]);
    await sending;
    await until(store, () => store.getSnapshot().items?.some((i) => i.kind === "message") ?? false);
    const { items, pending } = store.getSnapshot();
    expect(pending).toEqual([]);
    expect(items!.map((i) => i.kind)).toEqual(["assistant", "message"]);
    store.close();
  });

  test("a send that doesn't go takes its bubble away and says why", async () => {
    const { fake, maya, client, canvasId } = await world();
    const store = new ThreadStore({
      api: client.api,
      live: client.live,
      canvasId,
      meId: maya.id,
    }).start();
    await until(store, () => store.getSnapshot().items !== null);
    fake.online = false;
    const error = await store.send("Lost words").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(store.getSnapshot().pending).toEqual([]);
    store.close();
  });

  test("a message with pictures names their refs, and the bubble shows the local copies", async () => {
    const { maya, client, canvasId } = await world();
    const file = await client.api.canvases.upload(canvasId, {
      name: "shot.png",
      type: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const store = new ThreadStore({
      api: client.api,
      live: client.live,
      canvasId,
      meId: maya.id,
    }).start();
    await until(store, () => store.getSnapshot().items !== null);
    const sending = store.send("Like this", [
      { ref: file.ref!, uri: "file:///shot.png", contentType: "image/png" },
    ]);
    expect(store.getSnapshot().pending[0]!.pictures[0]!.uri).toBe("file:///shot.png");
    await sending;
    await until(store, () => store.getSnapshot().items?.some((i) => i.kind === "message") ?? false);
    const message = store.getSnapshot().items!.find((i) => i.kind === "message")!;
    expect((message.payload as { attachments?: { ref: string }[] }).attachments?.[0]?.ref).toBe(
      file.ref!,
    );
    store.close();
  });

  test("without live rows, history comes a page at a time from the top", async () => {
    const { fake, maya, client, canvasId } = await world();
    const agent = fake.agent(canvasId);
    for (let i = 0; i < THREAD_PAGE + 10; i++) agent.say(`line ${i}`);
    // A Live that never delivers: the store reads pages only.
    const silent = { subscribe: () => () => {} };
    const store = new ThreadStore({
      api: client.api,
      live: silent,
      canvasId,
      meId: maya.id,
    }).start();
    await until(store, () => store.getSnapshot().items !== null);
    expect(store.getSnapshot().items!.length).toBe(THREAD_PAGE);
    expect(store.getSnapshot().older).toBe("more");
    store.loadOlder();
    await until(store, () => store.getSnapshot().older === "none");
    expect(store.getSnapshot().items!.length).toBe(THREAD_PAGE + 10);
    store.close();
  });

  test("a line a link names: wait, page back, then show", () => {
    const at = (seqs: number[]) => seqs.map((seq) => ({ seq })) as never;
    expect(revealStep({ items: null, older: "none" }, 5, 0)).toBe("wait");
    expect(revealStep({ items: at([10, 11]), older: "more" }, 5, 0)).toBe("page");
    expect(revealStep({ items: at([10, 11]), older: "loading" }, 5, 1)).toBe("wait");
    expect(revealStep({ items: at([4, 11]), older: "more" }, 5, 1)).toBe("show");
    // Nothing older to be had: the oldest held shows.
    expect(revealStep({ items: at([10, 11]), older: "none" }, 5, 1)).toBe("show");
    expect(revealStep({ items: at([10, 11]), older: "more" }, 5, 20)).toBe("show");
  });
});
