import type { Attachment, PendingAttachment } from "../cloud/model.ts";
import { mutate, type StorePonzu } from "./store-ponzu.ts";

/*
 * The images on their way into the next message of one canvas. Each uploads straight to
 * storage the moment it is added (the API's presign, PUT and complete), showing a local picture
 * of itself meanwhile; one that fails can be tried again. Sending takes the uploaded ones.
 */

interface Upload extends PendingAttachment {
  file: File;
  /** Once uploaded: the canvas's file it became. */
  done: Attachment | null;
}

export class Uploads {
  private list: Upload[] = [];
  /** Local pictures of images sent, which their bubbles show until the thread has them. */
  private sent: string[] = [];
  private snapshot: PendingAttachment[] = [];
  private readonly listeners = new Set<() => void>();
  private ids = 0;

  constructor(
    private readonly opts: {
      ponzu: StorePonzu;
      canvasId: string;
      /** A local picture of a file: an object URL in the browser. */
      preview?: (file: File) => string;
      release?: (url: string) => void;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PendingAttachment[] => this.snapshot;

  add(files: File[]): void {
    const preview = this.opts.preview ?? ((file: File) => URL.createObjectURL(file));
    const added = files.map(
      (file): Upload => ({
        id: `att_${++this.ids}`,
        name: file.name,
        previewUrl: preview(file),
        status: "uploading",
        file,
        done: null,
      }),
    );
    this.list = [...this.list, ...added];
    this.emit();
    for (const upload of added) void this.upload(upload.id);
  }

  remove(id: string): void {
    const gone = this.list.find((u) => u.id === id);
    this.list = this.list.filter((u) => u.id !== id);
    if (gone) this.release(gone.previewUrl);
    this.emit();
  }

  retry(id: string): void {
    if (this.list.find((u) => u.id === id)?.status !== "failed") return;
    this.set(id, { status: "uploading" });
    void this.upload(id);
  }

  /**
   * The uploaded images, for the message being sent, shown in its bubble by their local
   * pictures until the thread has them; the field is left empty for the next.
   */
  take(): Attachment[] {
    const ready = this.list.flatMap((u) => (u.done ? [{ ...u.done, url: u.previewUrl }] : []));
    this.sent.push(...ready.map((a) => a.url));
    this.list = this.list.filter((u) => !u.done);
    this.emit();
    return ready;
  }

  /** Lets go of every local picture. */
  close(): void {
    for (const url of [...this.list.map((u) => u.previewUrl), ...this.sent]) this.release(url);
    this.list = [];
    this.sent = [];
    this.listeners.clear();
  }

  private async upload(id: string): Promise<void> {
    const upload = this.list.find((u) => u.id === id);
    if (!upload) return;
    try {
      const bytes = new Uint8Array(await upload.file.arrayBuffer());
      const { ponzu, canvasId } = this.opts;
      const stored = await mutate(ponzu, ponzu.mutations.upload(), {
        canvasId,
        file: { name: upload.file.name, type: upload.file.type, bytes },
      });
      if (!stored.ref) throw new Error("The upload has no reference.");
      this.set(id, {
        status: "ready",
        done: { ref: stored.ref, url: stored.url, contentType: upload.file.type },
      });
    } catch {
      this.set(id, { status: "failed" });
    }
  }

  private set(id: string, change: Partial<Upload>): void {
    this.list = this.list.map((u) => (u.id === id ? { ...u, ...change } : u));
    this.emit();
  }

  private release(url: string): void {
    (this.opts.release ?? ((u: string) => URL.revokeObjectURL(u)))(url);
  }

  private emit(): void {
    this.snapshot = this.list.map(({ id, name, previewUrl, status }) => ({
      id,
      name,
      previewUrl,
      status,
    }));
    for (const listener of this.listeners) listener();
  }
}
