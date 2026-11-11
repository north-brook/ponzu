import type { Doc } from "@ponzu/core";
import type { KeyValueStorage } from "./session.ts";

/**
 * The last few designs opened, kept on the device so one can be shown, read only, before the
 * API answers or while it can't be reached. Pass a storage meant for size here, not the one
 * holding the session: a design can weigh megabytes, and a keychain holds kilobytes.
 */
export interface CachedDesign {
  designId: string;
  name: string;
  doc: Doc;
  seq: number;
  assetsUrl: string;
}

const INDEX_KEY = "ponzu.docs";
const docKey = (designId: string) => `ponzu.doc.${designId}`;

export class DocCache {
  /** Writes one at a time, so two designs saved together cannot lose each other from the index. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: KeyValueStorage,
    /** How many designs to keep. */
    private readonly limit = 8,
  ) {}

  async read(designId: string): Promise<CachedDesign | null> {
    try {
      const saved = await this.storage.get(docKey(designId));
      return saved ? (JSON.parse(saved) as CachedDesign) : null;
    } catch {
      return null;
    }
  }

  /** Keep `design` as the most recently opened, and forget the oldest past the limit. */
  write(design: CachedDesign): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        const index = await this.index();
        const kept = [design.designId, ...index.filter((id) => id !== design.designId)];
        await this.storage.set(docKey(design.designId), JSON.stringify(design));
        await this.storage.set(INDEX_KEY, JSON.stringify(kept.slice(0, this.limit)));
        for (const id of kept.slice(this.limit)) await this.storage.delete(docKey(id));
      } catch {
        // A cache: the design is still on the API.
      }
    });
    return this.writing;
  }

  private async index(): Promise<string[]> {
    const saved = await this.storage.get(INDEX_KEY);
    return saved ? (JSON.parse(saved) as string[]) : [];
  }
}
