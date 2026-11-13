import type { Doc, Op, Origin } from "@ponzu/core";
import type { CommentPictureFormat } from "@ponzu/runner/protocol";
import type { Api } from "../api.ts";
import { ApiError } from "../errors.ts";
import type { LocalPicture } from "../model/thread-map.ts";

/*
 * The pictures of the comments the viewer leaves on one canvas's boards. Each comment or reply
 * they send is drawn the moment it reaches the document (`draw`, from the document as it is
 * then), and given to its thread item once the API has it: uploaded straight to storage, then
 * attached once the comment's op is committed. The comment goes as it always has; nothing about
 * sending it waits on its picture, or fails with it.
 *
 * Meanwhile, and after, this viewer's own pictures are shown from here: that one is being drawn
 * (the Mac's rail keeps its place), then the files themselves, so the thread has a comment's
 * picture as soon as it has the comment. One that can't be drawn,
 * kept or attached is let go of, and the comment reads as everyone else sees it.
 *
 * The Mac draws in its own window, as WebP Blobs (apps/studio/src/app/canvas.tsx). The iPhone
 * asks its canvas page, which writes PNG and hands back the bytes (apps/mobile/lib/canvas/
 * pictures.ts): `format`, `bytes`, `preview` and `release` say how each holds its files.
 */

/** Only what the viewer sends from here now is drawn: not a comment an undo or redo puts back. */
const FRESH_MS = 60_000;
/** Tries at attaching a picture whose comment isn't in the thread yet, and the wait between. */
const ATTACH_TRIES = 5;
const ATTACH_WAIT_MS = 1_500;

export type Theme = "light" | "dark";

/** A comment of the viewer's, by its message id: its picture being drawn, or drawn. */
export type { LocalPicture };

export interface CommentPicturesOptions<File = Blob> {
  canvasId: string;
  /** The person viewing: their comments are the ones drawn. */
  meId: string;
  source: {
    onOp(listener: (op: Op, origin: Origin, doc: Doc) => void): () => void;
    /** Resolves once the edits made so far have been answered. */
    saved(): Promise<void>;
    assetBase?: string | undefined;
  };
  api: Pick<Api["canvases"], "uploadCommentPicture" | "attachCommentPicture">;
  /** Draws a comment's picture in both themes (`drawCommentPicture`). */
  draw: (comment: {
    doc: Doc;
    threadId: string;
    messageId: string;
    assetBase?: string | undefined;
  }) => Promise<Record<Theme, File>>;
  /**
   * Whether a comment can have a picture at all (`hasPictureArea`), asked before it is drawn so
   * one that can't shows as a comment without one from the start. Every comment can, unless said.
   */
  drawable?: (comment: { doc: Doc; threadId: string; messageId: string }) => boolean;
  /** What `draw` writes: WebP (the Mac's, unless said) or PNG (the iPhone's). */
  format?: CommentPictureFormat;
  /** A drawn file's bytes, to upload. A Blob's, unless said. */
  bytes?: (file: File) => Promise<Uint8Array>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** A local address for a picture: an object URL in the browser, unless said. */
  preview?: (file: File) => string;
  release?: (url: string) => void;
  /** Hears why a picture couldn't be drawn or kept (never its bytes). `console.warn` unless said. */
  warn?: (what: string, error: unknown) => void;
}

export class CommentPictures<File = Blob> {
  private pictures = new Map<string, LocalPicture>();
  private snapshot: ReadonlyMap<string, LocalPicture> = new Map();
  private readonly listeners = new Set<() => void>();
  /** One picture drawn at a time, in the order the comments were sent. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private off: () => void = () => {};
  /**
   * The comments being drawn, kept or shown from here, by message id, with their thread's id: a
   * comment deleted meanwhile is let go of (`cancel`), and nothing more of it is drawn or kept.
   */
  private readonly pending = new Map<string, string>();

  constructor(private readonly opts: CommentPicturesOptions<File>) {}

