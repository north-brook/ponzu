import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "./migrations.ts";

// Starting an empty Postgres and migrating it takes about half a second; loading a copy of one
// that is already migrated takes a tenth of that. So the first call builds a template and every
// call, the first included, starts from a copy of it.
let template: Promise<Blob | File> | undefined;

/**
 * A fresh Postgres in this process with every migration applied, for tests. It needs no network
 * and shares nothing with any other database this returns. Close it with `db.$client.close()`.
 */
export async function createTestDb() {
  template ??= migratedDataDir();
  return drizzle({ client: new PGlite({ loadDataDir: await template }) });
}

async function migratedDataDir() {
  const client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder });
  const dataDir = await client.dumpDataDir("none");
  await client.close();
  return dataDir;
}
