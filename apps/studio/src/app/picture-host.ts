import type { Doc } from "@ponzu/core";
import type { PictureAnswer, PictureHostBridge, PictureRequest } from "@ponzu/desktop/bridge";
import { drawCommentPicture, NoPicture } from "./comment-picture.tsx";

/*
 * The studio in the desktop's hidden picture window (apps/desktop/src/pictures.ts): no app, only
 * comments' pictures, drawn as the shell asks, one at a time, and answered with their files.
 * It has the renderer to itself, so a picture goes straight through (`pace: "now"`).
 */
export function runPictureHost(
  bridge: PictureHostBridge,
  draw: typeof drawCommentPicture = drawCommentPicture,
): void {
  let queue: Promise<void> = Promise.resolve();
  bridge.onRequest((id, request) => {
    queue = queue.then(async () => bridge.answer(id, await answerFor(request, draw)));
  });
}

async function answerFor(
  request: PictureRequest,
  draw: typeof drawCommentPicture,
): Promise<PictureAnswer> {
  try {
    const files = await draw({
      doc: request.doc as Doc,
      threadId: request.threadId,
      messageId: request.messageId,
      ...(request.assetBase ? { assetBase: request.assetBase } : {}),
      pace: "now",
    });
    return {
      ok: true,
      light: new Uint8Array(await files.light.arrayBuffer()),
      dark: new Uint8Array(await files.dark.arrayBuffer()),
    };
  } catch (error) {
    if (error instanceof NoPicture) return { ok: false, reason: "empty" };
    return { ok: false, reason: "failed", message: String(error) };
  }
}
