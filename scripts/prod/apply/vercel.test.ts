import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vercel } from "@vercel/sdk";
import { HTTPClient } from "@vercel/sdk/lib/http.js";
import { loadInfra } from "../desired.ts";
import {
  applyContext,
  asSeen,
  fakeNetwork,
  Reply,
  type Routes,
  type Seen,
  written,
} from "./testing.ts";
import {
  firewallArea,
  GENERATED_SECRETS,
  NOT_YET_GENERATED,
  planEnv,
  planFirewall,
  planProject,
  planSecrets,
  publicEnv,
  STANDARD_PROTECTION,
  secretNames,
  vercelEnvArea,
  vercelProjectArea,
} from "./vercel.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vercel");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const infra = loadInfra();
const TOKEN = "vercel-test-token-0123456789";
const API = "https://api.vercel.com";

/** Dev's recorded project, its domains, firewall and variables (every one sensitive, no value). */
function devRoutes(): Routes {
  const project = fixture("dev-project.json");
  return {
    "GET /v9/projects/ponzu-api": project,
    "GET /v9/projects/prj_recorded/domains": fixture("dev-domains.json"),
    "GET /v1/security/firewall/config/active": fixture("dev-firewall.json"),
    "GET /v10/projects/ponzu-api/env": {
      envs: project.env.map((e: object, i: number) => ({ ...e, id: `env_${i}` })),
    },
  };
}

/** Production's project before founder step D2: Vercel answers 404. */
const missingProd: Routes = {
  "GET /v9/projects/ponzu-api-prod": new Reply(404, {
    error: { code: "not_found", message: "Project not found" },
  }),
};

/** Production's project after D2: settings right, nothing in its env. */
function prodRoutes(envs: object[] = []): Routes {
  const project = {
    ...fixture("dev-project.json"),
    name: "ponzu-api-prod",
    id: "prj_prod",
    env: envs,
  };
  return {
    "GET /v9/projects/ponzu-api-prod": project,
    "GET /v9/projects/prj_prod/domains": { domains: [] },
    "GET /v1/security/firewall/config/active": infra["vercel-firewall.json"],
    "GET /v10/projects/ponzu-api-prod/env": { envs },
  };
}

describe("vercel-project", () => {
  test("dev's recorded project already matches: nothing to send", async () => {
    const net = fakeNetwork(devRoutes());
    const plan = await planProject(applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes).toEqual([]);
    expect(plan.notes).toEqual(["ponzu-api's settings already match"]);
    expect(net.writes()).toEqual([]);
  });

  test("production before D2: create it, then set Node, with these bodies exactly", async () => {
    const net = fakeNetwork(missingProd);
    const plan = await planProject(applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "POST",
        url: `${API}/v11/projects?slug=northbrook`,
        body: {
          name: "ponzu-api-prod",
          framework: "hono",
          rootDirectory: "apps/api",
          serverlessFunctionRegion: "iad1",
          oidcTokenConfig: { enabled: true, issuerMode: "team" },
          ssoProtection: { deploymentType: STANDARD_PROTECTION },
        },
      },
      {
        method: "PATCH",
        url: `${API}/v9/projects/ponzu-api-prod?slug=northbrook`,
        body: { nodeVersion: "26.x" },
      },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("a drifted project gets one PATCH with only what differs; Git is a note", async () => {
    const project = {
      ...fixture("dev-project.json"),
      nodeVersion: "22.x",
      serverlessFunctionRegion: "sfo1",
      ssoProtection: null,
      link: { type: "github" },
    };
    const net = fakeNetwork({ ...devRoutes(), "GET /v9/projects/ponzu-api": project });
    const ctx = applyContext("dev", { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_x" }, net.fetch);
    const plan = await planProject(ctx);
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PATCH",
        url: `${API}/v9/projects/ponzu-api?teamId=team_x`,
        body: {
          nodeVersion: "26.x",
          serverlessFunctionRegion: "iad1",
          ssoProtection: { deploymentType: STANDARD_PROTECTION },
        },
      },
    ]);
    expect(plan.notes[0]).toContain("Git repository connected");
  });

  test("--yes sends exactly what the dry run printed, through the SDK", async () => {
    const net = fakeNetwork({
      ...missingProd,
      "POST /v11/projects": { id: "prj_new", name: "ponzu-api-prod" },
      "PATCH /v9/projects/ponzu-api-prod": { id: "prj_new" },
    });
    const plan = await planProject(applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch));
    for (const change of plan.changes) await change.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
  });

  test("verify reads the check's settings, OIDC and protection lines", async () => {
    const net = fakeNetwork(devRoutes());
    const lines = await vercelProjectArea.verify!(
      applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch),
    );
    expect(lines.map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok vercel.settings",
      "ok vercel.oidc",
      "ok vercel.protection",
    ]);
  });
});

