import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client.ts";
import { migrationsFolder } from "./migrations.ts";
import { events } from "./schema/index.ts";

// Starting an empty Postgres costs a second or more of CPU (initdb), and migrating it more;
// loading a copy of one already made costs a fraction of that. Test files may each run in
// their own process, so two copies are kept on disk, one empty and one migrated, named for the
// migrations and the code that made them (see cacheKey): the first process to need one makes it
// once, and every other one, in this run or a later one, loads it. Each database is still its
// own, made fresh from that copy.
//
// Making a copy must not happen inside a test: under load, with every worker starting at once,
// initdb alone has taken longer than bun's five seconds for a hook. So `bun test` preloads
// test-preload.ts (bunfig.toml), which calls prepareTestDbs before any test file loads, and a
// test only ever loads a copy. Without the preload (`bun test` run from another directory) the
// first test to ask makes it, as before.
const copies: Partial<Record<Copy, Promise<Blob>>> = {};

type Copy = "empty" | "migrated";

function copy(kind: Copy): Promise<Blob> {
  copies[kind] ??= savedCopy(kind);
  return copies[kind];
}

/**
 * Makes sure the empty and the migrated copy are on disk, and the migrated one, which most test
 * files use, loaded in this process, so no test waits on initdb or on the migrations. The test
 * preload calls it before any test runs. The empty copy, some 40 MB, is read only by a process
 * that asks for it; making the migrated one makes it first.
 */
export async function prepareTestDbs(): Promise<void> {
  await copy("migrated");
  if (!existsSync(copyFile("empty"))) await copy("empty");
}

function copyFile(kind: Copy): string {
  return join(tmpdir(), "ponzu-test-db", `${cacheKey()}-${kind}.tar`);
}

/**
 * A fresh Postgres in this process with every migration applied, for tests. It needs no network
 * and shares nothing with any other database this returns. Close it with `db.$client.close()`.
 */
export async function createTestDb() {
  return drizzle({ client: new PGlite({ loadDataDir: await copy("migrated"), extensions }) });
}

/**
 * A fresh Postgres in this process with nothing in it, as `new PGlite({ extensions })` makes but
 * without running initdb, for a test that builds a schema itself. Close it with `close()`.
 */
export async function createEmptyTestDb(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await copy("empty"), extensions });
}

/**
 * The Postgres extensions the migrations create, which PGlite must be given to load: pg_trgm,
 * for search's trigram index. Neon and the Postgres 18 in CI ship it.
 */
export const extensions = { pg_trgm };

/**
 * A canvas's whole feed, oldest first, whatever has been claimed or delivered: what a test
 * looks at to see which events something added. (A runner reads it through `claimEvents`.)
 */
export function feedOf(db: Db, canvasId: string) {
  return db.select().from(events).where(eq(events.canvasId, canvasId)).orderBy(events.seq);
}

/** How long a process waits on another that is making the copy before making its own. */
const LOCK_PATIENCE_MS = 60_000;

/** A data directory, as a tarball PGlite loads: from disk, or made and saved. */
async function savedCopy(kind: Copy): Promise<Blob> {
  const file = copyFile(kind);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    const saved = read(file);
    if (saved) return saved;
    if (take(lock)) {
      try {
        // Another process may have saved it between the read above and taking the lock.
        const raced = read(file);
        if (raced) return raced;
        const made = await make(kind);
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, new Uint8Array(await made.arrayBuffer()));
        renameSync(temporary, file);
        return made;
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    // A lock left by a process that was killed while making the copy is cleared for the next
    // one to take; and a process that has waited long enough makes its own rather than wait on.
    if (lockAge(lock) > LOCK_PATIENCE_MS) rmSync(lock, { recursive: true, force: true });
    if (Date.now() - started > LOCK_PATIENCE_MS) return make(kind);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The empty copy is initdb's; the migrated one starts from it, so initdb runs once. */
async function make(kind: Copy): Promise<Blob> {
  const client =
    kind === "empty"
      ? new PGlite({ extensions })
      : new PGlite({ loadDataDir: await copy("empty"), extensions });
  try {
    // dumpDataDir does not wait for initdb to finish, and on a Postgres still starting it never
    // returns; a query does wait.
    await client.waitReady;
    if (kind === "migrated") await migrate(drizzle({ client }), { migrationsFolder });
    return await client.dumpDataDir("none");
  } finally {
    await client.close();
  }
}

/** The saved copy, or nothing when there is none yet. A rename puts it there whole. */
function read(file: string): Blob | undefined {
  if (!existsSync(file)) return undefined;
  return new Blob([readFileSync(file)]);
}

/** Takes the lock if no one holds it: making a directory either succeeds or finds one there. */
function take(lock: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  }
}

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * What the copy depends on: the PGlite that made it, the drizzle that migrated it, this file
 * (how it was made), and every migration file's path and contents.
 */
function cacheKey(): string {
  const hash = createHash("sha256");
  for (const name of ["@electric-sql/pglite", "drizzle-orm"]) {
    const manifest = fileURLToPath(import.meta.resolve(`${name}/package.json`));
    hash.update(`${name} ${JSON.parse(readFileSync(manifest, "utf8")).version}\n`);
  }
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  const files = readdirSync(migrationsFolder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const path of files) {
    hash.update(`${relative(migrationsFolder, path)}\n`);
    hash.update(readFileSync(path));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 24);
}
