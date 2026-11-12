import type { Doc } from "@ponzu/core";

/** A canvas's document as this instance last built it. */
export interface CachedDoc {
  seq: number;
  /** Shared by everyone who reads the cache: never change it, change a `structuredClone`. */
  doc: Doc;
  /** What has been committed since the last checkpoint this instance knows of. */
  sinceCheckpoint: { ops: number; bytes: number };
}

/**
 * The documents one function instance has built lately, by canvas, as of a seq. Instances
 * share nothing, so an entry is only ever a starting point: whoever reads it catches up from
 * the log before trusting it (`readCurrentDoc`), and a commit made against it is gated on its
 * seq in the database. It holds the most recently used `capacity` canvases.
 */
export class DocCache {
  readonly #entries = new Map<string, CachedDoc>();

  constructor(readonly capacity = 32) {}

  get(canvasId: string): CachedDoc | undefined {
    const entry = this.#entries.get(canvasId);
    if (entry) {
      // Most recently used goes last, so the first key is the one to drop.
      this.#entries.delete(canvasId);
      this.#entries.set(canvasId, entry);
    }
    return entry;
  }

  /** Keeps `entry` unless a newer one is already held. */
  set(canvasId: string, entry: CachedDoc): void {
    const held = this.#entries.get(canvasId);
    if (held && held.seq > entry.seq) return;
    this.#entries.delete(canvasId);
    this.#entries.set(canvasId, entry);
    if (this.#entries.size > this.capacity) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }

  delete(canvasId: string): void {
    this.#entries.delete(canvasId);
  }
}
