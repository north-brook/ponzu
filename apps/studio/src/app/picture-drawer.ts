import type { Doc } from "@ponzu/core";
import type { PictureAnswer, PictureRequest } from "@ponzu/desktop/bridge";
import { drawCommentPicture, NoPicture, pictureDoc, type Theme } from "./comment-picture.tsx";

/*
 * Where a comment's picture is drawn (CommentPictures' `draw`). In the desktop app, out of the
 * person's window: the shell's hidden picture window draws it in its own renderer
 * (apps/desktop/src/pictures.ts), from the document cut down to what the picture shows, and
 * hands back the two files. Drawing it takes nothing from this window's main thread and leaves
 * nothing in it. Elsewhere (a browser, an older shell), or if the picture window can't, it is
 * drawn here, at the window's idle pace (`Pace`).
 */

/** Once the window has painted what is waiting (or a moment, where it paints nothing). */
function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 0),
    );
  });
}

/** The picture window's failures in a row after which a canvas stops asking it. */
export const GIVE_UP = 2;

export type PictureBridge = { draw(request: PictureRequest): Promise<PictureAnswer> };

export interface Comment {
  doc: Doc;
  threadId: string;
  messageId: string;
  assetBase?: string | undefined;
}

export function pictureDrawer(
  bridge: PictureBridge | undefined,
  drawHere: typeof drawCommentPicture = drawCommentPicture,
): (comment: Comment) => Promise<Record<Theme, Blob>> {
  const here = (comment: Comment) => drawHere({ ...comment, pace: "idle" });
  if (!bridge) return here;
  // Failures in a row. A picture window that keeps failing (one that never starts, or never
  // draws, on some computer) would make every comment wait out its time limit and start a new
  // window: after `GIVE_UP` in a row, this canvas's pictures are drawn here instead.
  let failures = 0;
  return async (comment) => {
    if (failures >= GIVE_UP) return here(comment);
    // The comment is drawn first: what goes to the picture window is copied after the next paint.
    await afterPaint();
    const doc = pictureDoc(comment.doc, comment.threadId, comment.messageId);
    if (!doc) throw new Error("The comment isn't in the document.");
    let answer: PictureAnswer;
    try {
      answer = await bridge.draw({
        doc,
        threadId: comment.threadId,
        messageId: comment.messageId,
        ...(comment.assetBase ? { assetBase: comment.assetBase } : {}),
      });
    } catch (error) {
      answer = { ok: false, reason: "failed", message: String(error) };
    }
    failures = answer.ok || answer.reason === "empty" ? 0 : failures + 1;
    if (answer.ok) {
      return {
        light: new Blob([new Uint8Array(answer.light)], { type: "image/webp" }),
        dark: new Blob([new Uint8Array(answer.dark)], { type: "image/webp" }),
      };
    }
    if (answer.reason === "empty") throw new NoPicture();
    // The picture window couldn't: drawn here, so the comment still has its picture.
    console.warn("[ponzu] the picture window couldn't draw a comment's picture:", answer.message);
    return here({ ...comment, doc });
  };
}
