import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiUrlOf,
  BYPASS_HEADER,
  bypassHeaders,
  differences,
  type Expected,
  expectedFromCheckout,
  waitForHealth,
} from "./health.ts";

const ROOT = join(import.meta.dir, "../..");
const EXPECTED: Expected = {
  environment: "production",
  commit: "abc123",
  image: "ponzu-runner@sha256:1",
  migrations: 28,
};
const HEALTHY = {
  status: "ok",
  version: "2.0.0",
  commit: "abc123",
  environment: "production",
  image: "ponzu-runner@sha256:1",
  runnerBundle: "0123456789ab",
  migrations: { applied: 28, expected: 28 },
  database: true,
};

describe("the health assert", () => {
  test("what was deployed passes", () => {
    expect(differences(HEALTHY, EXPECTED)).toEqual([]);
  });

  test("each difference is named", () => {
    expect(
      differences(
        {
          ...HEALTHY,
          status: "degraded",
          environment: "dev",
          commit: "old",
          image: "ponzu-runner@sha256:0",
          migrations: { applied: 27, expected: 28 },
        },
        EXPECTED,
      ),
    ).toEqual([
      'status is "degraded", not "ok"',
      'environment is "dev", not "production"',
      'commit is "old", not "abc123"',
      'image is "ponzu-runner@sha256:0", not "ponzu-runner@sha256:1"',
      "migrations.applied is 27, not 28",
    ]);
    expect(
      differences({ ...HEALTHY, migrations: { applied: null, expected: 27 } }, EXPECTED),
    ).toEqual(["migrations.expected is 27, not 28", "migrations.applied is null, not 28"]);
    expect(differences(null, EXPECTED)).toEqual(["the answer is not JSON"]);
  });

  test("it polls until the new deployment answers, with no real waiting", async () => {
    const answers = [{ ...HEALTHY, commit: "old" }, { ...HEALTHY, commit: "old" }, HEALTHY];
    let t = 0;
    const urls: string[] = [];
    const result = await waitForHealth("https://api.example/", EXPECTED, {
      fetch: (async (url: string) => {
        urls.push(url);
        return Response.json(answers.shift());
      }) as unknown as typeof fetch,
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(urls).toEqual(Array(3).fill("https://api.example/v1/health"));
  });

  test("it gives up at the deadline with the last differences", async () => {
    let t = 0;
    let calls = 0;
    const result = await waitForHealth("https://api.example", EXPECTED, {
      fetch: (async () => {
        calls++;
        if (calls === 1) throw new Error("connection refused");
        return Response.json({ ...HEALTHY, environment: "dev" });
      }) as unknown as typeof fetch,
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
      intervalMs: 10_000,
      deadlineMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['environment is "dev", not "production"']);
    // At 0, 10, … 60 seconds: one more wait would pass the deadline.
    expect(calls).toBe(7);
    expect(t).toBe(60_000);
  });

  test("what is expected comes from this checkout", () => {
    const current = JSON.parse(readFileSync(join(ROOT, "apps/runner/image/current.json"), "utf8"));
    const journal = JSON.parse(
      readFileSync(join(ROOT, "packages/db/migrations/meta/_journal.json"), "utf8"),
    );
    expect(expectedFromCheckout("dev", "sha")).toEqual({
      environment: "dev",
      commit: "sha",
      image: current.image,
      migrations: journal.entries.length,
    });
    expect(apiUrlOf("production")).toBe("https://api.ponzu.design");
    expect(apiUrlOf("dev")).toBe("https://api-dev.ponzu.design");
    expect(() => apiUrlOf("staging")).toThrow("no apiUrl for staging");
  });
});

describe("the protection bypass for a staged deployment", () => {
  const STAGED = "https://ponzu-abc123-northbrook.vercel.app";

  test("sends the secret only to a generated vercel.app address", () => {
    expect(bypassHeaders(STAGED, "s3cret")).toEqual({ headers: { [BYPASS_HEADER]: "s3cret" } });
    expect(BYPASS_HEADER).toBe("x-vercel-protection-bypass");
    for (const url of [
      "https://api.ponzu.design",
      "https://api-dev.ponzu.design",
      "http://ponzu-abc123-northbrook.vercel.app",
      "https://evil.example/ponzu-abc123-northbrook.vercel.app",
      "https://ponzu-abc123-northbrook.vercel.app.evil.example",
      "not a url",
    ])
      expect(bypassHeaders(url, "s3cret")).toHaveProperty("error");
  });

  test("refuses to run without the secret, rather than reading a login page", () => {
    for (const secret of [undefined, ""]) {
      const result = bypassHeaders(STAGED, secret);
      expect(result).toEqual({
        error:
          "VERCEL_AUTOMATION_BYPASS_SECRET is empty: the production environment must hold it to check a staged deployment.",
      });
    }
  });

  test("the poll sends the headers it is given", async () => {
    const seen: (string | null)[] = [];
    const redirects: (RequestRedirect | undefined)[] = [];
    const result = await waitForHealth(STAGED, EXPECTED, {
      headers: { [BYPASS_HEADER]: "s3cret" },
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get(BYPASS_HEADER));
        redirects.push(init?.redirect);
        return Response.json(HEALTHY);
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["s3cret"]);
    // Never follows a redirect with the secret on it.
    expect(redirects).toEqual(["manual"]);
  });

  test("a redirect with the bypass on is a failure, not followed", async () => {
    const asked: string[] = [];
    let clock = 0;
    const result = await waitForHealth(STAGED, EXPECTED, {
      headers: { [BYPASS_HEADER]: "s3cret" },
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example/sso" },
        });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(asked.every((u) => u === `${STAGED}/v1/health`)).toBe(true);
  });

  test("the command fails, naming the secret, when it is missing", async () => {
    // Awaited, never spawnSync, which can lose the child's exit in a `bun test --parallel` worker.
    const run = Bun.spawn(
      ["bun", join(ROOT, "scripts/ci/health.ts"), "--env", "production", "--commit", "abc"].concat([
        "--url",
        STAGED,
        "--bypass",
      ]),
      {
        env: { PATH: process.env.PATH ?? "", VERCEL_AUTOMATION_BYPASS_SECRET: "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, , code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("VERCEL_AUTOMATION_BYPASS_SECRET is empty");
  });
});
