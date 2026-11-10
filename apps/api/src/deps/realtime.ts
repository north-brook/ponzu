import { createRealtime, rawSql } from "@neon/realtime/server";

/** A query a client may subscribe to: SQL the API wrote, with the values it bound. */
export interface LiveQuery {
  sql: string;
  params: readonly string[];
}

/**
 * What a client hands to Neon Realtime in place of SQL (`client.subscribe(sealed)`), as Neon's
 * SDK makes it. It cannot be read or changed, and it is a bearer credential for its lifetime:
 * never log it.
 */
export interface SealedQuery {
  capability: string;
  /** The same for every seal of the same SQL and values, which is what lets a client renew. */
  queryFingerprint: string;
  /** Epoch milliseconds, 60 seconds after sealing. A client renews before this. */
  expiresAt: number;
}

/**
 * Seals live queries for Neon Realtime, so a client subscribes to exactly what the API
 * authorized and nothing else. Realtime has no row-level security: the SQL sealed is the
 * access control, so only the live-query registry (`live/queries.ts`) writes it.
 */
export interface RealtimeSealer {
  /** Where clients subscribe: the Realtime endpoint of the database's branch. */
  url: string;
  seal(query: LiveQuery): Promise<SealedQuery>;
}

/**
 * The real sealer. Sealing is local encryption with the branch's Realtime secret and makes no
 * request. `database` is the Postgres database the queries run in.
 */
export function createRealtimeSealer({
  url,
  secret,
  database,
}: {
  url: string;
  secret: string;
  database: string;
}): RealtimeSealer {
  const realtime = createRealtime({ secret, db: database });
  return {
    url,
    async seal({ sql, params }) {
      const { capability, queryFingerprint, expiresAt } = await realtime.seal({
        query: rawSql(sql, params),
      });
      return { capability, queryFingerprint, expiresAt };
    },
  };
}
