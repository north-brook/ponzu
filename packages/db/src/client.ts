import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * What every query function takes. Any Drizzle Postgres database fits: Neon over HTTP, a pool,
 * a transaction on a pool, or PGlite in tests.
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
