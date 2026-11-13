/*
 * A comment's picture, drawn in the canvas page as the Mac draws it (packages/canvas's
 * comment-picture.tsx, shared with the studio): the area of the page round the pin, in light and
 * dark, at the runner protocol's `COMMENT_PICTURE` size. WebKit's canvas can't write WebP (asked
 * for it, it writes PNG), so the iPhone's are PNG, which the API takes for a comment's picture
 * beside the Mac's WebP. The app asks (`picture`), the page answers with the files' base64; the
 * app uploads them (lib/canvas/pictures.ts). The page itself still calls no API.
 */
import type { Doc } from "@ponzu/core";
import {
  commentIn,
  drawCommentPicture,
  hasPictureArea,
} from "../../../packages/canvas/src/comment-picture.tsx";
import { COMMENT_PICTURE } from "../../runner/src/api/protocol.ts";
import type { PictureAnswer, ToCanvas } from "./protocol.ts";
import { getState, send, subscribe } from "./store.ts";

/** How long the page waits for the comment to reach its doc, which follows the app's ask. */
const ARRIVE_MS = 5_000;

type Ask = Extract<ToCanvas, { t: "picture" }>;

/** One picture drawn at a time, in the order asked. */
let queue: Promise<void> = Promise.resolve();

/** Draws the picture the app asked for, after any it asked for before, and answers it. */
export function picture(ask: Ask): void {
  queue = queue.then(() => draw(ask).then(send));
}

async function draw(ask: Ask): Promise<PictureAnswer> {
  const { id, threadId, messageId } = ask;
  try {
    const doc = await docWith(threadId, messageId);
    if (!doc) return { t: "picture", id, failed: "The comment never reached the canvas." };
    if (!hasPictureArea({ doc, threadId, messageId })) return { t: "picture", id, none: true };
    const files = await drawCommentPicture({
      doc,
      threadId,
      messageId,
      assetBase: getState().assetBase,
      size: COMMENT_PICTURE,
      type: "image/png",
    });
    return {
      t: "picture",
      id,
      light: await base64(files.light),
      dark: await base64(files.dark),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "NoPicture") {
      return { t: "picture", id, none: true };
    }
    return { t: "picture", id, failed: String((error as Error)?.message ?? error) };
  }
}

/**
 * The page's doc once it holds the comment: the app asks as its op is made, and the op (or the
 * whole doc) follows the ask. Null if it never comes.
 */
function docWith(threadId: string, messageId: string): Promise<Doc | null> {
  const has = () => {
    const { doc } = getState();
    return doc && commentIn(doc, threadId, messageId) ? doc : null;
  };
  const now = has();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (doc: Doc | null) => {
      clearTimeout(timer);
      off();
      resolve(doc);
    };
    const off = subscribe(() => {
      const doc = has();
      if (doc) done(doc);
    });
    const timer = setTimeout(() => done(null), ARRIVE_MS);
  });
}

/** A file's bytes as base64, as a message to the app carries them. */
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The picture couldn't be read."));
    reader.readAsDataURL(blob);
  });
}
