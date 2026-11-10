import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * What every query function takes: Neon over HTTP, Neon's pool, or a transaction on that pool.
 *
 * The type admits any Drizzle Postgres database, but drivers differ in how they send json and
 * in what a raw statement hands back, and the queries are only known to work on the ones the
 * tests run them on: those two, PGlite, and node-postgres, which is how CI and `db:migrate`
 * reach a plain Postgres. Bun's own client and postgres-js are known not to: both encode a
 * json parameter a second time, so the commit fails and a jsonb column is stored as a string.
 */
export type Db = PgDatabase<PgQueryResultHKT>;

/**
 * Neon over HTTP: no connection to open or keep, which is what a function instance wants.
 * It has no interactive transactions, so every query function in this package is one statement.
 */
export function createDb(url: string) {
  return drizzleHttp({ client: neon(url) });
}

/**
 * A pool of connections, for the rare handler that needs to read, decide and write inside one
 * transaction. Pass Neon's pooled URL. The pool is `$client` on what this returns; the caller
 * closes it. It speaks Postgres over a WebSocket, which Node 22 and Bun have built in.
 */
export function createPooledDb(url: string) {
  return drizzlePool({ client: new Pool({ connectionString: url }) });
}
