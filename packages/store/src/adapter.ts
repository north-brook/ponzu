import type { FileBag } from "./format.ts";

/**
 * Where a .design's bytes live. Paths are relative to the design root and
 * always use forward slashes.
 */
export interface StorageAdapter {
  /** Every text file in the design (json, css, md, html). */
  readAll(): Promise<FileBag>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  readAsset(path: string): Promise<Uint8Array | null>;
  writeAsset(path: string, bytes: Uint8Array): Promise<void>;
  listAssets(): Promise<string[]>;
  /** Report outside changes. Returns a stop function. */
  watch?(onChange: (paths: string[]) => void): () => void;
  /** Absolute folder on disk, when there is one. */
  readonly root?: string;
}

/** In-memory storage, for tests and embedded hosts that keep their own state. */
export class MemoryAdapter implements StorageAdapter {
  files: FileBag;
  assets = new Map<string, Uint8Array>();
  private listeners = new Set<(paths: string[]) => void>();

  constructor(files: FileBag = {}) {
    this.files = { ...files };
  }

  async readAll(): Promise<FileBag> {
    return { ...this.files };
  }

  async write(path: string, content: string): Promise<void> {
    this.files[path] = content;
  }

  async remove(path: string): Promise<void> {
    delete this.files[path];
    this.assets.delete(path);
  }

  async readAsset(path: string): Promise<Uint8Array | null> {
    return this.assets.get(path) ?? null;
  }

  async writeAsset(path: string, bytes: Uint8Array): Promise<void> {
    this.assets.set(path, bytes);
  }

  async listAssets(): Promise<string[]> {
    return [...this.assets.keys()];
  }

  watch(onChange: (paths: string[]) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  /** Simulate an outside edit. */
  async externalWrite(path: string, content: string | null): Promise<void> {
    if (content === null) delete this.files[path];
    else this.files[path] = content;
    for (const l of this.listeners) l([path]);
  }
}
