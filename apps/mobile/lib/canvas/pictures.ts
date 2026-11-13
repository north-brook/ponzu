import { type Api, type Clock, systemClock } from "@ponzu/client";
import { CommentPictures, type LocalPicture } from "@ponzu/client/canvas";
import type { Doc, Op, Origin } from "@ponzu/core";
import type { PictureAnswer, ToCanvas } from "../../canvas/protocol";

/*
 * The pictures of the comments and replies the person sends from this phone (iPhone design
 * slice 12), as the Mac makes them (@ponzu/client/canvas `CommentPictures`): each is drawn the
 * moment its op is made, uploaded, and attached to its thread item once the API has the comment,
 * so everyone's thread shows where it was left. The canvas page draws them (canvas/picture.ts),
 * as PNG, since WebKit's canvas can't write WebP; this side asks for them, and the files come
 * back as base64 over the web view's bridge. Nothing about sending a comment waits on its
 * picture or fails with it: one that can't be drawn or kept is let go of, and the comment reads
 * "On <place>" in the thread, as one from before pictures does.
 *
 * Pure, over the page's messages: tested in bun with a fake page.
 */

/** How long the page may take to draw a picture, both themes, before the comment goes without. */
export const PAGE_MS = 30_000;

/** There is nothing round the comment's pin to show: it goes without a picture, by design. */
export class NoPicture extends Error {
  override name = "NoPicture";
  constructor() {
    super("There is nothing round the comment's pin to show.");
  }
}

type Files = { light: string; dark: string };

/**
 * Asks the canvas page for comments' pictures and hears its answers, by an id of each ask's own.
 * `post` reaches the page, holding what it says until the page is ready (CanvasHandle.post).
 */
export class PicturePage {
  private n = 0;
  private readonly waiting = new Map<
    string,
    { resolve: (files: Files) => void; reject: (error: Error) => void; cancel: () => void }
  >();

  constructor(
    private readonly post: (msg: ToCanvas) => void,
    private readonly clock: Pick<Clock, "schedule"> = systemClock,
  ) {}

  /** The comment's picture in both themes, as base64 PNG; rejects when the page can't draw it. */
  draw = ({ threadId, messageId }: { threadId: string; messageId: string }): Promise<Files> => {
    const id = `pic_${++this.n}`;
    return new Promise<Files>((resolve, reject) => {
      const cancel = this.clock.schedule(() => {
        this.waiting.delete(id);
        reject(new Error("The canvas took too long to draw the comment's picture."));
      }, PAGE_MS);
      this.waiting.set(id, { resolve, reject, cancel });
      this.post({ t: "picture", id, threadId, messageId });
    });
  };

  /** The page's answer to an ask. Answers to no ask (an old page's, a remount's) are dropped. */
  heard(answer: PictureAnswer): void {
    const ask = this.waiting.get(answer.id);
    if (!ask) return;
    this.waiting.delete(answer.id);
    ask.cancel();
    if ("light" in answer) ask.resolve({ light: answer.light, dark: answer.dark });
    else if ("none" in answer) ask.reject(new NoPicture());
    else ask.reject(new Error(answer.failed));
  }

  /** Lets every ask go: the screen is leaving. */
  close(): void {
    for (const [id, ask] of this.waiting) {
      ask.cancel();
      ask.reject(new Error("The canvas closed."));
      this.waiting.delete(id);
    }
  }
}

/** A base64 string's bytes. */
export function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A picture the page drew, as an address the thread can show at once. */
export const previewOf = (base64: string) => `data:image/png;base64,${base64}`;

/**
 * The pictures of the person's own comments on one canvas, drawn by its page and kept as PNG.
 * `start()` it once the canvas is open; its snapshot is the local pictures by message id, for
 * the thread to show (`ThreadContext.pictures`).
 */
export function phonePictures(opts: {
  canvasId: string;
  meId: string;
  source: {
    onOp(listener: (op: Op, origin: Origin, doc: Doc) => void): () => void;
    saved(): Promise<void>;
    assetBase?: string | undefined;
  };
  api: Pick<Api["canvases"], "uploadCommentPicture" | "attachCommentPicture">;
  page: PicturePage;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Hears why a picture couldn't be drawn or kept; quiet unless given. */
  warn?: (what: string, error: unknown) => void;
}): CommentPictures<string> {
  return new CommentPictures<string>({
    canvasId: opts.canvasId,
    meId: opts.meId,
    source: opts.source,
    api: opts.api,
    format: "png",
    draw: ({ threadId, messageId }) => opts.page.draw({ threadId, messageId }),
    bytes: async (base64) => bytesOf(base64),
    preview: previewOf,
    // A data address holds nothing to let go of.
    release: () => {},
    warn: opts.warn ?? (() => {}),
    ...(opts.wait ? { wait: opts.wait } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export type { LocalPicture };
