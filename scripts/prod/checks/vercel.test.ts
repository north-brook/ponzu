import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN_ENV, OPTIONAL_ENV, REQUIRED_ENV } from "../../../apps/api/src/env.ts";
import { loadInfra } from "../desired.ts";
import type { CheckContext, Finding } from "./finding.ts";
import {
  evaluateVercel,
  fetchVercel,
  normalizeFirewall,
  observeVercel,
  SECRET_ENV,
  type VercelObserved,
  vercelDesired,
} from "./vercel.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vercel");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const infra = loadInfra();
const desired = (env: "dev" | "production") => vercelDesired({ env, infra });
const recorded = () =>
  observeVercel(
    fixture("dev-project.json"),
    fixture("dev-domains.json"),
    fixture("dev-firewall.json"),
  );
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const statuses = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.id}`);

/** Dev's recorded project, made as production should be: no leftovers, nothing on Preview, the firewall as the file says. */
function goodProduction(): VercelObserved {
  const observed = recorded();
  const project = observed.project!;
  return {
    project: {
      ...project,
      name: "ponzu-api-prod",
      env: project.env
        .filter((e) => e.key !== "ANTHROPIC_API_KEY" && e.key !== "BOAT_API_KEY")
        .filter((e) => e.targets.includes("production"))
        .map((e) => ({ ...e, targets: ["production"] })),
    },
    domains: [{ name: "api.ponzu.design", verified: true, redirect: null }],
    firewall: normalizeFirewall(infra["vercel-firewall.json"]),
  };
}

describe("evaluate on dev's recorded project", () => {
  test("every line, exactly", () => {
    const findings = evaluateVercel(desired("dev"), recorded());
    expect(statuses(findings)).toEqual([
      "ok vercel.settings",
      "ok vercel.oidc",
      "ok vercel.protection",
      "ok vercel.env.required",
      "fail vercel.env.unknown",
      "fail vercel.env.forbidden",
      "ok vercel.domains",
      "ok vercel.firewall.enabled",
      "fail vercel.firewall.crs",
      "fail vercel.firewall.managed",
      "fail vercel.firewall.rules",
      "ok vercel.deployment",
      "ok vercel.crons",
    ]);
    const f = byId(findings);
    expect(f["vercel.settings"]?.says).toBe(
      "ponzu-api: root apps/api, Node 26.x, region iad1, no Git connection",
    );
    expect(f["vercel.env.required"]?.says).toBe(
      `the Production target has all ${REQUIRED_ENV.length} names the API needs`,
    );
    // Dev still carries two leftovers: a key the API never reads, and boat.dev's (founder step 23).
    expect(f["vercel.env.unknown"]?.says).toBe(
      "the API reads no ANTHROPIC_API_KEY, set on the Production target",
    );
    expect(f["vercel.env.forbidden"]?.says).toBe("BOAT_API_KEY is set on preview and production");
    // Dev's firewall has never been applied from the file.
    expect(f["vercel.firewall.crs"]?.says).toBe(
      "live differs: sd off (file: log), ma off (file: log), lfi off (file: log), rfi off (file: log), php off (file: log), sf off (file: log), java off (file: log)",
    );
    expect(f["vercel.firewall.managed"]?.says).toBe("live differs: bot_protection off (file: log)");
    expect(f["vercel.firewall.rules"]?.says).toStartWith('"cron needs a bearer" is missing; ');
    expect(f["vercel.firewall.rules"]?.fix).toBe("bun scripts/prod/apply.ts firewall --env dev");
    expect(f["vercel.deployment"]?.says).toBe(
      "the latest production deployment is ready, built from 86864bf28503",
    );
    expect(f["vercel.crons"]?.says).toBe(
      "the production deployment runs /v1/cron/minute (* * * * *)",
    );
  });

  test("the fixture keeps names, targets and types, and no value", () => {
    for (const entry of fixture("dev-project.json").env) {
      expect(Object.keys(entry).sort()).toEqual(["key", "target", "type"]);
    }
    for (const entry of recorded().project!.env) {
      expect(Object.keys(entry).sort()).toEqual(["key", "targets", "type"]);
    }
  });
});

describe("evaluate on hand-made failures", () => {
  test("production built right passes every line", () => {
    const findings = evaluateVercel(desired("production"), goodProduction());
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(statuses(findings)).toContain("ok vercel.env.preview");
    expect(statuses(findings)).toContain("ok vercel.env.sensitive");
  });

  test("a VERCEL_TOKEN on the project fails, naming the target", () => {
    const observed = goodProduction();
    observed.project!.env.push({ key: "VERCEL_TOKEN", targets: ["production"], type: "sensitive" });
    const f = byId(evaluateVercel(desired("production"), observed));
    expect(f["vercel.env.forbidden"]).toMatchObject({
      status: "fail",
      says: "VERCEL_TOKEN is set on production",
    });
    // It is reported as forbidden, not again as unknown.
    expect(f["vercel.env.unknown"]?.status).toBe("ok");
  });

  test("a Preview target holding DATABASE_URL fails on production", () => {
    const observed = goodProduction();
    observed.project!.env.push({ key: "DATABASE_URL", targets: ["preview"], type: "sensitive" });
    const f = byId(evaluateVercel(desired("production"), observed));
    expect(f["vercel.env.preview"]).toMatchObject({
      status: "fail",
      says: "the preview target holds DATABASE_URL",
    });
  });

  test("a firewall rule drifted fails, naming the rule and the numbers", () => {
    const observed = goodProduction();
    const rule = observed.firewall!.rules.find((r) => r.name === "messages per caller")!;
    rule.rateLimit = { ...rule.rateLimit!, limit: 600 };
    const f = byId(evaluateVercel(desired("production"), observed));
    expect(f["vercel.firewall.rules"]).toMatchObject({
      status: "fail",
      says: '"messages per caller": its limit is 600 per 60 s (fixed_window, keys ip), not 60 per 60 s (fixed_window, keys ip)',
      fix: "bun scripts/prod/apply.ts firewall --env production",
    });
  });

  test("a rule live but not in the file, or changed in its conditions, fails", () => {
    const observed = goodProduction();
    const rules = observed.firewall!.rules;
    rules.push({ ...rules[0]!, name: "made in the dashboard" });
    rules[0]!.conditionGroup = [
      { conditions: [{ type: "path", op: "pre", value: "/v1/", neg: false }] },
    ];
    const says = byId(evaluateVercel(desired("production"), observed))["vercel.firewall.rules"]
      ?.says;
    expect(says).toBe(
      '"cron needs a bearer": its conditions differ; "made in the dashboard" is live but not in the file',
    );
  });

  test("a missing required name and a secret stored readable fail", () => {
    const observed = goodProduction();
    const env = observed.project!.env;
    observed.project!.env = env
      .filter((e) => e.key !== "PONZU_ENVIRONMENT")
      .map((e) => (e.key === "CRON_SECRET" ? { ...e, type: "encrypted" } : e));
    const f = byId(evaluateVercel(desired("production"), observed));
    expect(f["vercel.env.required"]?.says).toBe("the Production target lacks PONZU_ENVIRONMENT");
    expect(f["vercel.env.sensitive"]?.says).toBe("CRON_SECRET is not stored as sensitive");
  });

  test("a project with no cron, off protection, Git connected or the wrong issuer fails each line", () => {
    const observed = goodProduction();
    const project = observed.project!;
    project.crons = { disabled: false, definitions: [] };
    project.protection = null;
    project.gitConnected = true;
    project.oidc = { enabled: true, issuerMode: "global" };
    const f = byId(evaluateVercel(desired("production"), observed));
    expect(f["vercel.crons"]?.status).toBe("fail");
    expect(f["vercel.protection"]?.says).toBe(
      "deployment protection is off: every deployment holds the live secrets",
    );
    expect(f["vercel.settings"]?.says).toBe(
      "ponzu-api-prod: a Git repository is connected, so a push would deploy outside the workflow",
    );
    expect(f["vercel.oidc"]?.says).toBe(
      "OIDC is on with issuer global; sandboxes need the team issuer",
    );
  });

  test("production's domain still on dev before D11 is pending; once moved, missing fails", () => {
    const observed = goodProduction();
    observed.domains = [];
    expect(byId(evaluateVercel(desired("production"), observed))["vercel.domains"]).toMatchObject({
      status: "pending",
      says: "api.ponzu.design is not a verified domain of ponzu-api-prod: dev still serves it until D11",
    });
    const moved = { ...desired("production"), notYetMoved: [] };
    expect(byId(evaluateVercel(moved, observed))["vercel.domains"]?.status).toBe("fail");
    expect(desired("dev").notYetMoved).toEqual([]);
  });

  test("production's project not made yet is one pending line; dev's missing project fails", () => {
    const missing = observeVercel(null, null, null);
    expect(evaluateVercel(desired("production"), missing)).toEqual([
      {
        id: "vercel.project",
        area: "vercel",
        status: "pending",
        says: "ponzu-api-prod does not exist yet",
        fix: "bun scripts/prod/apply.ts vercel-project --env production --yes (founder step D2)",
      },
    ]);
    expect(evaluateVercel(desired("dev"), missing).map((f) => f.status)).toEqual(["fail"]);
  });
});

describe("the names it holds the project to", () => {
  test("every secret it wants sensitive is a name the API reads", () => {
    const known = new Set([...REQUIRED_ENV, ...OPTIONAL_ENV]);
    expect(SECRET_ENV.filter((name) => !known.has(name))).toEqual([]);
  });

  test("every name the API reads that looks like a secret is held to sensitive", () => {
    // A secret added to env.ts later fails here until SECRET_ENV names it too.
    const looksSecret = /SECRET|PRIVATE_KEY|PASSWORD|API_KEY|TOKEN|ACCESS_KEY|VAULT|DATABASE_URL/;
    const forbidden = new Set<string>(FORBIDDEN_ENV);
    const secrets = new Set<string>(SECRET_ENV);
    const names = [...REQUIRED_ENV, ...OPTIONAL_ENV].filter(
      (name) => looksSecret.test(name) && !forbidden.has(name),
    );
    expect(names.filter((name) => !secrets.has(name))).toEqual([]);
  });

  test("the file's own firewall normalises to itself, with the SDK's renamed keys read the same", () => {
    const file = infra["vercel-firewall.json"];
    const renamed = {
      ...file,
      managedRules: {
        botProtection: file.managedRules.bot_protection,
        aiBots: file.managedRules.ai_bots,
      },
    };
    expect(normalizeFirewall(renamed)).toEqual(normalizeFirewall(file));
  });
});

describe("fetchVercel through @vercel/sdk", () => {
  const TOKEN = "vercel-token-for-the-test-0123456789";
  function context(answers: (path: string) => Response, seen: Request[]): CheckContext {
    return {
      env: "dev",
      infra,
      credentials: { VERCEL_TOKEN: TOKEN },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push(request);
        return answers(new URL(request.url).pathname);
      }) as typeof fetch,
      now: () => new Date("2026-11-12T12:00:00Z"),
      deep: false,
    };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("reads the three answers with GETs only, by the team's slug, and keeps no value", async () => {
    const seen: Request[] = [];
    const ctx = context((path) => {
      if (path.endsWith("/domains")) return json(fixture("dev-domains.json"));
      if (path.includes("/security/firewall/")) return json(fixture("dev-firewall.json"));
      // A value the API would never send for a sensitive variable, to prove it is dropped.
      const project = fixture("dev-project.json");
      project.env[0].value = "plain-value-that-must-not-survive";
      return json(project);
    }, seen);
    const observed = await fetchVercel(ctx, desired("dev"));
    expect(seen.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/v9/projects/ponzu-api",
      "/v9/projects/prj_recorded/domains",
      "/v1/security/firewall/config/active",
    ]);
    for (const request of seen) {
      expect(new URL(request.url).searchParams.get("slug")).toBe("northbrook");
      expect(new URL(request.url).searchParams.has("decrypt")).toBe(false);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.stringify(observed)).not.toContain("plain-value-that-must-not-survive");
    expect(observed).toEqual(recorded());
  });

  test("a 404 for the project is a project that does not exist", async () => {
    const seen: Request[] = [];
    const ctx = context(
      () => json({ error: { code: "not_found", message: "Project not found" } }, 404),
      seen,
    );
    const observed = await fetchVercel(ctx, desired("production"));
    expect(observed.project).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("any other failure throws, for the runner to report", async () => {
    const ctx = context(() => json({ error: { code: "forbidden", message: "no" } }, 403), []);
    await expect(fetchVercel(ctx, desired("dev"))).rejects.toThrow();
  });
});
