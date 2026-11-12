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
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client.ts";
import { migrationsFolder } from "./migrations.ts";
import { events } from "./schema/index.ts";

// Starting an empty Postgres and migrating it costs a few seconds of CPU (most of it initdb);
// loading a copy of one that is already migrated costs a fraction of that. Test files each run
// in their own process, so the copy is kept on disk, named for the migrations and the code
// that made it (see cacheKey): the first process to need it makes it once, and every other one, in this run
// or a later one, loads it. Each database is still its own, made fresh from that copy.
let migrated: Promise<Blob> | undefined;

/**
 * A fresh Postgres in this process with every migration applied, for tests. It needs no network
 * and shares nothing with any other database this returns. Close it with `db.$client.close()`.
 */
export async function createTestDb() {
  migrated ??= migratedCopy();
  return drizzle({ client: new PGlite({ loadDataDir: await migrated }) });
}

/**
 * A canvas's whole feed, oldest first, whatever has been claimed or delivered: what a test
 * looks at to see which events something added. (A runner reads it through `claimEvents`.)
 */
export function feedOf(db: Db, canvasId: string) {
  return db.select().from(events).where(eq(events.canvasId, canvasId)).orderBy(events.seq);
}

/** How long a process waits on another that is making the copy before making its own. */
const LOCK_PATIENCE_MS = 60_000;

/** The migrated data directory, as a tarball PGlite loads: from disk, or made and saved. */
async function migratedCopy(): Promise<Blob> {
  const dir = join(tmpdir(), "ponzu-test-db");
  const file = join(dir, `${cacheKey()}.tar`);
  mkdirSync(dir, { recursive: true });
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
        const made = await migrateFresh();
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
    if (Date.now() - started > LOCK_PATIENCE_MS) return migrateFresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function migrateFresh(): Promise<Blob> {
  const client = new PGlite();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
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
