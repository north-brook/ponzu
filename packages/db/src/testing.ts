import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "./migrations.ts";

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
