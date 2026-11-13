import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, type Stats, truncateSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, MAX_HASH_BYTES, RACY_MS } from "./fingerprint.ts";

/*
 * The hash cap: a file written in the last moments is hashed only up to `MAX_HASH_BYTES`, read a
 * piece at a time; a larger one goes by size, times and inode alone, and the caller hears of it.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function file(bytes: number | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-fingerprint-"));
  dirs.push(dir);
  const path = join(dir, "f");
  if (typeof bytes === "string") await writeFile(path, bytes);
  else {
    // Sparse: as large as asked without writing it.
    await writeFile(path, "");
    truncateSync(path, bytes);
  }
  return path;
}

const cheap = (stat: Stats) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
const sha1 = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

test("a recent file under the cap is hashed as before", async () => {
  const path = await file("<h1>Hi</h1>\n");
  const stat = lstatSync(path);
  const skipped: number[] = [];
  expect(fingerprint(path, stat, Date.now(), (size) => skipped.push(size))).toBe(
    `${cheap(stat)}:${sha1("<h1>Hi</h1>\n")}`,
  );
  expect(skipped).toEqual([]);
});

test("a recent file of exactly the cap is still hashed, in pieces, to the same digest", async () => {
  const path = await file(MAX_HASH_BYTES);
  const stat = lstatSync(path);
  const skipped: number[] = [];
  expect(fingerprint(path, stat, Date.now(), (size) => skipped.push(size))).toBe(
    `${cheap(stat)}:${sha1(Buffer.alloc(MAX_HASH_BYTES))}`,
  );
  expect(skipped).toEqual([]);
});

test("a recent file over the cap is never read: size, times and inode alone, and said", async () => {
  const path = await file(MAX_HASH_BYTES + 1);
  const stat = lstatSync(path);
  // Gone after the stat: any attempt to read it would fail, and the fingerprint would say
  // `unread`. It says `large`, so nothing opened it.
  unlinkSync(path);
  const skipped: number[] = [];
  const print = fingerprint(path, stat, Date.now(), (size) => skipped.push(size));
  expect(print).toBe(`${cheap(stat)}:large`);
  expect(skipped).toEqual([MAX_HASH_BYTES + 1]);
  // The same each time, so a large file that does not change does not make a checkpoint, and
  // never the same as the fingerprint it gets once it leaves the window: one more save, at most.
  expect(fingerprint(path, stat, Date.now())).toBe(print);
  expect(fingerprint(path, stat, Date.now() + RACY_MS * 10)).toBe(cheap(stat));
});

test("a file under the cap that grew past it while being read is never the same twice", async () => {
  const path = await file("small");
  const stat = lstatSync(path);
  truncateSync(path, MAX_HASH_BYTES + 5);
  const one = fingerprint(path, stat, Date.now());
  const two = fingerprint(path, stat, Date.now());
  expect(one).toContain(":unread:");
  expect(one).not.toBe(two);
});

test("an older file is never read, whatever its size, and nothing is said", async () => {
  const path = await file(MAX_HASH_BYTES + 1);
  const stat = lstatSync(path);
  const skipped: number[] = [];
  expect(fingerprint(path, stat, Date.now() + RACY_MS * 10, (size) => skipped.push(size))).toBe(
    cheap(stat),
  );
  expect(skipped).toEqual([]);
});
