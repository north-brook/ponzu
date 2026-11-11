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
 * can tell the runner to get ready for sleep. `health` is whether `/health` answers within
 * `timeoutMs`, and if not, what came back instead, which is how the API knows a warm resume
 * brought the runner back, and what its log says when it did not seem to.
 */
export interface RunnerPort {
  report(address: Address): Promise<void>;
  health(address: Address, timeoutMs: number): Promise<HealthCheck>;
}

/**
 * One look at a runner's `/health`. `status` is the HTTP status when anything answered (a
 * redirect is boat's sign-in page: the address's token was not taken), `error` what the request
 * failed with when nothing did (a timeout, a refused connection). Neither carries the token.
 */
export interface HealthCheck {
  ok: boolean;
  status: number | null;
  error: string | null;
  ms: number;
}

export function createRunnerPort({ fetch, clock }: { fetch: Fetch; clock: Clock }): RunnerPort {
  return {
    async report(address) {
      const response = await call(fetch, clock, address, "POST", "/report", TIMEOUT_MS);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`The runner answered a report with ${response.status}.`);
    },
    async health(address, timeoutMs) {
      const began = clock.now();
      const ms = () => clock.now() - began;
      try {
        const response = await call(fetch, clock, address, "GET", "/health", timeoutMs);
        const body = response.ok ? ((await response.json()) as { ok?: unknown }) : null;
        if (!response.ok) await response.body?.cancel();
        const ok = body?.ok === true;
        return {
          ok,
          status: response.status,
          error: ok ? null : response.ok ? "unexpected body" : null,
          ms: ms(),
        };
      } catch (error) {
        const said = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return { ok: false, status: null, error: said.slice(0, 200), ms: ms() };
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
