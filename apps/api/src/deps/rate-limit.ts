/*
 * Per-caller rate limits, through Vercel's firewall with Vercel's own SDK (@vercel/firewall,
 * pinned exactly). This is the only file that imports the SDK (rate-limit.surface.test.ts holds
 * it to that). Which route counts against which id, and by whose key, is http/rate-limits.ts;
 * each id's window and limit are a rule in Vercel's firewall, which is what holds in a
 * deployment. RATE_LIMITS states the same numbers so the fake counts to them.
 *
 * It is off, as `noRateLimit`, unless PONZU_RATE_LIMITS is `vercel` and the API runs on Vercel
 * (`VERCEL=1`): off Vercel there is no firewall to ask. On, it fails open. A check that times out
 * (500 ms), throws, finds no rule for its id, or is refused by the firewall itself answers "ok"
 * and logs `rate_limit_unavailable`: a firewall that cannot answer must never lock people out.
 *
 * What may be logged: the id and why the check failed, never the key, the request's headers or
 * the SDK's own error text.
 */

import type { Clock } from "@ponzu/sandbox";
import { checkRateLimit } from "@vercel/firewall";
import type { Logger } from "../http/log.ts";
import type { RateLimitId } from "../http/rate-limits.ts";

export interface RateLimit {
  /**
   * Counts one request against `id` for `key` (a person's or a canvas's id) and says whether it
   * is over the limit. Never throws: a check that cannot be made answers "ok".
   */
  check(id: RateLimitId, key: string, request: Request): Promise<"ok" | "limited">;
}

/** How long one check may take before it is given up and the request goes through. */
export const RATE_LIMIT_TIMEOUT_MS = 500;

/** Rate limits while they are off: every request goes through, and nothing is asked. */
export const noRateLimit: RateLimit = {
  check: async () => "ok",
};

/** The SDK's call, as a test may hand in its own. */
export type CheckRateLimit = typeof checkRateLimit;

export interface VercelRateLimitConfig {
  clock: Clock;
  log: Logger;
  /** The SDK's `checkRateLimit` unless a test hands in its own. */
  check?: CheckRateLimit;
  /**
   * Where the SDK asks when NODE_ENV is not `production`, which it otherwise refuses to do (it
   * answers "not limited" without asking). Only tests set it; on Vercel NODE_ENV is production
   * and the SDK asks the request's own host.
   */
  developmentHost?: string;
}

/**
 * Why a check was given up. `timeout`: no answer in `RATE_LIMIT_TIMEOUT_MS`. `failed`: the SDK
 * threw (the network, or a status it does not know). `not_found`: no firewall rule has this id.
 * `blocked`: the firewall refused the check itself, which says nothing about this caller.
 */
export type RateLimitFailure = "timeout" | "failed" | "not_found" | "blocked";

/** Rate limits through the Vercel firewall. */
export function createVercelRateLimit({
  clock,
  log,
  check = checkRateLimit,
  developmentHost,
}: VercelRateLimitConfig): RateLimit {
  const unavailable = (id: RateLimitId, reason: RateLimitFailure) => {
    log.warn("rate_limit_unavailable", { limit: id, reason });
    return "ok" as const;
  };

  return {
    async check(id, key, request) {
      const deadline = clock.timeout(RATE_LIMIT_TIMEOUT_MS);
      let answer: Awaited<ReturnType<CheckRateLimit>> | "timeout";
      try {
        answer = await first(
          check(id, {
            rateLimitKey: key,
            headers: forwarded(request.headers),
            timeout: RATE_LIMIT_TIMEOUT_MS,
            ...(developmentHost === undefined
              ? {}
              : { firewallHostForDevelopment: developmentHost }),
          }),
          deadline,
        );
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        return unavailable(id, timedOut ? "timeout" : "failed");
      }
      if (answer === "timeout") return unavailable(id, "timeout");
      if (answer.error === "not-found") return unavailable(id, "not_found");
      if (answer.error === "blocked") return unavailable(id, "blocked");
      return answer.rateLimited ? "limited" : "ok";
    },
  };
}

/** The rate limits a deployment runs with: Vercel's only when switched on and on Vercel. */
export function selectRateLimit(
  { mode, onVercel }: { mode: "off" | "vercel"; onVercel: boolean },
  config: VercelRateLimitConfig,
): RateLimit {
  return mode === "vercel" && onVercel ? createVercelRateLimit(config) : noRateLimit;
}

/**
 * The headers the firewall needs, and no others. The SDK copies every header it is handed onto
 * its own request (as `x-rr-<name>`), and a person's bearer token or a runner's has no business
 * there. It needs the host (where the firewall answers) and the client's address.
 */
const FORWARDED = ["host", "x-forwarded-for", "x-real-ip"] as const;

function forwarded(headers: Headers): Headers {
  const kept = new Headers();
  for (const name of FORWARDED) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}

/** `work`'s answer, or "timeout" once `deadline` aborts. The SDK's own timeout stops its fetch. */
function first<T>(work: Promise<T>, deadline: AbortSignal): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const expire = () => resolve("timeout");
    if (deadline.aborted) return expire();
    deadline.addEventListener("abort", expire, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener("abort", expire);
        resolve(value);
      },
      (error) => {
        deadline.removeEventListener("abort", expire);
        reject(error);
      },
    );
  });
}
