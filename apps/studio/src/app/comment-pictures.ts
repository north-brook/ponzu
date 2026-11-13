/*
 * The pictures of the comments the viewer leaves on one canvas's boards: shared with the iPhone,
 * in @ponzu/client/canvas (packages/client/src/canvas/comment-pictures.ts). The Mac draws them
 * in its own window as WebP (comment-picture.tsx).
 */
export {
  CommentPictures,
  type CommentPicturesOptions,
  commentsIn,
  type LocalPicture,
  type PictureTheme as Theme,
} from "@ponzu/client/canvas";