describe("vercel-env", () => {
  test("the public values come from environments.json; nulls and absences are not written", () => {
    expect(publicEnv("production", infra)).toEqual({
      PONZU_ENVIRONMENT: "production",
      PONZU_API_URL: "https://api.ponzu.design",
      WORKOS_CLIENT_ID: null,
      GITHUB_APP_SLUG: "ponzu",
      NEON_REALTIME_URL: null,
      PONZU_ASSETS_URL: "https://assets.ponzu.cloud",
      R2_BUCKET: "ponzu-assets",
      R2_PRIVATE_BUCKET: "ponzu-private",
      PONZU_POSTHOG_HOST: "https://us.i.posthog.com",
      PONZU_POSTHOG_AI_CONTENT: "0",
      PONZU_MIN_CLIENT_VERSIONS: "macos=2.0.0,windows=2.0.0,linux=2.0.0",
    });
    const dev = publicEnv("dev", infra);
    expect("R2_PRIVATE_BUCKET" in dev).toBe(false);
    expect("PONZU_MIN_CLIENT_VERSIONS" in dev).toBe(false);
    expect(dev.PONZU_POSTHOG_AI_CONTENT).toBe("1");
  });

  test("production with an empty env: one POST of every public value infra holds, as plain", async () => {
    const net = fakeNetwork(prodRoutes());
    const plan = await planEnv(applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch));
    const plain = (key: string, value: string) => ({
      key,
      value,
      type: "plain",
      target: ["production"],
    });
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "POST",
        url: `${API}/v10/projects/ponzu-api-prod/env?slug=northbrook`,
        body: [
          plain("PONZU_ENVIRONMENT", "production"),
          plain("PONZU_API_URL", "https://api.ponzu.design"),
          plain("GITHUB_APP_SLUG", "ponzu"),
          plain("PONZU_ASSETS_URL", "https://assets.ponzu.cloud"),
          plain("R2_BUCKET", "ponzu-assets"),
          plain("PONZU_POSTHOG_HOST", "https://us.i.posthog.com"),
          plain("PONZU_POSTHOG_AI_CONTENT", "0"),
          plain("R2_PRIVATE_BUCKET", "ponzu-private"),
          plain("PONZU_MIN_CLIENT_VERSIONS", "macos=2.0.0,windows=2.0.0,linux=2.0.0"),
        ],
      },
    ]);
    expect(plan.notes.filter((n) => n.includes("no value yet"))).toEqual([
      "WORKOS_CLIENT_ID: infra has no value yet (founder step D7); left alone",
      "NEON_REALTIME_URL: infra has no value yet (founder step D3); left alone",
    ]);
  });

  test("a plain value that differs is edited; an equal one is a note; a preview one is ignored", async () => {
    const envs = [
      {
        id: "env_a",
        key: "PONZU_ENVIRONMENT",
        type: "plain",
        target: ["production"],
        value: "production",
      },
      { id: "env_b", key: "R2_BUCKET", type: "plain", target: ["production"], value: "ponzu-dev" },
      { id: "env_c", key: "GITHUB_APP_SLUG", type: "plain", target: ["preview"], value: "x" },
    ];
    const net = fakeNetwork(prodRoutes(envs));
    const plan = await planEnv(applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch));
    const requests = plan.changes.map((c) => c.request);
    expect(requests[1]).toEqual({
      method: "PATCH",
      url: `${API}/v9/projects/ponzu-api-prod/env/env_b?slug=northbrook`,
      body: { value: "ponzu-assets" },
    });
    expect((requests[0]!.body as { key: string }[]).map((b) => b.key)).toContain("GITHUB_APP_SLUG");
    expect(plan.notes).toContain('PONZU_ENVIRONMENT is "production"');
  });

  test("dev's variables are all sensitive: nothing is overwritten, each says why", async () => {
    const net = fakeNetwork(devRoutes());
    const plan = await planEnv(applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch));
    const posted = (plan.changes[0]?.request.body ?? []) as { key: string }[];
    // Only names dev does not have at all are added; what is there is never replaced.
    for (const key of posted.map((p) => p.key)) {
      expect(fixture("dev-project.json").env.some((e: { key: string }) => e.key === key)).toBe(
        false,
      );
    }
    expect(plan.changes.every((c) => c.request.method === "POST")).toBe(true);
    expect(plan.notes.some((n) => n.startsWith("WORKOS_CLIENT_ID is stored as sensitive"))).toBe(
      true,
    );
  });

  test("before D2 there is nothing to write to", async () => {
    const net = fakeNetwork(missingProd);
    const plan = await planEnv(applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes).toEqual([]);
    expect(plan.notes[0]).toContain("does not exist yet");
  });

  test("verify passes only when nothing is left to do", async () => {
    const net = fakeNetwork(prodRoutes());
    const [line] = await vercelEnvArea.verify!(
      applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch),
    );
    expect(line?.status).toBe("fail");
  });
});

