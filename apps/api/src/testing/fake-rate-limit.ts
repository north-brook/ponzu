import type { Clock } from "@ponzu/sandbox";
import type { RateLimit } from "../deps/rate-limit.ts";
import { RATE_LIMITS, type RateLimitId } from "../http/rate-limits.ts";

/**
 * Rate limits in memory, counting per id and key in fixed windows on the test's clock, the way
 * the firewall's fixed-window rules count. Nothing is limited until a test sets a limit with
 * `limit(id, n)`, so the rest of the suite runs as if limits were off. Every check is recorded,
 * limited or not, in `checks`.
 */
export class FakeRateLimit implements RateLimit {
  /** Every check, oldest first: which id, whose key, and what it answered. */
  readonly checks: { id: RateLimitId; key: string; answer: "ok" | "limited" }[] = [];
  readonly #limits = new Map<RateLimitId, number>();
  readonly #counts = new Map<string, number>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** From now on, `id` lets `n` requests through per key in each of its windows (`RATE_LIMITS`). */
  limit(id: RateLimitId, n: number): void {
    this.#limits.set(id, n);
  }

  async check(id: RateLimitId, key: string): Promise<"ok" | "limited"> {
    const window = Math.floor(this.#clock.now() / (RATE_LIMITS[id].windowSeconds * 1000));
    const counted = `${id}\u0000${key}\u0000${window}`;
    const count = (this.#counts.get(counted) ?? 0) + 1;
    this.#counts.set(counted, count);
    const limit = this.#limits.get(id);
    const answer = limit !== undefined && count > limit ? "limited" : "ok";
    this.checks.push({ id, key, answer });
    return answer;
  }
}
