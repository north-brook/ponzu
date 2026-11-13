import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SELFCHECK_IDS as API_SELFCHECK_IDS } from "../../../apps/api/src/ops/selfcheck.ts";
import currentImage from "../../../apps/runner/image/current.json" with { type: "json" };
import { infraBeforeLaunch } from "../fixtures/infra.ts";
import {
  type ApiObserved,
  apiDesired,
  evaluateApi,
  fetchApi,
  type Health,
  SELFCHECK_IDS,
  type SelfcheckAnswer,
} from "./api.ts";
import type { CheckContext, Finding } from "./finding.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "api");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const infra = infraBeforeLaunch();
/**
 * Dev's recorded health, naming the image current.json names now. The recording holds whichever
 * image was current the day it was made, and these tests are about an API that runs the current
 * one, so a new image (a Claude Code bump) must not fail them. A test that wants a stale image
 * gives one.
 */
const health = (): Health => ({ ...fixture("dev-health.json"), image: currentImage.image });
const selfcheck = (): SelfcheckAnswer => fixture("dev-selfcheck.json");
const read = <T>(body: T, status = 200) => ({ ok: true as const, status, body });
const statuses = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.id}`);
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const MAIN = "a".repeat(40);

/** infra after launch: dev on api-dev, and the release build pointed at production. */
function movedInfra() {
  const copy = structuredClone(infra);
  copy["environments.json"].release = "production";
  copy["environments.json"].environments.dev.apiUrl = "https://api-dev.ponzu.design";
  copy["environments.json"].environments.dev.apiDomains = ["api-dev.ponzu.design"];
  return copy;
}

/** After launch's infra change, but while api.ponzu.design still serves dev's frozen deployment. */
function movedNotCutOver() {
  const copy = movedInfra();
  copy["environments.json"].release = "dev";
  return copy;
}

describe("evaluate on dev's recorded answers", () => {
  test("every line, exactly", () => {
    const observed: ApiObserved = {
      health: read(health()),
      selfcheck: read(selfcheck()),
      main: null,
    };
    const findings = evaluateApi(apiDesired({ env: "dev", infra }), observed);
    expect(findings.map((f) => [f.status, f.id, f.says])).toEqual([
      [
        "ok",
        "api.health",
        "https://api.ponzu.design is dev, ok, and reaches its database (version 0.1.0)",
      ],
      ["ok", "api.migrations", "28 of 28 migrations applied"],
      ["ok", "api.image", `sandboxes run ${currentImage.image}`],
      ["ok", "api.commit", "built from 86864bf28503"],
      ["ok", "api.selfcheck.database", "ok"],
      ["ok", "api.selfcheck.migrations", "ok"],
      ["ok", "api.selfcheck.realtime", "ok"],
      ["ok", "api.selfcheck.storage_assets", "ok"],
      ["ok", "api.selfcheck.storage_private", "same_bucket"],
      ["ok", "api.selfcheck.workos", "ok"],
      ["ok", "api.selfcheck.github_app", "ok"],
      ["ok", "api.selfcheck.github_webhook", "ok"],
      ["ok", "api.selfcheck.anthropic", "ok"],
      ["ok", "api.selfcheck.sandboxes", "ok"],
      // Dev still holds two values sealed under its old vault key.
      ["fail", "api.selfcheck.vault_old_keys", "old_keys (2)"],
      ["ok", "api.selfcheck.posthog", "configured"],
      // Recorded before the selfcheck had cron_fresh: an API that does not answer it fails.
      [
        "fail",
        "api.selfcheck.cron_fresh",
        "the selfcheck did not answer it; is the deployment older than this check?",
      ],
    ]);
  });

  test("cron_fresh never_ran is pending on production before its first run, and fails on dev", () => {
    const answer = selfcheck();
    answer.checks.push({ id: "cron_fresh", ok: false, detail: "never_ran" });
    const prodHealth = { ...health(), environment: "production", commit: MAIN };
    const prod = evaluateApi(apiDesired({ env: "production", infra: movedInfra() }), {
      health: read(prodHealth),
      selfcheck: read(answer),
      main: { sha: MAIN },
    });
    expect(byId(prod)["api.selfcheck.cron_fresh"]?.status).toBe("pending");
    const dev = evaluateApi(apiDesired({ env: "dev", infra }), {
      health: read(health()),
      selfcheck: read(answer),
      main: null,
    });
    expect(byId(dev)["api.selfcheck.cron_fresh"]?.status).toBe("fail");
    const stale = structuredClone(answer);
    const fresh = stale.checks.find((c) => c.id === "cron_fresh");
    if (fresh) fresh.detail = "stale";
    const prodStale = evaluateApi(apiDesired({ env: "production", infra: movedInfra() }), {
      health: read(prodHealth),
      selfcheck: read(stale),
      main: { sha: MAIN },
    });
    expect(byId(prodStale)["api.selfcheck.cron_fresh"]?.status).toBe("fail");
  });

  test("the ids it expects are the API's own", () => {
    expect([...SELFCHECK_IDS]).toEqual([...API_SELFCHECK_IDS]);
  });
});

describe("production before and after its domain is its own", () => {
  test("while api.ponzu.design still serves dev, production is one pending line", () => {
    const observed: ApiObserved = {
      health: read(health()),
      selfcheck: { withheld: "health did not say production" },
      main: { sha: MAIN },
    };
    expect(evaluateApi(apiDesired({ env: "production", infra }), observed)).toEqual([
      {
        id: "api.health",
        area: "api",
        status: "pending",
        says: "https://api.ponzu.design answers as dev, not production: the address still belongs to dev",
        fix: "docs/production.md › The founder's steps (D15 deploys production)",
      },
    ]);
  });

  test("in one project, answering as dev is pending until the cutover, then fails", () => {
    const observed: ApiObserved = {
      health: read(health()),
      selfcheck: { withheld: "health did not say production" },
      main: { sha: MAIN },
    };
    const before = evaluateApi(
      apiDesired({ env: "production", infra: movedNotCutOver() }),
      observed,
    );
    expect(statuses(before)).toEqual(["pending api.health"]);
    // After the cutover it fails, even if infra still lists the address for dev too.
    const sharedAfter = structuredClone(infra);
    sharedAfter["environments.json"].release = "production";
    expect(sharedAfter["environments.json"].environments.dev.apiDomains).toContain(
      "api.ponzu.design",
    );
    const after = evaluateApi(apiDesired({ env: "production", infra: sharedAfter }), observed);
    expect(statuses(after)).toEqual(["fail api.health"]);
  });

  test("once the domain is production's alone, answering as dev fails", () => {
    const observed: ApiObserved = {
      health: read(health()),
      selfcheck: { withheld: "health did not say production" },
      main: { sha: MAIN },
    };
    const findings = evaluateApi(apiDesired({ env: "production", infra: movedInfra() }), observed);
    expect(statuses(findings)).toEqual(["fail api.health"]);
  });

  test("production built from main's head passes; behind main fails", () => {
    const body = { ...health(), environment: "production", commit: MAIN };
    const desired = apiDesired({ env: "production", infra: movedInfra() });
    const ok = evaluateApi(desired, {
      health: read(body),
      selfcheck: read(selfcheck()),
      main: { sha: MAIN },
    });
    expect(byId(ok)["api.commit"]?.status).toBe("ok");
    const behind = evaluateApi(desired, {
      health: read(body),
      selfcheck: read(selfcheck()),
      main: { sha: "b".repeat(40) },
    });
    expect(byId(behind)["api.commit"]).toMatchObject({
      status: "fail",
      says: "built from aaaaaaaaaaaa, but main is at bbbbbbbbbbbb",
    });
  });
});

describe("hand-made failures", () => {
  const desired = apiDesired({ env: "dev", infra });
  const with_ = (body: Partial<Health>, status = 200) =>
    evaluateApi(desired, {
      health: read({ ...health(), ...body }, status),
      selfcheck: read(selfcheck()),
      main: null,
    });

  test("a deploy ahead of its migration fails, and says to migrate", () => {
    const f = byId(with_({ status: "degraded", migrations: { applied: 27, expected: 28 } }));
    expect(f["api.health"]?.status).toBe("fail");
    expect(f["api.migrations"]).toMatchObject({
      status: "fail",
      says: "27 migrations applied, but the build expects 28",
      fix: "run the deploy workflow, which migrates before it deploys",
    });
  });

  test("an image other than current.json's fails", () => {
    const f = byId(with_({ image: "ponzu-runner@sha256:0000" }));
    expect(f["api.image"]?.status).toBe("fail");
  });

  test("a 503 without its database fails", () => {
    expect(byId(with_({ database: false, status: "degraded" }, 503))["api.health"]?.says).toBe(
      "https://api.ponzu.design answers 503 degraded, without its database",
    );
  });

  test("an unreadable health is one failing line", () => {
    const findings = evaluateApi(desired, {
      health: { ok: false, error: "timed out" },
      selfcheck: { withheld: "health did not say dev" },
      main: null,
    });
    expect(statuses(findings)).toEqual(["fail api.health"]);
  });

  test("a selfcheck that leaves out a check, or answers 401, fails", () => {
    const partial = { checks: selfcheck().checks.filter((c) => c.id !== "workos") };
    const f = byId(
      evaluateApi(desired, { health: read(health()), selfcheck: read(partial), main: null }),
    );
    expect(f["api.selfcheck.workos"]?.status).toBe("fail");
    const refused = evaluateApi(desired, {
      health: read(health()),
      selfcheck: read(selfcheck(), 401),
      main: null,
    });
    expect(byId(refused)["api.selfcheck"]).toMatchObject({
      status: "fail",
      fix: "CRON_SECRET is not this environment's",
    });
  });

  test("no CRON_SECRET is a skipped line, never a pass", () => {
    const findings = evaluateApi(desired, {
      health: read(health()),
      selfcheck: { skipped: "no CRON_SECRET" },
      main: null,
    });
    expect(byId(findings)["api.selfcheck"]).toMatchObject({
      status: "skipped",
      says: "skipped (no CRON_SECRET)",
    });
  });
});

describe("fetchApi: where the cron secret goes", () => {
  const SECRET = "cron-secret-for-the-test-0123456789";
  function context(
    env: "dev" | "production",
    answer: (url: URL) => Response,
    seen: Request[],
    secret = true,
  ): CheckContext {
    return {
      env,
      infra,
      credentials: secret ? { CRON_SECRET: SECRET } : {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push(request);
        return answer(new URL(request.url));
      }) as typeof fetch,
      now: () => new Date("2026-11-12T12:00:00Z"),
      deep: false,
    };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const answers = (url: URL) =>
    url.pathname === "/v1/health"
      ? json(health())
      : url.pathname === "/v1/cron/selfcheck"
        ? json(selfcheck())
        : new Response(MAIN);

  test("dev: health, then the selfcheck with the bearer", async () => {
    const seen: Request[] = [];
    const observed = await fetchApi(
      context("dev", answers, seen),
      apiDesired({ env: "dev", infra }),
    );
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.ponzu.design/v1/health",
      "https://api.ponzu.design/v1/cron/selfcheck",
    ]);
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[1]?.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    // A redirect is refused, never followed: the secret goes to the address health vouched for.
    expect(seen.map((r) => r.redirect)).toEqual(["error", "error"]);
    // Parsed: the fixture's own note is not part of the answer.
    expect(observed.selfcheck).toEqual(read({ checks: selfcheck().checks }));
  });

  test("production while the address answers as dev: the bearer is never sent", async () => {
    const seen: Request[] = [];
    const observed = await fetchApi(
      context("production", answers, seen),
      apiDesired({ env: "production", infra }),
    );
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/health",
      "/repos/north-brook/ponzu/commits/main",
    ]);
    for (const request of seen) expect(request.headers.get("authorization")).toBeNull();
    expect(observed.selfcheck).toEqual({ withheld: "health did not say production" });
    expect(observed.main).toEqual({ sha: MAIN });
  });

  test("main's head is read through Octokit, and a refusal is only its status", async () => {
    const seen: Request[] = [];
    const observed = await fetchApi(
      context(
        "production",
        (url) =>
          url.pathname.startsWith("/repos/")
            ? json({ message: "Not Found", token: "ghp_quoted" }, 404)
            : answers(url),
        seen,
      ),
      apiDesired({ env: "production", infra }),
    );
    expect(seen[1]?.headers.get("accept")).toBe("application/vnd.github.sha");
    expect(observed.main).toEqual({ error: "GitHub answered 404" });
  });

  test("without CRON_SECRET the selfcheck is not asked", async () => {
    const seen: Request[] = [];
    const observed = await fetchApi(
      context("dev", answers, seen, false),
      apiDesired({ env: "dev", infra }),
    );
    expect(seen).toHaveLength(1);
    expect(observed.selfcheck).toEqual({ skipped: "no CRON_SECRET" });
  });

  test("an answer that is not JSON is an unreadable health", async () => {
    const observed = await fetchApi(
      context("dev", () => new Response("<html>", { status: 404 }), []),
      apiDesired({ env: "dev", infra }),
    );
    expect(observed.health).toEqual({ ok: false, error: "answered 404 with no JSON" });
  });
});
