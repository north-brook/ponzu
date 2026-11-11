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
  return async (address) => {
    const response = await call(fetch, clock, address, "POST", "/poke", TIMEOUT_MS);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The runner answered a poke with ${response.status}.`);
  };
}

type Address = Parameters<Poke>[0];

/**
 * The runner's other two doors (docs/cloud.md, "The other way: poke and health"). `report` asks
 * it for a state report now: it carries nothing either, and only the API's answer to that report
 * can tell the runner to get ready for sleep. `healthy` is whether `/health` answers within
 * `timeoutMs`, which is how the API knows a warm resume brought the runner back.
 */
export interface RunnerPort {
  report(address: Address): Promise<void>;
  healthy(address: Address, timeoutMs: number): Promise<boolean>;
}

export function createRunnerPort({ fetch, clock }: { fetch: Fetch; clock: Clock }): RunnerPort {
  return {
    async report(address) {
      const response = await call(fetch, clock, address, "POST", "/report", TIMEOUT_MS);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`The runner answered a report with ${response.status}.`);
    },
    async healthy(address, timeoutMs) {
      try {
        const response = await call(fetch, clock, address, "GET", "/health", timeoutMs);
        const body = response.ok ? ((await response.json()) as { ok?: unknown }) : null;
        if (!response.ok) await response.body?.cancel();
        return body?.ok === true;
      } catch {
        return false;
      }
    },
  };
}

function call(
  fetch: Fetch,
  clock: Clock,
  { url, token }: Address,
  method: string,
  path: string,
  timeoutMs: number,
): Promise<Response> {
  return fetch(new URL(path, url).toString(), {
    method,
    // boat.dev opens a port's address to the bearer of its token in this cookie
    // (`BoatProvider.address` hands out the same header). A redirect is boat's sign-in page.
    headers: token ? { cookie: `_port_auth=${token}` } : {},
    redirect: "manual",
    signal: clock.timeout(timeoutMs),
  });
}
