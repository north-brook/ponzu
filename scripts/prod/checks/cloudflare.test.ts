import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadInfra } from "../desired.ts";
import {
  type CloudflareAnswers,
  cloudflareDesired,
  corsShortfall,
  evaluateCloudflare,
  fetchCloudflare,
  normalizeCors,
  observeCloudflare,
} from "./cloudflare.ts";
import type { CheckContext, Finding } from "./finding.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "cloudflare");
const recorded = (): CloudflareAnswers =>
  JSON.parse(readFileSync(join(FIXTURES, "dev-account.json"), "utf8"));
const infra = loadInfra();
const desired = (env: "dev" | "production") => cloudflareDesired({ env, infra });
const statuses = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.id}`);
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const ACCOUNT = "00000000000000000000000000000000";
const bucketItem = (...buckets: string[]) => ({
  status: "active",
  policies: [
    {
      effect: "allow",
      permission_groups: [{ name: "Workers R2 Storage Bucket Item Write" }],
      resources: Object.fromEntries(
        buckets.map((b) => [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_${b}`, "*"]),
      ),
    },
  ],
});

/** Production as the founder's steps leave it: both buckets, the domain, the rules, the token. */
function goodProduction(): CloudflareAnswers {
  const dev = recorded().buckets["ponzu-dev"]!;
  return {
    buckets: {
      "ponzu-assets": {
        bucket: { name: "ponzu-assets", location: "ENAM" },
        custom: {
          domains: [
            {
              domain: "assets.ponzu.cloud",
              enabled: true,
              status: { ownership: "active", ssl: "active" },
            },
          ],
        },
        managed: { domain: "pub-x.r2.dev", enabled: false },
        cors: structuredClone(dev.cors),
        lifecycle: { rules: structuredClone(infra["r2/lifecycle.json"].rules) },
      },
      "ponzu-private": {
        bucket: { name: "ponzu-private", location: "enam" },
        custom: { domains: [] },
        managed: { domain: "pub-y.r2.dev", enabled: false },
        cors: null,
        lifecycle: {
          rules: [
            {
              enabled: true,
              conditions: { prefix: "" },
              abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
            },
          ],
        },
      },
    },
    zone: {
      rules: [
        {
          action: "rewrite",
          enabled: true,
          expression: '(http.host eq "assets.ponzu.cloud")',
          action_parameters: {
            headers: {
              "Content-Security-Policy": {
                operation: "set",
                value: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              },
              "X-Content-Type-Options": { operation: "set", value: "nosniff" },
            },
          },
        },
      ],
    },
    tokens: [bucketItem("ponzu-dev"), bucketItem("ponzu-assets", "ponzu-private")],
  };
}

describe("evaluate on dev's account (written from the SDK's shapes and dev's public answers)", () => {
  test("every line, exactly", () => {
    const findings = evaluateCloudflare(desired("dev"), observeCloudflare(recorded()));
    expect(statuses(findings)).toEqual([
      "ok cloudflare.r2.assets",
      "ok cloudflare.r2.assets.domain",
      "ok cloudflare.r2.assets.r2dev",
      "ok cloudflare.r2.assets.cors",
      "pending cloudflare.r2.assets.lifecycle",
      "ok cloudflare.r2.private",
      "ok cloudflare.r2.token",
      "ok cloudflare.headers",
    ]);
    const f = byId(findings);
    expect(f["cloudflare.r2.assets"]?.says).toBe("the bucket ponzu-dev exists");
    expect(f["cloudflare.r2.assets.domain"]?.says).toBe(
      "ponzu-dev is served at assets-dev.ponzu.cloud, active with its certificate",
    );
    expect(f["cloudflare.r2.assets.lifecycle"]).toEqual({
      id: "cloudflare.r2.assets.lifecycle",
      area: "cloudflare",
      status: "pending",
      says: 'ponzu-dev has none of infra/r2/lifecycle.json\'s rules (it has "" aborts uploads after 7 days)',
      fix: "bun scripts/prod/apply.ts r2 --env dev",
    });
    expect(f["cloudflare.r2.private"]?.says).toBe(
      "dev has no private bucket on purpose: checkpoints sit under private/ in the assets bucket",
    );
    expect(f["cloudflare.r2.token"]?.says).toBe("an R2 token reaches exactly ponzu-dev");
    expect(f["cloudflare.headers"]?.says).toBe(
      "no transform rule on assets-dev.ponzu.cloud, which dev may go without (founder step B6)",
    );
  });

  test("infra/r2/cors.json is dev's live CORS, so applying it to production copies dev", () => {
    const live = normalizeCors(recorded().buckets["ponzu-dev"]!.cors!);
    expect(normalizeCors({ rules: infra["r2/cors.json"].rules })).toEqual(live);
    expect(corsShortfall(live)).toEqual([]);
  });

  test("with B6 applied, the lifecycle line is ok", () => {
    const answers = recorded();
    answers.buckets["ponzu-dev"]!.lifecycle = {
      rules: structuredClone(infra["r2/lifecycle.json"].rules),
    };
    const f = byId(evaluateCloudflare(desired("dev"), observeCloudflare(answers)));
    expect(f["cloudflare.r2.assets.lifecycle"]?.status).toBe("ok");
    expect(f["cloudflare.r2.assets.lifecycle"]?.says).toBe(
      'ponzu-dev\'s lifecycle is "" aborts uploads after 1 day and "staging/" deletes after 1 day',
    );
  });
});

