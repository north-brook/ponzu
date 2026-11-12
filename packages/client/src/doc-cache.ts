import type { Doc } from "@ponzu/core";
import type { KeyValueStorage } from "./session.ts";

/**
 * The last few canvases opened, kept on the device so one can be shown, read only, before the
 * API answers or while it can't be reached. Pass a storage meant for size here, not the one
 * holding the session: a canvas can weigh megabytes, and a keychain holds kilobytes.
 */
export interface CachedCanvas {
  canvasId: string;
  name: string;
  doc: Doc;
  seq: number;
  assetsUrl: string;
}

const INDEX_KEY = "ponzu.docs";
const docKey = (canvasId: string) => `ponzu.doc.${canvasId}`;

export class DocCache {
  /** Writes one at a time, so two canvases saved together cannot lose each other from the index. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: KeyValueStorage,
    /** How many canvases to keep. */
    private readonly limit = 8,
  ) {}

  async read(canvasId: string): Promise<CachedCanvas | null> {
    try {
      const saved = await this.storage.get(docKey(canvasId));
      return saved ? (JSON.parse(saved) as CachedCanvas) : null;
    } catch {
      return null;
    }
  }

  /** Keep `canvas` as the most recently opened, and forget the oldest past the limit. */
  write(canvas: CachedCanvas): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        const index = await this.index();
        const kept = [canvas.canvasId, ...index.filter((id) => id !== canvas.canvasId)];
        await this.storage.set(docKey(canvas.canvasId), JSON.stringify(canvas));
        await this.storage.set(INDEX_KEY, JSON.stringify(kept.slice(0, this.limit)));
        for (const id of kept.slice(this.limit)) await this.storage.delete(docKey(id));
      } catch {
        // A cache: the canvas is still on the API.
      }
    });
    return this.writing;
  }

  private async index(): Promise<string[]> {
    const saved = await this.storage.get(INDEX_KEY);
    return saved ? (JSON.parse(saved) as string[]) : [];
  }
}
