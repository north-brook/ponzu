import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `data` to `path` so that it is on the disk when this returns: whole, to a file beside
 * it that is flushed and then moved over it, with the folder flushed too. A sandbox's disk is
 * kept across a stop, but what was still in memory is not after a cold one: a file written
 * without this can come back as it was before.
 */
export function writeDurably(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const next = `${path}.next`;
  const fd = openSync(next, "w", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, path);
  const folder = openSync(dir, "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}
