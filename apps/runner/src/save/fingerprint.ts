import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, type Stats } from "node:fs";

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
 */

/** How far before the fingerprint a file's time is too close to trust: many ticks, and a second. */
export const RACY_MS = 2_000;

/** `stat` (from `lstat`) of the file at `full`, as part of a fingerprint taken at `since`. */
export function fingerprint(full: string, stat: Stats, since: number): string {
  // The change time and inode too, as git keeps: a writer that sets the old modification time
  // back (`tar -x`, `cp -p`, `touch -r`, a restore) still moves the change time.
  const cheap = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const newest = Math.max(stat.mtimeMs, stat.ctimeMs);
  if (newest < since - RACY_MS || !(stat.isFile() || stat.isSymbolicLink())) return cheap;
  try {
    const content = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
    return `${cheap}:${createHash("sha1").update(content).digest("hex")}`;
  } catch {
    // Not known to be unchanged: never the same as another fingerprint.
    return `${cheap}:unread:${since}:${Math.random()}`;
  }
}