describe("production", () => {
  test("before founder step D4 nothing passes: every line is pending", () => {
    const answers: CloudflareAnswers = {
      buckets: { "ponzu-assets": { bucket: null }, "ponzu-private": { bucket: null } },
      zone: { rules: [] },
      tokens: [bucketItem("ponzu-dev")],
    };
    const findings = evaluateCloudflare(desired("production"), observeCloudflare(answers));
    expect(statuses(findings)).toEqual([
      "pending cloudflare.r2.assets",
      "pending cloudflare.r2.private",
      "pending cloudflare.r2.token",
      "pending cloudflare.headers",
    ]);
    expect(byId(findings)["cloudflare.r2.assets"]?.says).toBe(
      "the bucket ponzu-assets does not exist yet",
    );
  });

  test("as the founder's steps leave it, every line is ok", () => {
    const findings = evaluateCloudflare(desired("production"), observeCloudflare(goodProduction()));
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(statuses(findings)).toEqual([
      "ok cloudflare.r2.assets",
      "ok cloudflare.r2.assets.domain",
      "ok cloudflare.r2.assets.r2dev",
      "ok cloudflare.r2.assets.cors",
      "ok cloudflare.r2.assets.lifecycle",
      "ok cloudflare.r2.private",
      "ok cloudflare.r2.private.domain",
      "ok cloudflare.r2.private.r2dev",
      "ok cloudflare.r2.private.lifecycle",
      "ok cloudflare.r2.token",
      "ok cloudflare.headers",
    ]);
    expect(byId(findings)["cloudflare.r2.assets"]?.says).toBe(
      "the bucket ponzu-assets exists (ENAM)",
    );
  });

  const judge = (change: (a: CloudflareAnswers) => void) => {
    const answers = goodProduction();
    change(answers);
    return byId(evaluateCloudflare(desired("production"), observeCloudflare(answers)));
  };

  test("r2.dev on fails", () => {
    const f = judge((a) => {
      a.buckets["ponzu-assets"]!.managed = { domain: "pub-x.r2.dev", enabled: true };
    });
    expect(f["cloudflare.r2.assets.r2dev"]).toEqual({
      id: "cloudflare.r2.assets.r2dev",
      area: "cloudflare",
      status: "fail",
      says: "r2.dev serves ponzu-assets at a second public address",
      fix: "Cloudflare › R2 › ponzu-assets › Settings › Public Development URL: disable (founder step D4)",
    });
  });

  test("a bucket outside ENAM fails", () => {
    const f = judge((a) => {
      a.buckets["ponzu-private"]!.bucket = { name: "ponzu-private", location: "weur" };
    });
    expect(f["cloudflare.r2.private"]?.status).toBe("fail");
    expect(f["cloudflare.r2.private"]?.says).toBe(
      "the bucket ponzu-private is placed in weur, not ENAM",
    );
  });

  test("a lifecycle rule deleting under private/, or everywhere, fails whatever infra says", () => {
    for (const prefix of ["", "p", "private/", "private/archives/"]) {
      const f = judge((a) => {
        a.buckets["ponzu-assets"]!.lifecycle!.rules!.push({
          enabled: true,
          conditions: { prefix },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
        });
      });
      expect(f["cloudflare.r2.assets.lifecycle"]?.status).toBe("fail");
      expect(f["cloudflare.r2.assets.lifecycle"]?.says).toContain("would delete live checkpoints");
    }
    // A disabled one deletes nothing, but it is still not the file's.
    const off = judge((a) => {
      a.buckets["ponzu-assets"]!.lifecycle!.rules!.push({
        enabled: false,
        conditions: { prefix: "private/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      });
    });
    expect(off["cloudflare.r2.assets.lifecycle"]?.says).toBe(
      'ponzu-assets\'s lifecycle differs: not in the file "private/" deletes after 1 day (disabled)',
    );
  });

  test("any delete rule on the private bucket fails", () => {
    const f = judge((a) => {
      a.buckets["ponzu-private"]!.lifecycle!.rules!.push({
        enabled: true,
        conditions: { prefix: "tmp/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      });
    });
    expect(f["cloudflare.r2.private.lifecycle"]?.status).toBe("fail");
  });

  test("the private bucket served at a domain fails", () => {
    const f = judge((a) => {
      a.buckets["ponzu-private"]!.custom = {
        domains: [
          {
            domain: "private.ponzu.cloud",
            enabled: true,
            status: { ownership: "active", ssl: "active" },
          },
        ],
      };
    });
    expect(f["cloudflare.r2.private.domain"]?.says).toBe(
      "ponzu-private holds checkpoints but is served at private.ponzu.cloud",
    );
  });

  test("CORS that drifted fails, naming what uploads lose", () => {
    const f = judge((a) => {
      a.buckets["ponzu-assets"]!.cors = {
        rules: [
          {
            allowed: {
              origins: ["https://ponzu.design"],
              methods: ["GET"],
              headers: ["content-type"],
            },
            maxAgeSeconds: 600,
          },
        ],
      };
    });
    expect(f["cloudflare.r2.assets.cors"]?.says).toBe(
      "ponzu-assets's CORS differs from infra/r2/cors.json, and does not allow GET, HEAD and PUT from ponzu-studio://app, the headers content-type, x-amz-checksum-sha256, cache-control and content-disposition on a PUT from ponzu-studio://app, HEAD and PUT from https://ponzu.design and the headers content-type, x-amz-checksum-sha256, cache-control and content-disposition on a PUT from https://ponzu.design",
    );
    const none = judge((a) => {
      a.buckets["ponzu-assets"]!.cors = null;
    });
    expect(none["cloudflare.r2.assets.cors"]?.says).toBe(
      "ponzu-assets has no CORS rules, so the apps cannot upload to it",
    );
  });

  test("a token reaching production's buckets and dev's fails", () => {
    const f = judge((a) => {
      a.tokens = [bucketItem("ponzu-assets", "ponzu-private", "ponzu-dev")];
    });
    expect(f["cloudflare.r2.token"]?.status).toBe("fail");
    expect(f["cloudflare.r2.token"]?.says).toBe(
      "a token that reaches ponzu-assets and ponzu-private also reaches ponzu-dev",
    );
  });

  test("a token listing the check may not read fails, naming the permission", () => {
    const f = judge((a) => {
      a.tokens = { refused: 403 };
    });
    expect(f["cloudflare.r2.token"]?.status).toBe("fail");
    expect(f["cloudflare.r2.token"]?.fix).toContain("Account API Tokens Read");
  });

  test("a header rule with a different CSP fails; none at all is pending", () => {
    const f = judge((a) => {
      const rule = a.zone!.rules[0]!;
      rule.action_parameters!.headers!["Content-Security-Policy"]!.value = "default-src *";
    });
    expect(f["cloudflare.headers"]?.status).toBe("fail");
    expect(f["cloudflare.headers"]?.says).toBe(
      "the transform rule on assets.ponzu.cloud does not set Content-Security-Policy as infra/cloudflare/assets-headers.json says",
    );
    const disabled = judge((a) => {
      a.zone!.rules[0]!.enabled = false;
    });
    expect(disabled["cloudflare.headers"]?.status).toBe("pending");
  });
});

describe("fetchCloudflare", () => {
  const ctx = (fetch: typeof globalThis.fetch): CheckContext => ({
    env: "dev",
    infra,
    credentials: { CLOUDFLARE_API_TOKEN: "cf-test-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
    deep: false,
  });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }), {
      headers: { "content-type": "application/json" },
    });

  test("reads with GETs only, through the SDK, and keeps no token id", async () => {
    const dev = recorded();
    const bucket = dev.buckets["ponzu-dev"]!;
    const seen: string[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      seen.push(`${method} ${url.pathname}${url.search}`);
      const path = url.pathname.replace(/^\/client\/v4/, "");
      if (path === `/accounts/${ACCOUNT}/r2/buckets/ponzu-dev`) return ok({ name: "ponzu-dev" });
      if (path.endsWith("/domains/custom")) return ok(bucket.custom);
      if (path.endsWith("/domains/managed")) return ok(bucket.managed);
      if (path.endsWith("/cors")) return ok(bucket.cors);
      if (path.endsWith("/lifecycle")) return ok(bucket.lifecycle);
      if (path === "/zones")
        return ok([{ id: "zone-1", name: "ponzu.cloud" }], {
          result_info: { page: 1, per_page: 20, count: 1, total_count: 1 },
        });
      if (path === "/zones/zone-1/rulesets/phases/http_response_headers_transform/entrypoint") {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10003, message: "not found" }],
            messages: [],
            result: null,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (path === `/accounts/${ACCOUNT}/tokens`) {
        // The SDK asks for page after page until one comes back empty, as Cloudflare's does.
        const page = Number(url.searchParams.get("page") ?? "1");
        return ok(
          page === 1
            ? [
                {
                  id: "token-id-is-the-r2-access-key",
                  name: "ponzu-dev",
                  ...(dev.tokens as object[])[0],
                },
              ]
            : [],
          { result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 } },
        );
      }
      return new Response("{}", { status: 500 });
    }) as typeof globalThis.fetch;
    const observed = await fetchCloudflare(ctx(fake), desired("dev"));
    expect(seen.every((line) => line.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("token-id-is-the-r2-access-key");
    expect(statuses(evaluateCloudflare(desired("dev"), observed))).toEqual(
      statuses(evaluateCloudflare(desired("dev"), observeCloudflare(dev))),
    );
  });

  test("an error carries Cloudflare's status, never its body", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 9109, message: "token cf-test-token is invalid" }],
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    await expect(fetchCloudflare(ctx(fake), desired("dev"))).rejects.toThrow(
      /^Cloudflare answered 403$/,
    );
  });
});