  start(): this {
    this.off = this.opts.source.onOp((op, origin, doc) => {
      for (const gone of deletionsIn(op)) this.cancel(gone);
      if (origin.kind !== "user" || origin.id !== this.opts.meId) return;
      const now = (this.opts.now ?? Date.now)();
      for (const said of commentsIn(op)) {
        if (now - said.createdAt > FRESH_MS || this.pictures.has(said.messageId)) continue;
        const comment = { doc, threadId: said.threadId, messageId: said.messageId };
        if (this.opts.drawable && !this.opts.drawable(comment)) continue;
        this.take(doc, said.threadId, said.messageId);
      }
    });
    return this;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadonlyMap<string, LocalPicture> => this.snapshot;

  /** Stops drawing and lets go of every local picture. */
  close(): void {
    this.closed = true;
    this.off();
    for (const picture of this.pictures.values()) this.releaseOf(picture);
    this.pictures.clear();
    this.pending.clear();
    this.listeners.clear();
  }

  private take(doc: Doc, threadId: string, messageId: string): void {
    this.pending.set(messageId, threadId);
    this.set(messageId, { state: "drawing", doc, threadId });
    this.queue = this.queue.then(() => this.make(doc, threadId, messageId));
  }

  /** A comment, or a whole thread, deleted: its pictures are let go of, drawn or not. */
  private cancel(gone: { threadId?: string; messageId?: string }): void {
    for (const [messageId, threadId] of [...this.pending]) {
      if (messageId === gone.messageId || threadId === gone.threadId) this.drop(messageId);
    }
  }

  private warn(what: string, error: unknown): void {
    (this.opts.warn ?? ((w, e) => console.warn(`[ponzu] ${w}:`, e)))(what, error);
  }

  private async make(doc: Doc, threadId: string, messageId: string): Promise<void> {
    if (this.closed || !this.pending.has(messageId)) return;
    const { api, canvasId, source } = this.opts;
    let files: Record<Theme, File>;
    try {
      files = await this.opts.draw({ doc, threadId, messageId, assetBase: source.assetBase });
    } catch (error) {
      if (!(error instanceof Error && error.name === "NoPicture")) {
        this.warn("a comment's picture couldn't be drawn", error);
      }
      return this.drop(messageId);
    }
    if (this.closed || !this.pending.has(messageId)) return;
    const preview =
      this.opts.preview ?? ((file: File) => URL.createObjectURL(file as unknown as Blob));
    this.set(messageId, { state: "drawn", light: preview(files.light), dark: preview(files.dark) });
    // Everything from here is in the background: the next comment's picture is drawn meanwhile.
    void (async () => {
      try {
        if (!this.pending.has(messageId)) return;
        const bytes =
          this.opts.bytes ??
          (async (file: File) => new Uint8Array(await (file as unknown as Blob).arrayBuffer()));
        const light = await bytes(files.light);
        const dark = await bytes(files.dark);
        const format = this.opts.format ?? "webp";
        const uploads = await api.uploadCommentPicture(
          canvasId,
          messageId,
          { light, dark },
          format,
        );
        await source.saved();
        await this.attach(messageId, uploads);
        this.pending.delete(messageId);
      } catch (error) {
        this.warn("a comment's picture couldn't be kept", error);
        this.drop(messageId);
      }
    })();
  }

  /** Attaches the uploads to the comment, asking again while its op is still on its way. */
  private async attach(messageId: string, uploads: string[]): Promise<void> {
    const wait = this.opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let tried = 1; ; tried++) {
      if (this.closed || !this.pending.has(messageId)) return;
      try {
        await this.opts.api.attachCommentPicture(this.opts.canvasId, messageId, uploads);
        return;
      } catch (error) {
        const notYet = error instanceof ApiError && error.status === 404;
        if (!(notYet || (error instanceof ApiError && error.transient)) || tried >= ATTACH_TRIES) {
          throw error;
        }
        await wait(ATTACH_WAIT_MS * tried);
      }
    }
  }

  private drop(messageId: string): void {
    this.pending.delete(messageId);
    const picture = this.pictures.get(messageId);
    if (!picture) return;
    this.pictures.delete(messageId);
    this.releaseOf(picture);
    this.emit();
  }

  private set(messageId: string, picture: LocalPicture): void {
    if (this.closed) return;
    const was = this.pictures.get(messageId);
    if (was) this.releaseOf(was);
    this.pictures.set(messageId, picture);
    this.emit();
  }

  private releaseOf(picture: LocalPicture): void {
    if (picture.state !== "drawn") return;
    const release = this.opts.release ?? ((url: string) => URL.revokeObjectURL(url));
    release(picture.light);
    release(picture.dark);
  }

  private emit(): void {
    this.snapshot = new Map(this.pictures);
    for (const listener of this.listeners) listener();
  }
}

/** The threads and comments an op deletes. */
export function deletionsIn(op: Op): { threadId?: string; messageId?: string }[] {
  if (op.op === "batch") return op.ops.flatMap(deletionsIn);
  if (op.op === "thread.delete") return [{ threadId: op.id }];
  if (op.op === "thread.unmessage") return [{ messageId: op.messageId }];
  return [];
}

/** The comments and replies an op says, as their thread, message and when they were written. */
export function commentsIn(op: Op): { threadId: string; messageId: string; createdAt: number }[] {
  if (op.op === "batch") return op.ops.flatMap(commentsIn);
  if (op.op === "thread.create") {
    const [first] = op.thread.messages;
    return first
      ? [{ threadId: op.thread.id, messageId: first.id, createdAt: first.createdAt }]
      : [];
  }
  if (op.op === "thread.message") {
    return [{ threadId: op.id, messageId: op.message.id, createdAt: op.message.createdAt }];
  }
  return [];
}
