import { type FSWatcher, watch as fsWatch } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { StorageAdapter } from "./adapter.ts";
import type { FileBag } from "./format.ts";

const TEXT = /\.(json|css|md|html)$/;

/** A .design folder on the local disk, with a recursive watcher. */
export class FsAdapter implements StorageAdapter {
  constructor(readonly root: string) {}

  async readAll(): Promise<FileBag> {
    const bag: FileBag = {};
    for (const rel of await this.list()) {
      if (!TEXT.test(rel) || rel.startsWith("assets/")) continue;
      if (!isDesignText(rel)) continue;
      bag[rel] = await readFile(join(this.root, rel), "utf8");
    }
    return bag;
  }

  async write(path: string, content: string): Promise<void> {
    const abs = join(this.root, path);
    await mkdir(dirname(abs), { recursive: true });
    // Write then rename, so watchers and other readers never see half a file.
    const tmp = `${abs}.ponzu-${process.pid}-${Date.now().toString(36)}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);
  }

  async remove(path: string): Promise<void> {
    const abs = join(this.root, path);
    await rm(abs, { force: true });
    // Tidy up a page folder left empty.
    const dir = dirname(abs);
    if (dir !== this.root && dir.startsWith(join(this.root, "pages"))) {
      try {
        await rmdir(dir);
      } catch {}
    }
  }

  async readAsset(path: string): Promise<Uint8Array | null> {
    const abs = this.resolveInside(path);
    if (!abs) return null;
    try {
      return new Uint8Array(await readFile(abs));
    } catch {
      return null;
    }
  }

  async writeAsset(path: string, bytes: Uint8Array): Promise<void> {
    const abs = this.resolveInside(path);
    if (!abs) throw new Error(`Asset path escapes the design: ${path}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }

  async listAssets(): Promise<string[]> {
    return (await this.list()).filter((p) => p.startsWith("assets/"));
  }

  watch(onChange: (paths: string[]) => void): () => void {
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const paths = [...pending];
      pending = new Set();
      if (paths.length) onChange(paths);
    };
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(this.root, { recursive: true }, (_event, file) => {
        if (!file) return;
        const rel = String(file).split(sep).join("/");
        if (rel.includes(".ponzu-") || rel.startsWith(".")) return;
        pending.add(rel);
        if (!timer) timer = setTimeout(flush, 60);
      });
    } catch {
      return () => {};
    }
    return () => {
      watcher.close();
      if (timer) clearTimeout(timer);
    };
  }

  /** Resolve a relative path, refusing anything that leaves the root. */
  resolveInside(path: string): string | null {
    const abs = join(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || rel === "" || rel.includes(`..${sep}`)) return null;
    return abs;
  }

  private async list(dir = this.root, out: string[] = []): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await this.list(abs, out);
      else out.push(relative(this.root, abs).split(sep).join("/"));
    }
    return out;
  }
}

function isDesignText(rel: string): boolean {
  return (
    rel === "design.json" ||
    rel === "tokens.css" ||
    rel === "comments.json" ||
    /^notes\/[^/]+\.md$/.test(rel) ||
    /^pages\/[^/]+\/[^/]+\.html$/.test(rel)
  );
}

export async function isDesignFolder(path: string): Promise<boolean> {
  try {
    const s = await stat(join(path, "design.json"));
    return s.isFile();
  } catch {
    return false;
  }
}