describe("secrets generate", () => {
  test("only the secrets apply makes itself, named exactly", () => {
    expect(secretNames(["generate", "--names", "PONZU_VAULT_KEY,CRON_SECRET"])).toEqual([
      ...GENERATED_SECRETS,
    ]);
    expect(() => secretNames(["generate", "--names", "DATABASE_URL"])).toThrow(/DATABASE_URL/);
    expect(() => secretNames(["generate"])).toThrow(/usage/);
    expect(() => secretNames(["make", "--names", "CRON_SECRET"])).toThrow(/usage/);
  });

  test("the dry run shows no value, because none exists until --yes", async () => {
    const net = fakeNetwork(prodRoutes());
    const ctx = applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch, [
      "generate",
      "--names",
      "PONZU_VAULT_KEY,CRON_SECRET",
    ]);
    const plan = await planSecrets(ctx);
    expect(plan.changes.map((c) => c.request)).toEqual(
      GENERATED_SECRETS.map((key) => ({
        method: "POST",
        url: `${API}/v10/projects/ponzu-api-prod/env?slug=northbrook`,
        body: [{ key, value: NOT_YET_GENERATED, type: "sensitive", target: ["production"] }],
      })),
    );
    expect(ctx.secrets).toEqual([]);
    expect(net.writes()).toEqual([]);
  });

  test("--yes sends 32 fresh random bytes each, sensitive, Production only, redacted first", async () => {
    const net = fakeNetwork({
      ...prodRoutes(),
      "POST /v10/projects/ponzu-api-prod/env": { created: [] },
    });
    const ctx = applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch, [
      "generate",
      "--names",
      "PONZU_VAULT_KEY,CRON_SECRET",
    ]);
    for (const change of (await planSecrets(ctx)).changes) await change.send();
    const sent = written(net.seen);
    expect(sent.map((s) => s.url)).toEqual([
      `${API}/v10/projects/ponzu-api-prod/env`,
      `${API}/v10/projects/ponzu-api-prod/env`,
    ]);
    const bodies = sent.map((s) => (s.body as Record<string, unknown>[])[0]!);
    expect(bodies.map((b) => [b.key, b.type, b.target])).toEqual([
      ["PONZU_VAULT_KEY", "sensitive", ["production"]],
      ["CRON_SECRET", "sensitive", ["production"]],
    ]);
    const values = bodies.map((b) => b.value as string);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
    expect(values[0]).not.toBe(values[1]);
    expect(ctx.secrets).toEqual(values);
    // No upsert: an existing value is never replaced through this call.
    expect(sent.every((s) => !s.query.includes("upsert"))).toBe(true);
  });

  test("an existing secret is never replaced", async () => {
    const envs = [
      { id: "env_v", key: "PONZU_VAULT_KEY", type: "sensitive", target: ["production"] },
    ];
    const net = fakeNetwork(prodRoutes(envs));
    const plan = await planSecrets(
      applyContext("production", { VERCEL_TOKEN: TOKEN }, net.fetch, [
        "generate",
        "--names",
        "PONZU_VAULT_KEY",
      ]),
    );
    expect(plan.changes).toEqual([]);
    expect(plan.notes[0]).toContain("apply never replaces it");
  });
});

