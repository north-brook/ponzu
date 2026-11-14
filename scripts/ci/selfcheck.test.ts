import { describe, expect, test } from "bun:test";
import { SELFCHECK_IDS } from "../prod/checks/api.ts";
import { judge, KNOWN, selfcheck } from "./selfcheck.ts";

const checks = (failing: Record<string, string> = {}) => ({
  checks: SELFCHECK_IDS.map((id) => ({
    id,
    ok: !(id in failing),
    detail: failing[id] ?? "ok",
  })),
});

describe("judging the selfcheck", () => {
  test("every check passing passes", () => {
    expect(judge("dev", checks())).toEqual({ problems: [], known: [] });
  });

  test("a check known to fail on dev is said and excused, on dev alone", () => {
    const answer = checks({ vault_old_keys: "old_keys" });
    const dev = judge("dev", answer);
    expect(dev.problems).toEqual([]);
    expect(dev.known).toEqual([
      "vault_old_keys (old_keys): values remain sealed with an older vault key; the reseal is owed",
    ]);
    expect(judge("production", answer).problems).toEqual(["vault_old_keys is old_keys"]);
  });

  test("anything else failing fails, and so does an answer with no checks", () => {
    expect(judge("dev", checks({ migrations: "behind", anthropic: "refused" })).problems).toEqual([
      "migrations is behind",
      "anthropic is refused",
    ]);
    expect(judge("dev", { checks: [] }).problems).toEqual(["the answer lists no check"]);
    expect(judge("dev", null).problems).toEqual(["the answer has no checks"]);
  });

  test("only checks the API has are excused", () => {
    for (const ids of Object.values(KNOWN))
      for (const id of Object.keys(ids)) expect(SELFCHECK_IDS as readonly string[]).toContain(id);
  });
});

describe("asking", () => {
  /** A fake API: health says `environment`; the selfcheck answers `answers` in turn. */
  function api(environment: string, answers: { status: number; body: unknown }[]) {
    const asked: { url: string; authorization: string | null }[] = [];
    let n = 0;
    const fetcher = (async (input: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      asked.push({ url: String(input), authorization });
      if (String(input).endsWith("/v1/health"))
        return new Response(JSON.stringify({ environment }), { status: 200 });
      const answer = answers[Math.min(n++, answers.length - 1)]!;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof fetch;
    return { fetcher, asked };
  }
  const clock = () => {
    let now = 0;
    return {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    };
  };

  test("asks again until it passes, sending the secret only to the selfcheck", async () => {
    const { fetcher, asked } = api("dev", [
      { status: 200, body: checks({ cron_fresh: "stale" }) },
      { status: 200, body: checks() },
    ]);
    const result = await selfcheck("https://api-dev.test", "dev", "s3cret", {
      fetch: fetcher,
      ...clock(),
    });
    expect(result.ok).toBe(true);
    expect(asked.filter((a) => a.authorization !== null).map((a) => a.url)).toEqual([
      "https://api-dev.test/v1/cron/selfcheck",
      "https://api-dev.test/v1/cron/selfcheck",
    ]);
    expect(asked.filter((a) => a.url.endsWith("/v1/health")).every((a) => !a.authorization)).toBe(
      true,
    );
  });

  test("never sends the secret to an API that says it is another environment", async () => {
    const { fetcher, asked } = api("production", [{ status: 200, body: checks() }]);
    const result = await selfcheck("https://api-dev.test", "dev", "s3cret", {
      fetch: fetcher,
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['health says "production", not dev']);
    expect(asked.every((a) => a.authorization === null)).toBe(true);
  });

  test("gives up at its deadline, naming what failed", async () => {
    const { fetcher } = api("dev", [{ status: 401, body: {} }]);
    const result = await selfcheck("https://api-dev.test", "dev", "wrong", {
      fetch: fetcher,
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["the selfcheck answered 401"]);
  });
});
