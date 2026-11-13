import { describe, expect, test } from "bun:test";
import { CloudSource } from "@ponzu/client/canvas";
import { createFakeBackend, FakeClock } from "@ponzu/client/testing";
import { type Actor, parseArtboardFile } from "@ponzu/core";
import type { PictureAnswer, ToCanvas } from "../../canvas/protocol";
import { commit, newThreadOp, replyOp } from "./comments";
import { bytesOf, NoPicture, PicturePage, phonePictures } from "./pictures";

/*
 * The pictures of the comments sent from this phone (pictures.ts), over the real CloudSource and
 * the client's fake backend, with a page that answers as canvas/picture.ts does: asked for as the
 * comment is made, drawn as PNG, uploaded as PNG and kept with the comment once the API has it.
 */

const board = (id: string) => {
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="${id}" data-name="Plans" style="width:400px;height:300px"><p>Hi</p></section>`,
    { id, name: "Plans" },
  );
  return artboard;
};

/** A canvas page that answers each ask with what `answer` says, when the test lets it. */
class FakePage {
  asked: Extract<ToCanvas, { t: "picture" }>[] = [];
  page: PicturePage;
  constructor(clock: FakeClock) {
    this.page = new PicturePage((msg) => {
      if (msg.t === "picture") this.asked.push(msg);
    }, clock);
  }
  answer(id: string, with_: Omit<PictureAnswer, "t" | "id">) {
    this.page.heard({ t: "picture", id, ...with_ } as PictureAnswer);
  }
}

async function harness() {
  const clock = new FakeClock();
  const backend = createFakeBackend({ clock });
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const client = backend.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Pricing",
  });
  const pageId = backend.canvas(canvas.id).sequencer.doc.pages[0]!.id;
  backend
    .agent(canvas.id)
    .commit([{ op: "artboard.create", page: pageId, index: 0, artboard: board("ab_plans") }]);
  const me: Actor = { kind: "user", id: maya.id, name: "Maya" };
  const source = new CloudSource({
    api: client.api,
    live: client.live,
    canvasId: canvas.id,
    me,
    clock,
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) await clock.advance(0);
  };
  await settle();
  const fake = new FakePage(clock);
  const uploads: { format: string | undefined }[] = [];
  const api = {
    ...client.api.canvases,
    uploadCommentPicture: ((id, messageId, files, format) => {
      uploads.push({ format });
      return client.api.canvases.uploadCommentPicture(id, messageId, files, format);
    }) as typeof client.api.canvases.uploadCommentPicture,
  };
  const pictures = phonePictures({
    canvasId: canvas.id,
    meId: maya.id,
    source,
    api,
    page: fake.page,
    wait: async () => {},
  }).start();
  const kept = (messageId: string) => {
    const item = backend
      .canvas(canvas.id)
      .thread.map(({ item }) => item)
      .find((i) => i.kind === "comment" && i.payload.messageId === messageId);
    return item?.kind === "comment" ? item.payload : undefined;
  };
  return { source, pictures, fake, me, settle, kept, uploads, clock };
}

const PNG_LIGHT = btoa("\x89PNG light");
const PNG_DARK = btoa("\x89PNG dark");

describe("a comment's picture from the phone", () => {
  test("is asked of the page as the comment is made, and kept with it as PNG", async () => {
    const h = await harness();
    const op = newThreadOp({ artboardId: "ab_plans", x: 40, y: 30 }, "Bigger", h.me);
    const messageId = op.thread.messages[0]!.id;
    const sent = commit(h.source, op);
    // At once, the thread shows it being drawn; the page is asked as soon as it is its turn.
    expect(h.pictures.getSnapshot().get(messageId)).toMatchObject({ state: "drawing" });
    await sent;
    expect(h.fake.asked).toEqual([
      { t: "picture", id: expect.any(String), threadId: op.thread.id, messageId },
    ]);
    h.fake.answer(h.fake.asked[0]!.id, { light: PNG_LIGHT, dark: PNG_DARK });
    await h.settle();
    expect(h.pictures.getSnapshot().get(messageId)).toEqual({
      state: "drawn",
      light: `data:image/png;base64,${PNG_LIGHT}`,
      dark: `data:image/png;base64,${PNG_DARK}`,
    });
    expect(h.uploads).toEqual([{ format: "png" }]);
    expect(h.kept(messageId)?.picture).toMatchObject({
      light: expect.stringMatching(new RegExp(`^comments/${messageId}-light-.*\\.png$`)),
      dark: expect.stringMatching(new RegExp(`^comments/${messageId}-dark-.*\\.png$`)),
      width: 240,
      height: 160,
    });
  });

  test("a reply has one too", async () => {
    const h = await harness();
    const first = newThreadOp({ artboardId: "ab_plans", x: 40, y: 30 }, "Bigger", h.me);
    await commit(h.source, first);
    h.fake.answer(h.fake.asked[0]!.id, { none: true });
    const { op, messageId } = replyOp({ id: first.thread.id, status: "open" }, "And bolder", h.me);
    await commit(h.source, op);
    expect(h.fake.asked.at(-1)).toMatchObject({ threadId: first.thread.id, messageId });
  });

  test("with nothing round its pin, or a page that fails or never answers, it goes without", async () => {
    const h = await harness();
    const ops = ["none", "failed", "silent"].map((text) =>
      newThreadOp({ artboardId: "ab_plans", x: 40, y: 30 }, text, h.me),
    );
    for (const op of ops) await commit(h.source, op);
    await h.settle();
    // One at a time, in order: each is asked once the one before is done with.
    h.fake.answer(h.fake.asked[0]!.id, { none: true });
    await h.settle();
    h.fake.answer(h.fake.asked[1]!.id, { failed: "WebKit said no" });
    await h.settle();
    expect(h.fake.asked).toHaveLength(3);
    // The third never answers: the page's wait runs out.
    await h.clock.advance(30_000);
    await h.settle();
    for (const op of ops) {
      const messageId = op.thread.messages[0]!.id;
      expect(h.pictures.getSnapshot().has(messageId)).toBe(false);
      expect(h.kept(messageId)?.picture).toBeUndefined();
    }
    expect(h.uploads).toEqual([]);
  });

  test("against an API from before PNG was taken, the comment goes and reads without one", async () => {
    const h = await harness();
    // What a deployed API that takes only WebP answers a PNG pair (checkUpload's names rule).
    const { ApiError } = await import("@ponzu/client");
    const refused = new ApiError(
      400,
      "invalid_request",
      "A comment is named light.webp or dark.webp.",
    );
    const pictures = phonePictures({
      canvasId: "cnv_old_api",
      meId: h.me.id,
      source: h.source,
      api: {
        uploadCommentPicture: async () => {
          throw refused;
        },
        attachCommentPicture: async () => {
          throw new Error("never asked");
        },
      },
      page: h.fake.page,
      wait: async () => {},
    }).start();
    h.pictures.close();
    const op = newThreadOp({ artboardId: "ab_plans", x: 4, y: 3 }, "Old API", h.me);
    const messageId = op.thread.messages[0]!.id;
    await commit(h.source, op);
    await h.settle();
    h.fake.answer(h.fake.asked.at(-1)!.id, { light: PNG_LIGHT, dark: PNG_DARK });
    await h.settle();
    expect(pictures.getSnapshot().has(messageId)).toBe(false);
    expect(h.kept(messageId)?.text).toBe("Old API");
    expect(h.kept(messageId)?.picture).toBeUndefined();
  });

  test("an answer to no ask is dropped, and closing lets every ask go", async () => {
    const posted: ToCanvas[] = [];
    const page = new PicturePage((msg) => posted.push(msg));
    page.heard({ t: "picture", id: "pic_99", light: "a", dark: "b" });
    const drawing = page.draw({ threadId: "th_1", messageId: "m_1" });
    page.close();
    expect(await drawing.catch((e: Error) => e.message)).toBe("The canvas closed.");
    const none = new PicturePage(() => {});
    const asked = none.draw({ threadId: "th_2", messageId: "m_2" });
    none.heard({ t: "picture", id: "pic_1", none: true });
    expect(await asked.catch((e: Error) => e)).toBeInstanceOf(NoPicture);
    expect(posted).toEqual([{ t: "picture", id: "pic_1", threadId: "th_1", messageId: "m_1" }]);
  });

  test("its bytes are the base64 the page sent", () => {
    expect([...bytesOf(btoa("\x89PNG"))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
