// A real Postgres for the *.live.test.ts files. PGlite is one connection, so its races take
// turns and its planner never sees a table go from empty to busy; those tests need the real
// thing. Not exported from the package.
import { describe } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createDb, createPooledDb, type Db } from "./client.ts";

/**
 * A migrated database the tests may fill and empty, named by PONZU_TEST_DATABASE_URL. They
 * claim every job in it, so it has to be one that nothing else uses.
 */
const url = process.env.PONZU_TEST_DATABASE_URL;

export interface LiveDb {
  db: Db;
  close(): Promise<void>;
}

/**
 * `describe`, once for each driver that can reach the database, every one with several
 * connections so that statements really run at once. Neon is reached the two ways the API
 * reaches it. Any other Postgres, like the one in CI, is reached with node-postgres, which is
 * what Neon's pool is underneath. With no database the tests are listed as skipped.
 */
export function describeLive(name: string, tests: (live: LiveDb) => void): void {
  if (!url) {
    describe.skip(name, () => tests({ db: undefined as never, close: async () => {} }));
    return;
  }
  const { hostname, pathname } = new URL(url);
  if (!pathname.includes("test")) {
    throw new Error(
      `PONZU_TEST_DATABASE_URL names the database "${pathname.slice(1)}". The live tests empty tables, so they only run on one with "test" in its name.`,
    );
  }
  if (hostname.endsWith(".neon.tech")) {
    const pooled = createPooledDb(url);
    // Each call over HTTP is its own request, and so its own connection.
    describe(`${name} over neon-http`, () => tests({ db: createDb(url), close: async () => {} }));
    describe(`${name} over neon-serverless`, () =>
      tests({ db: pooled, close: () => pooled.$client.end() }));
    return;
  }
  const client = new pg.Pool({ connectionString: url, max: 12 });
  describe(`${name} over node-postgres`, () =>
    tests({ db: drizzle({ client }), close: () => client.end() }));
}
