import type { Clock } from "@ponzu/sandbox";
import type { Fetch } from "./fetch.ts";

/**
 * Tells a design's runner there may be something to claim (docs/cloud.md, "The other way: the
 * poke"): `POST /poke` on the sandbox's public port, with the port's bearer token, carrying
 * nothing. The runner trusts nothing about it and only claims from the API with its own token,
 * so a poke that is lost costs at most the minute until the runner's own claim.
 */
export type Poke = (target: { url: string; token: string }) => Promise<void>;

/** A poke has this long; past it the runner will find the events by itself. */
const TIMEOUT_MS = 5_000;
/**
 * Right after a sandbox starts, its port can answer 502 or 503 for a moment though it has
 * answered once (the spike saw 100 to 250 ms): such answers are tried again for this long.
 */
const RETRY_FOR_MS = 1_000;
const RETRY_EVERY_MS = 150;
const PASSING = new Set([502, 503]);

export function createPoke({ fetch, clock }: { fetch: Fetch; clock: Clock }): Poke {
  return async ({ url, token }) => {
    const until = clock.now() + RETRY_FOR_MS;
    for (;;) {
      const response = await fetch(new URL("/poke", url).toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: clock.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (!PASSING.has(response.status) || clock.now() >= until) {
        throw new Error(`The runner answered a poke with ${response.status}.`);
      }
      await clock.sleep(RETRY_EVERY_MS);
    }
  };
}
