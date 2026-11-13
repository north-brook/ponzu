import { expect, test } from "bun:test";
import type { Artboard, Doc, PElement } from "@ponzu/core";
import type { PictureAnswer, PictureRequest } from "@ponzu/desktop/bridge";
import { NoPicture, pictureDoc } from "./comment-picture.tsx";
import { pictureDrawer } from "./picture-drawer.ts";
import { runPictureHost } from "./picture-host.ts";

/*
 * Where a comment's picture is drawn: through the shell's picture window when there is one,
 * never in the person's window unless that fails, and from the document cut down to what the
 * picture can show.
 */

const board = (id: string, x: number): Artboard => ({
  id,
  name: id,
  x,
  y: 0,
  root: {
    kind: "el",
    id: `n_${id}`,
    tag: "main",
    attrs: {},
    style: { width: "1200px", height: "800px" },
    children: [],
  } as PElement,
});

/** A page of eight boards in a row, 1,400 px apart, another page, and a comment on the first. */
const doc = {
  name: "Shop",
  pages: [
    {
      id: "pg_1",
      name: "Page 1",
      artboards: Array.from({ length: 8 }, (_, i) => board(`ab_${i}`, i * 1400)),
    },
    { id: "pg_2", name: "Page 2", artboards: [board("ab_other", 0)] },
  ],
  tokens: ":root { --ink: #111; }",
  threads: [
    {
      id: "th_1",
      artboardId: "ab_0",
      x: 600,
      y: 400,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: "m_1", author: { kind: "user", id: "u_1", name: "Maya" }, text: "Hi", createdAt: 0 },
      ],
    },
    {
      id: "th_2",
      pageId: "pg_2",
      x: 0,
      y: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    },
  ],
  notes: { a: "b" },
} as unknown as Doc;

const comment = { doc, threadId: "th_1", messageId: "m_1" };
type Given = { messageId: string; pace?: string };
const files = () => ({ light: new Blob(["l"]), dark: new Blob(["d"]) });

test("the document a picture is drawn from is its thread and the boards in reach of its pin", () => {
  const cut = pictureDoc(doc, "th_1", "m_1")!;
  expect(cut.pages).toHaveLength(1);
  // The pin is at x 600: the boards within 2,600 px of it, and nothing of the other page.
  expect(cut.pages[0]!.artboards.map((ab) => ab.id)).toEqual(["ab_0", "ab_1", "ab_2"]);
  expect(cut.threads.map((t) => t.id)).toEqual(["th_1"]);
  expect(cut.tokens).toBe(doc.tokens);
  expect(cut.notes).toEqual({});
  expect(pictureDoc(doc, "th_nope", "m_1")).toBeNull();
});

test("with a picture window, the picture is drawn there and never here", async () => {
  const asked: PictureRequest[] = [];
  const here: Given[] = [];
  const draw = pictureDrawer(
    {
      draw: async (request) => {
        asked.push(request);
        return { ok: true, light: new Uint8Array([1, 2]), dark: new Uint8Array([3]) };
      },
    },
    (async (given: Given) => {
      here.push(given);
      return files();
    }) as never,
  );
  const drawn = await draw({ ...comment, assetBase: "https://assets.test/c" });
  expect(here).toEqual([]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({
    threadId: "th_1",
    messageId: "m_1",
    assetBase: "https://assets.test/c",
  });
  expect((asked[0]!.doc as Doc).pages[0]!.artboards).toHaveLength(3);
  expect(drawn.light.type).toBe("image/webp");
  expect([...new Uint8Array(await drawn.light.arrayBuffer())]).toEqual([1, 2]);
  expect([...new Uint8Array(await drawn.dark.arrayBuffer())]).toEqual([3]);
});

test("nothing round the pin is no picture; a window that can't is drawn here instead", async () => {
  const here: Given[] = [];
  const drawHere = (async (given: Given) => {
    here.push(given);
    return files();
  }) as never;
  let answer: PictureAnswer = { ok: false, reason: "empty" };
  const draw = pictureDrawer({ draw: async () => answer }, drawHere);
  await expect(draw(comment)).rejects.toBeInstanceOf(NoPicture);
  expect(here).toEqual([]);
  answer = { ok: false, reason: "failed", message: "It went away." };
  expect(await (await draw(comment)).light.text()).toBe("l");
  expect(here.map((g) => g.pace)).toEqual(["idle"]);
  // A bridge that throws is the same.
  const thrown = pictureDrawer({ draw: () => Promise.reject(new Error("gone")) }, drawHere);
  await thrown(comment);
  expect(here).toHaveLength(2);
});

test("without a picture window, it is drawn here at the window's idle pace", async () => {
  const here: Given[] = [];
  const draw = pictureDrawer(undefined, (async (given: Given) => {
    here.push(given);
    return files();
  }) as never);
  await draw(comment);
  expect(here.map((g) => g.pace)).toEqual(["idle"]);
});

test("the picture window's studio draws each asked for in turn and answers it", async () => {
  let listener!: (id: number, request: PictureRequest) => void;
  const answers: [number, PictureAnswer][] = [];
  let answered!: () => void;
  const done = new Promise<void>((resolve) => (answered = resolve));
  const paces: (string | undefined)[] = [];
  runPictureHost(
    {
      onRequest: (heard) => {
        listener = heard;
      },
      answer: (id, answer) => {
        answers.push([id, answer]);
        if (answers.length === 3) answered();
      },
    },
    (async (given: Given) => {
      paces.push(given.pace);
      if (given.messageId === "m_empty") throw new NoPicture();
      if (given.messageId === "m_bad") throw new Error("broken");
      return { light: new Blob([new Uint8Array([7])]), dark: new Blob([new Uint8Array([8])]) };
    }) as never,
  );
  const ask = (id: number, messageId: string) => listener(id, { doc, threadId: "th_1", messageId });
  ask(1, "m_1");
  ask(2, "m_empty");
  ask(3, "m_bad");
  await done;
  expect(answers.map(([id]) => id)).toEqual([1, 2, 3]);
  expect(answers[0]![1]).toEqual({
    ok: true,
    light: new Uint8Array([7]),
    dark: new Uint8Array([8]),
  });
  expect(answers[1]![1]).toEqual({ ok: false, reason: "empty" });
  expect(answers[2]![1]).toMatchObject({ ok: false, reason: "failed" });
  expect(paces).toEqual(["now", "now", "now"]);
});
