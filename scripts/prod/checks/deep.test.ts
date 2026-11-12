import { describe, expect, test } from "bun:test";
import { FakeClock, FakeSandboxes, type Sandboxes } from "../../../packages/sandbox/src/index.ts";
import { loadInfra } from "../desired.ts";
import { deepDesired, evaluateDeep, fetchDeep, type MakeSandboxes } from "./deep.ts";
import type { CheckContext } from "./finding.ts";

const infra = loadInfra();

function context(env: "dev" | "production"): CheckContext {
  return {
    env,
    infra,
    credentials: { VERCEL_TOKEN: "token-for-the-test-0123456789", VERCEL_TEAM_ID: "team_test" },
    fetch: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    now: () => new Date("2026-11-12T12:00:00Z"),
    deep: true,
  };
}
const found = async () => "prj_test";

describe("--deep", () => {
  test("makes one pz-test-check sandbox from current.json's image, then removes it", async () => {
    const fake = new FakeSandboxes(new FakeClock(Date.parse("2026-11-12T12:00:00Z")));
    const given: unknown[] = [];
    const make: MakeSandboxes = (credentials) => {
      given.push(credentials);
      return fake;
    };
    const ctx = context("dev");
    const desired = deepDesired(ctx);
    const observed = await fetchDeep(ctx, desired, make, found);
    expect(given).toEqual([
      { token: "token-for-the-test-0123456789", teamId: "team_test", projectId: "prj_test" },
    ]);
    expect(observed.name).toMatch(/^pz-test-check-[a-z0-9]{8}$/);
    expect(await fake.status(observed.name as string)).toBeNull();
    expect(evaluateDeep(desired, observed).map((f) => `${f.status} ${f.id}`)).toEqual([
      "ok deep.sandbox",
      "ok deep.cleanup",
    ]);
  });

  test("a sandbox that cannot be made fails, and is still removed", async () => {
    const removed: string[] = [];
    const broken = {
      up: async () => {
        throw new Error("image_not_found");
      },
      remove: async (name: string) => {
        removed.push(name);
      },
    } as unknown as Sandboxes;
    const ctx = context("dev");
    const desired = deepDesired(ctx);
    const observed = await fetchDeep(ctx, desired, () => broken, found);
    expect(removed).toEqual([observed.name as string]);
    const findings = evaluateDeep(desired, observed);
    expect(findings[0]).toMatchObject({ status: "fail", id: "deep.sandbox" });
    expect(findings[0]?.says).toEndWith("could not be made: image_not_found");
    expect(findings[1]?.status).toBe("ok");
  });

  test("production's project not made yet is pending, and nothing is made", async () => {
    let made = false;
    const ctx = context("production");
    const desired = deepDesired(ctx);
    const observed = await fetchDeep(
      ctx,
      desired,
      () => {
        made = true;
        return {} as Sandboxes;
      },
      async () => null,
    );
    expect(made).toBe(false);
    expect(evaluateDeep(desired, observed)).toEqual([
      {
        id: "deep.sandbox",
        area: "deep",
        status: "pending",
        says: "ponzu-api-prod does not exist, so no sandbox can be made in it",
        fix: "founder step D2",
      },
    ]);
  });
});