describe("firewall", () => {
  test("dev's live firewall differs: one PUT whose body is infra/vercel-firewall.json exactly", async () => {
    const net = fakeNetwork(devRoutes());
    const plan = await planFirewall(applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PUT",
        url: `${API}/v1/security/firewall/config?projectId=prj_recorded&slug=northbrook`,
        body: JSON.parse(
          readFileSync(
            join(import.meta.dir, "..", "..", "..", "infra", "vercel-firewall.json"),
            "utf8",
          ),
        ),
      },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("--yes sends that body with the token, then the check's firewall lines must be ok", async () => {
    let live: unknown = fixture("dev-firewall.json");
    const net = fakeNetwork({
      ...devRoutes(),
      "GET /v1/security/firewall/config/active": () => live,
      "PUT /v1/security/firewall/config": (seen: Seen) => {
        live = seen.body;
        return { active: seen.body };
      },
    });
    const ctx = applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch);
    const plan = await planFirewall(ctx);
    await plan.changes[0]!.send();
    const put = net.seen.find((s) => s.method === "PUT")!;
    expect(put.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    const lines = await firewallArea.verify!(ctx);
    expect(lines.every((l) => l.status === "ok")).toBe(true);
    expect((await planFirewall(ctx)).changes).toEqual([]);
  });

  test("a refused PUT says Vercel's status, never its body", async () => {
    const net = fakeNetwork({
      ...devRoutes(),
      "PUT /v1/security/firewall/config": new Reply(403, {
        error: { message: `token ${TOKEN} is not allowed` },
      }),
    });
    const plan = await planFirewall(applyContext("dev", { VERCEL_TOKEN: TOKEN }, net.fetch));
    await expect(plan.changes[0]!.send()).rejects.toThrow(
      /^Vercel answered 403 for PUT \/v1\/security\/firewall\/config$/,
    );
  });

  test("why the PUT is not the SDK's: putFirewallConfig drops managedRules on 1.28.53", async () => {
    let body: Record<string, unknown> = {};
    const vercel = new Vercel({
      bearerToken: TOKEN,
      httpClient: new HTTPClient({
        fetcher: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          body = JSON.parse(await request.text());
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      }),
    });
    await vercel.security
      .putFirewallConfig({
        projectId: "prj_x",
        requestBody: infra["vercel-firewall.json"] as never,
      })
      .catch(() => undefined);
    // If this starts failing, the SDK sends managedRules again and the firewall area can use it.
    expect(body.managedRules).toEqual({});
    expect(infra["vercel-firewall.json"].managedRules.bot_protection.active).toBe(true);
  });
});
