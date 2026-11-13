import { drawCommentPicture as draw, CommentScene as Scene } from "@ponzu/canvas/comment-picture";
import type { Doc } from "@ponzu/core";
import { COMMENT_PICTURE } from "@ponzu/runner/protocol";
import type { ComponentProps } from "react";

/*
 * A comment's picture, as the Mac makes it: the shared scene and drawing (packages/canvas's
 * comment-picture.tsx, which the iPhone's canvas page draws with too) at the runner protocol's
 * `COMMENT_PICTURE` size, written as WebP.
 */

export {
  commentIn,
  hasPictureArea,
  NoPicture,
  type Theme,
} from "@ponzu/canvas/comment-picture";

/** The area round a comment's pin, drawn at the picture's size. */
export function CommentScene(props: Omit<ComponentProps<typeof Scene>, "size">) {
  return <Scene {...props} size={COMMENT_PICTURE} />;
}

/** The picture of where a comment was left, in both themes, as WebP at twice its size. */
export function drawCommentPicture(given: {
  doc: Doc;
  threadId: string;
  messageId: string;
  assetBase?: string | undefined;
}) {
  return draw({ ...given, size: COMMENT_PICTURE, type: "image/webp" });
}
