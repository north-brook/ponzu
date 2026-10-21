import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivedAt, CatalogDb, SCHEMA } from "./catalog-db.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-db-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the last of archive and revive written wins, whichever process writes it", () => {
  const file = join(dir, "race.db");
  const a = new CatalogDb(file);
  const b = new CatalogDb(file);
  a.seen([["/x.design", "spotlight"]], 1);
  a.archive("/x.design", 10);
  expect(archivedAt(a.get("/x.design"))).toBe(10);
  // Written after the archive, even stamped earlier (the same millisecond, a slow clock).
  b.revive("/x.design", 10);
  expect(archivedAt(a.get("/x.design"))).toBeNull();
  // And an archive written after that, stamped the same millisecond, wins back.
  a.archive("/x.design", 10);
  expect(archivedAt(b.get("/x.design"))).not.toBeNull();
  a.archive("/x.design", 30);
  expect(archivedAt(b.get("/x.design"))).toBe(30);
  // Found again later doesn't touch what the person did.
  b.seen([["/x.design", "walk"]], 40);
  expect(archivedAt(a.get("/x.design"))).toBe(30);
  a.close();
  b.close();
});

test("another process's write moves data_version; reading doesn't", () => {
  const file = join(dir, "version.db");
  const a = new CatalogDb(file);
  const b = new CatalogDb(file);
  const v = a.dataVersion();
  expect(a.dataVersion()).toBe(v);
  b.archive("/y.design");
  expect(a.dataVersion()).not.toBe(v);
  const w = a.dataVersion();
  a.revive("/y.design");
  expect(a.dataVersion()).not.toBe(w);
  a.close();
  b.close();
});

test("missing designs are hidden, found again, and forgotten after a while", () => {
  const db = new CatalogDb(join(dir, "missing.db"));
  db.seen([["/gone.design", "walk"]], 1);
  db.missing(["/gone.design"], 2);
  expect(db.get("/gone.design")?.missing_since).toBe(2);
  db.seen([["/gone.design", "walk"]], 3);
  expect(db.get("/gone.design")?.missing_since).toBeNull();
  db.missing(["/gone.design"], 4);
  db.forget(5);
  expect(db.get("/gone.design")).toBeUndefined();
  db.close();
});

test("a database from a newer Ponzu is used while this build can read it, and read-only past that", () => {
  const file = join(dir, "newer.db");
  new CatalogDb(file).close();
  // A newer build added a column and still lets this one read and write.
  const raw = new Database(file);
  raw.exec("ALTER TABLE designs ADD COLUMN pinned_at INTEGER");
  raw.exec(`PRAGMA user_version = ${SCHEMA + 1}`);
  raw.close();
  const newer = new CatalogDb(file);
  expect(newer.readOnly).toBe(false);
  newer.archive("/z.design", 1);
  expect(archivedAt(newer.get("/z.design"))).toBe(1);
  newer.close();
  // Then one that this build would misread.
  const raw2 = new Database(file);
  raw2.exec("UPDATE meta SET value = '99' WHERE key = 'min_reader'");
  raw2.close();
  const tooNew = new CatalogDb(file);
  expect(tooNew.readOnly).toBe(true);
  tooNew.revive("/z.design", 2);
  expect(archivedAt(tooNew.get("/z.design"))).toBe(1);
  tooNew.close();
});

test("an unreadable database is moved aside and started over", async () => {
  const file = join(dir, "corrupt.db");
  await writeFile(file, "this is not a database, just some bytes that look nothing like one");
  const db = new CatalogDb(file);
  db.seen([["/a.design", "walk"]]);
  expect(db.all().map((r) => r.path)).toEqual(["/a.design"]);
  expect(readdirSync(dir).some((f) => f.startsWith("corrupt.db.corrupt-"))).toBe(true);
  db.close();
});

test("two processes recovering the same unreadable database don't crash or move each other's", async () => {
  const file = join(dir, "both-corrupt.db");
  await writeFile(file, "not a database either, just bytes that look nothing like one at all");
  const a = new CatalogDb(file);
  const b = new CatalogDb(file);
  a.seen([["/a.design", "walk"]]);
  // The first moved it and started over; the second found it started and opened it.
  expect(b.all().map((r) => r.path)).toEqual(["/a.design"]);
  a.close();
  b.close();
});

test("two processes starting at once both end up on the current schema", () => {
  const file = join(dir, "together.db");
  const a = new CatalogDb(file);
  const b = new CatalogDb(file);
  a.seen([["/one.design", "walk"]]);
  b.seen([["/two.design", "walk"]]);
  expect(
    a
      .all()
      .map((r) => r.path)
      .sort(),
  ).toEqual(["/one.design", "/two.design"]);
  expect(existsSync(`${file}-wal`)).toBe(true);
  a.close();
  b.close();
});
