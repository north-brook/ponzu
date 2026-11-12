import { afterEach, expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { createLogger, type LogLine } from "../http/log.ts";
import {
  type CheckRateLimit,
  createVercelRateLimit,
  noRateLimit,
  RATE_LIMIT_TIMEOUT_MS,
  selectRateLimit,
} from "./rate-limit.ts";

const logs: LogLine[] = [];
const log = createLogger((line) => logs.push(line));
afterEach(() => {
  logs.length = 0;
});

const request = () =>
  new Request("https://api.test/v1/canvases", {
    method: "POST",
    headers: {
      host: "api.test",
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7",
      authorization: "Bearer a-person-s-access-token",
      cookie: "session=a-cookie",
    },
  });

/** An SDK call that answers what it is told, and records what it was asked. */
function scripted(answer: () => ReturnType<CheckRateLimit>) {
  const asked: Parameters<CheckRateLimit>[] = [];
  const check: CheckRateLimit = (...args) => {
    asked.push(args);
    return answer();
  };
  return { asked, check };
}

const unavailable = () =>
  logs
    .filter((line) => line.event === "rate_limit_unavailable")
    .map(({ limit, reason }) => ({
      limit,
      reason,
    }));

test("off, nothing is asked and every request goes through", async () => {
  const sdk = scripted(async () => ({ rateLimited: true }));
  for (const [mode, onVercel] of [
    ["off", false],
    ["off", true],
    // Switched on, but not on Vercel: there is no firewall to ask.
    ["vercel", false],
  ] as const) {
    const limits = selectRateLimit(
      { mode, onVercel },
      { clock: new FakeClock(), log, check: sdk.check },
    );
    expect(limits).toBe(noRateLimit);
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
  }
  expect(sdk.asked).toEqual([]);
});

test("on Vercel and switched on, the firewall's answer is the answer", async () => {
  let limited = false;
  const sdk = scripted(async () => ({ rateLimited: limited }));
  const limits = selectRateLimit(
    { mode: "vercel", onVercel: true },
    { clock: new FakeClock(), log, check: sdk.check },
  );
  expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
  limited = true;
  expect(await limits.check("messages", "usr_2", request())).toBe("limited");

  expect(sdk.asked.map(([id, options]) => [id, options?.rateLimitKey, options?.timeout])).toEqual([
    ["canvas-creates", "usr_1", RATE_LIMIT_TIMEOUT_MS],
    ["messages", "usr_2", RATE_LIMIT_TIMEOUT_MS],
  ]);
  // Only what the firewall needs goes with the check: never the bearer token or a cookie.
  const headers = sdk.asked[0]![1]!.headers as Headers;
  expect([...headers.keys()].sort()).toEqual(["host", "x-forwarded-for", "x-real-ip"]);
  expect(logs).toEqual([]);
});

test("a check with no answer in 500 ms lets the request through, logged", async () => {
  const clock = new FakeClock();
  const sdk = scripted(() => new Promise(() => {}));
  const limits = createVercelRateLimit({ clock, log, check: sdk.check });
  const answer = limits.check("canvas-creates", "usr_1", request());
  clock.advance(RATE_LIMIT_TIMEOUT_MS - 1);
  let settled = false;
  void answer.then(() => {
    settled = true;
  });
  // Let every queued callback run, so an answer already on its way would have arrived.
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  clock.advance(1);
  expect(await answer).toBe("ok");
  expect(unavailable()).toEqual([{ limit: "canvas-creates", reason: "timeout" }]);
});

test("the SDK's own timeout, a throw, a missing rule and a refused check all fail open", async () => {
  const cases: [() => ReturnType<CheckRateLimit>, string][] = [
    [
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      "timeout",
    ],
    [
      async () => {
        throw new Error("Unexpected rate-limit API response status 'canvas-creates': 500");
      },
      "failed",
    ],
    [async () => ({ rateLimited: false, error: "not-found" }), "not_found"],
    // The firewall refused the check itself; that says nothing about this caller.
    [async () => ({ rateLimited: true, error: "blocked" }), "blocked"],
  ];
  for (const [answer, reason] of cases) {
    const limits = createVercelRateLimit({
      clock: new FakeClock(),
      log,
      check: scripted(answer).check,
    });
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
    expect(unavailable().at(-1)).toEqual({ limit: "canvas-creates", reason });
  }
  // The SDK's words are never logged: they can name the host and the status, nothing of use.
  expect(JSON.stringify(logs)).not.toContain("Unexpected");
});

test("the real SDK asks the firewall's rate-limit API with the id and a hashed key", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  let status = 204;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(null, { status });
  }) as typeof fetch;
  try {
    // The SDK refuses to ask anything outside NODE_ENV=production unless told where; a
    // deployment never sets this, and the SDK then asks the request's own host.
    const limits = createVercelRateLimit({
      clock: new FakeClock(),
      log,
      developmentHost: "ignore-for-testing",
    });
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
    status = 429;
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("limited");
    status = 404;
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
    expect(unavailable()).toEqual([{ limit: "canvas-creates", reason: "not_found" }]);
    status = 500;
    expect(await limits.check("canvas-creates", "usr_1", request())).toBe("ok");
    expect(unavailable().at(-1)).toEqual({ limit: "canvas-creates", reason: "failed" });
  } finally {
    globalThis.fetch = real;
  }

  expect(seen[0]!.url).toBe("https://api.test/.well-known/vercel/rate-limit-api/canvas-creates");
  expect(seen[0]!.headers.get("x-vercel-rate-limit-api")).toBe("canvas-creates");
  expect(seen[0]!.headers.get("x-vercel-rate-limit-key")).toMatch(/^usr_1-[0-9a-f]{64}$/);
  // The person's token and cookies never leave with the check.
  const sent = seen.flatMap(({ headers }) => [...headers.values()]).join("\n");
  expect(sent).not.toContain("a-person-s-access-token");
  expect(sent).not.toContain("a-cookie");
});
