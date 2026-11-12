import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiUrlOf,
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
    expect(() => apiUrlOf("staging")).toThrow("no apiUrl for staging");
  });
});
