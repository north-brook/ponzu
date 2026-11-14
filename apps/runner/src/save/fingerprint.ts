import { createHash } from "node:crypto";
import { closeSync, openSync, readlinkSync, readSync, type Stats } from "node:fs";

/*
 * A file's part of a cheap fingerprint: its size and modification time, and, when those cannot
 * be trusted, a hash of what it holds.
 *
 * Size and time miss an edit that keeps the size and lands in the same tick of the clock that
 * stamps files (git's "racily clean" files). On Linux that clock is the coarse one, which moves
 * every jiffy (1 to 4 ms, 10 ms at HZ=100) and lags the clock `Date.now()` reads by up to one;
 * some filesystems keep whole seconds (two for FAT). So a write that comes after a fingerprint
 * looked at a file is stamped no earlier than `since - one tick`, where `since` is read before
 * the file is. A file stamped earlier than `since - RACY_MS` therefore cannot be written again
 * with that same time: size and time are enough. Any other file (stamped within the window, or
 * later than `since`, as after the clock steps back) is hashed. A fingerprint that hashed a
 * file and one that did not are never equal, so a file leaving the window costs one more save,
 * never a missed one. Only files written in the last couple of seconds are read, and those are
 * the ones a checkpoint is about to save anyway. What is left is a clock stepped back by more
 * than the window between two fingerprints, then a write in place of the same size landing on
 * the very millisecond of both the modification and the change time the file had before.
 *
 * A file over `MAX_HASH_BYTES` is never read: hashing it on every stamp would cost more than the
 * window is worth (a build output, a video, a database). It goes by size, times and inode alone,
 * marked as such, so it too never equals the fingerprint it gets once it leaves the window: an
 * edit of the same size in the same tick is saved by the stamp after that. Smaller files are
 * read in pieces, never whole into memory.
 */

/** How far before the fingerprint a file's time is too close to trust: many ticks, and a second. */
export const RACY_MS = 2_000;

/** Told of a file too large to hash (`MAX_HASH_BYTES`): its path, as the caller names it, and size. */
export type HashSkipped = (path: string, size: number) => void;

/** The largest file a fingerprint reads to hash. */
export const MAX_HASH_BYTES = 8 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;

/**
 * `stat` (from `lstat`) of the file at `full`, as part of a fingerprint taken at `since`.
 * `skipped` hears of a file that would be hashed but is over `MAX_HASH_BYTES`.
 */
export function fingerprint(
  full: string,
  stat: Stats,
  since: number,
  skipped?: (size: number) => void,
): string {
  // The change time and inode too, as git keeps: a writer that sets the old modification time
  // back (`tar -x`, `cp -p`, `touch -r`, a restore) still moves the change time.
  const cheap = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const newest = Math.max(stat.mtimeMs, stat.ctimeMs);
  if (newest < since - RACY_MS || !(stat.isFile() || stat.isSymbolicLink())) return cheap;
  if (stat.isFile() && stat.size > MAX_HASH_BYTES) {
    skipped?.(stat.size);
    return `${cheap}:large`;
  }
  // Not known to be unchanged: never the same as another fingerprint.
  const unread = `${cheap}:unread:${since}:${Math.random()}`;
  try {
    if (stat.isSymbolicLink())
      return `${cheap}:${createHash("sha1").update(readlinkSync(full)).digest("hex")}`;
    const digest = hashFile(full);
    return digest === null ? unread : `${cheap}:${digest}`;
  } catch {
    return unread;
  }
}

/** The file's SHA-1, read a piece at a time; null when it grew past `MAX_HASH_BYTES`. */
function hashFile(full: string): string | null {
  const hash = createHash("sha1");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = openSync(full, "r");
  try {
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) return hash.digest("hex");
      total += read;
      if (total > MAX_HASH_BYTES) return null;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}
