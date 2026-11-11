import type { Clock } from "@ponzu/sandbox";
import type { Fetch } from "./fetch.ts";

/**
 * Tells a design's runner there may be something to claim (docs/cloud.md, "The other way: poke
 * and health"): `POST /poke` through the sandbox's token-gated address, carrying nothing. The
 * runner trusts nothing about it and only claims from the API with its own token, so a poke
 * that is lost costs at most the minute until the runner's own claim.
 */
export type Poke = (address: { url: string; token: string | null }) => Promise<void>;

/** A poke has this long; past it the runner will find the events by itself. */
const TIMEOUT_MS = 5_000;

export function createPoke({ fetch, clock }: { fetch: Fetch; clock: Clock }): Poke {
  return async ({ url, token }) => {
    const response = await fetch(new URL("/poke", url).toString(), {
      method: "POST",
      // boat.dev opens a port's address to the bearer of its token in this cookie
      // (`BoatProvider.address` hands out the same header).
      headers: token ? { cookie: `_port_auth=${token}` } : {},
      signal: clock.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The runner answered a poke with ${response.status}.`);
  };
}
