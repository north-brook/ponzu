import { describe, expect, test } from "bun:test";
import { restored, serving, servingProblem } from "./production.ts";

const PROJECT = "prj_api";
const OLD = "b".repeat(40);
const deployment = (over: Record<string, unknown> = {}) => ({
  id: "dpl_1",
  url: "ponzu-api-old123.vercel.app",
  projectId: PROJECT,
  target: "production",
  readyState: "READY",
  ...over,
});
const health = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("the deployment to go back to", () => {
  test("is this project's ready production build, at its generated address", () => {
    expect(servingProblem(deployment(), PROJECT)).toBeNull();
    expect(servingProblem(deployment({ projectId: "prj_other" }), PROJECT)).toContain("project");
    expect(servingProblem(deployment({ target: null }), PROJECT)).toBe("it is a preview build");
    expect(servingProblem(deployment({ target: "dev" }), PROJECT)).toBe("it is a dev build");
    expect(servingProblem(deployment({ readyState: "ERROR" }), PROJECT)).toBe("it is ERROR");
    expect(servingProblem(deployment({ url: "api.ponzu.design" }), PROJECT)).toContain("address");
    expect(servingProblem(null, PROJECT)).not.toBeNull();
  });

  test("is read for the production domain, with the commit production answers", async () => {
    const hosts: string[] = [];
    const result = await serving("https://api.ponzu.design", PROJECT, {
      deployment: async (host) => {
        hosts.push(host);
        return deployment();
      },
      fetch: health({ commit: OLD, status: "ok" }),
    });
    expect(hosts).toEqual(["api.ponzu.design"]);
    expect(result).toEqual({ url: "https://ponzu-api-old123.vercel.app", commit: OLD });
  });

  test("is refused when Vercel or health can't say, so nothing is promoted without a way back", async () => {
    const failing = await serving("https://api.ponzu.design", PROJECT, {
      deployment: async () => {
        throw new Error("403");
      },
      fetch: health({ commit: OLD }),
    });
    expect(failing).toEqual({
      error: "Vercel did not say which deployment serves api.ponzu.design: 403",
    });
    const noCommit = await serving("https://api.ponzu.design", PROJECT, {
      deployment: async () => deployment(),
      fetch: health({ commit: null }),
    });
    expect(noCommit).toEqual({ error: "https://api.ponzu.design/v1/health names no commit." });
    const preview = await serving("https://api.ponzu.design", PROJECT, {
      deployment: async () => deployment({ target: null }),
      fetch: health({ commit: OLD }),
    });
    expect("error" in preview).toBe(true);
  });
});

describe("after the promotion back", () => {
  const clock = () => {
    let now = 0;
    return {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    };
  };
  const ok = { commit: OLD, status: "ok", database: true, environment: "production" };

  test("production answers the old commit, healthy, whatever its migration count", async () => {
    // The old code expects fewer migrations than the database has: expand only allows that.
    const answer = { ...ok, migrations: { expected: 31, applied: 32 } };
    expect(await restored("https://api.ponzu.design", OLD, health(answer), clock())).toEqual({
      ok: true,
      problem: null,
    });
  });

  test("waits for the domain to move, and fails at its deadline naming what it saw", async () => {
    let n = 0;
    const moving = (async () =>
      new Response(
        JSON.stringify(n++ < 2 ? { ...ok, commit: "c".repeat(40) } : ok),
      )) as unknown as typeof fetch;
    expect((await restored("https://api.ponzu.design", OLD, moving, clock())).ok).toBe(true);
    const stuck = await restored(
      "https://api.ponzu.design",
      OLD,
      health({ ...ok, commit: "c".repeat(40) }),
      clock(),
    );
    expect(stuck).toEqual({ ok: false, problem: `it answers ${"c".repeat(40)}` });
    const down = await restored(
      "https://api.ponzu.design",
      OLD,
      health({ ...ok, database: false }),
      clock(),
    );
    expect(down.problem).toBe("it cannot reach its database");
  });
});
