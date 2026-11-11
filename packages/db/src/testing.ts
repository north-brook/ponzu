import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client.ts";
import { migrationsFolder } from "./migrations.ts";
import { events } from "./schema/index.ts";

// Starting an empty Postgres and migrating it takes about half a second; loading a copy of one
// that is already migrated takes a tenth of that. So the first database made in a process is
// copied before anything is written to it, and every later one starts from that copy.
let migrated: Promise<Blob | File> | undefined;

/**
 * A fresh Postgres in this process with every migration applied, for tests. It needs no network
 * and shares nothing with any other database this returns. Close it with `db.$client.close()`.
 */
export async function createTestDb() {
  if (migrated) return drizzle({ client: new PGlite({ loadDataDir: await migrated }) });
  const client = new PGlite();
  const db = drizzle({ client });
  migrated = migrate(db, { migrationsFolder }).then(() => client.dumpDataDir("none"));
  await migrated;
  return db;
}

/**
 * A design's whole feed, oldest first, whatever has been claimed or delivered: what a test
 * looks at to see which events something added. (A runner reads it through `claimEvents`.)
 */
export function feedOf(db: Db, designId: string) {
  return db.select().from(events).where(eq(events.designId, designId)).orderBy(events.seq);
}
