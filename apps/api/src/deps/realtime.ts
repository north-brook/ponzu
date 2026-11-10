import { ApiError } from "../http/errors.ts";

/** A query a client may subscribe to: SQL the API wrote, with the values it bound. */
export interface LiveQuery {
  sql: string;
  params: readonly unknown[];
}

/** What a client hands to Neon Realtime in place of SQL. It cannot be read or changed. */
export interface SealedQuery {
  token: string;
  /** Epoch milliseconds. A client renews before this. */
  expiresAt: number;
}

/**
 * Seals live queries for Neon Realtime, so a client subscribes to exactly what the API
 * authorized and nothing else.
 *
 * INTERFACE ONLY. The live-query module (`POST /v1/live`) owns the real implementation and may
 * reshape this to fit it; until then the deployed API has `realtimeNotBuilt`, and tests have
 * `FakeSealer` (src/testing).
 */
export interface RealtimeSealer {
  seal(query: LiveQuery): Promise<SealedQuery>;
}

export const realtimeNotBuilt: RealtimeSealer = {
  async seal() {
    throw new ApiError(501, "not_implemented", "Ponzu cannot send live updates yet.");
  },
};
