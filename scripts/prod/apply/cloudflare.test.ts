import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadInfra } from "../desired.ts";
import { headersArea, headersRule, planHeaders, planR2, r2Area } from "./cloudflare.ts";
import { applyContext, asSeen, fakeNetwork, Reply, type Routes, written } from "./testing.ts";

const infra = loadInfra();
const dev = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "cloudflare", "dev-account.json"), "utf8"),
);
const ACCOUNT = "00000000000000000000000000000000";
const TOKEN = "cf-test-token-0123456789";
const creds = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const API = "https://api.cloudflare.com/client/v4";
const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...extra,
});
const PHASE = "/client/v4/zones/zone-1/rulesets/phases/http_response_headers_transform/entrypoint";

/** Cloudflare answering with dev's account, its bucket's CORS and lifecycle mutable. */
function cloudflare(
  state = structuredClone(dev.buckets["ponzu-dev"]),
  zoneRules: unknown[] = [],
): Routes {
  const b = `/client/v4/accounts/${ACCOUNT}/r2/buckets/ponzu-dev`;
  return {
    [`GET ${b}`]: ok({ name: "ponzu-dev" }),
    [`GET ${b}/domains/custom`]: ok(state.custom),
    [`GET ${b}/domains/managed`]: ok(state.managed),
    [`GET ${b}/cors`]: () => ok(state.cors),
    [`GET ${b}/lifecycle`]: () => ok(state.lifecycle),
    [`PUT ${b}/cors`]: (s: { body: unknown }) => {
      state.cors = s.body;
      return ok({});
    },
    [`PUT ${b}/lifecycle`]: (s: { body: unknown }) => {
      state.lifecycle = s.body;
      return ok({});
    },
    "GET /client/v4/zones": ok([{ id: "zone-1", name: "ponzu.cloud" }], {
      result_info: { page: 1, per_page: 20, count: 1, total_count: 1 },
    }),
    [`GET ${PHASE}`]: () =>
      zoneRules.length
        ? ok({ id: "rs-1", rules: zoneRules })
        : new Reply(404, {
            success: false,
            errors: [{ code: 10003, message: "not found" }],
            result: null,
          }),
    [`PUT ${PHASE}`]: (s: { body: { rules: unknown[] } }) => {
      zoneRules.splice(0, zoneRules.length, ...s.body.rules);
      return ok({ id: "rs-1", rules: zoneRules });
    },
    [`GET /client/v4/accounts/${ACCOUNT}/tokens`]: (s: { query: string }) =>
      ok(
        new URLSearchParams(s.query).get("page") === "1" || !s.query.includes("page=")
          ? dev.tokens
          : [],
        {
          result_info: { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
        },
      ),
  } as Routes;
}

describe("apply r2", () => {
  test("dev's recorded bucket: CORS already matches; its lifecycle is replaced with the file's, exactly", async () => {
    const net = fakeNetwork(cloudflare());
    const plan = await planR2(applyContext("dev", creds, net.fetch));
    expect(plan.notes).toContain("ponzu-dev's CORS is infra/r2/cors.json's");
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PUT",
        url: `${API}/accounts/${ACCOUNT}/r2/buckets/ponzu-dev/lifecycle`,
        body: {
          rules: [
            {
              id: "staging-1d",
              enabled: true,
              conditions: { prefix: "staging/" },
              deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
            },
            {
              id: "incomplete-uploads-1d",
              enabled: true,
              conditions: { prefix: "" },
              abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
            },
          ],
        },
      },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("CORS that differs is replaced with the file's", async () => {
    const state = structuredClone(dev.buckets["ponzu-dev"]);
    state.cors = { rules: [] };
    const plan = await planR2(applyContext("dev", creds, fakeNetwork(cloudflare(state)).fetch));
    expect(plan.changes[0]?.request).toEqual({
      method: "PUT",
      url: `${API}/accounts/${ACCOUNT}/r2/buckets/ponzu-dev/cors`,
      body: infra["r2/cors.json"],
    });
  });

  test("--yes sends what the dry run printed; then the check's CORS and lifecycle lines are ok", async () => {
    const state = structuredClone(dev.buckets["ponzu-dev"]);
    state.cors = { rules: [] };
    const net = fakeNetwork(cloudflare(state));
    const ctx = applyContext("dev", creds, net.fetch);
    const plan = await planR2(ctx);
    for (const change of plan.changes) await change.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    const lines = await r2Area.verify!(ctx);
    expect(lines.map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok cloudflare.r2.assets.cors",
      "ok cloudflare.r2.assets.lifecycle",
    ]);
  });

  test("production before D4: no bucket, nothing to send", async () => {
    const net = fakeNetwork({
      ...cloudflare(),
      [`GET /client/v4/accounts/${ACCOUNT}/r2/buckets/ponzu-assets`]: new Reply(404, {
        success: false,
        errors: [{ code: 10006, message: "bucket not found" }],
        result: null,
      }),
      [`GET /client/v4/accounts/${ACCOUNT}/r2/buckets/ponzu-private`]: new Reply(404, {
        success: false,
        errors: [{ code: 10006, message: "bucket not found" }],
        result: null,
      }),
    });
    const plan = await planR2(applyContext("production", creds, net.fetch));
    expect(plan.changes).toEqual([]);
    expect(plan.notes[0]).toContain("founder step D4");
  });
});

describe("apply cloudflare-headers", () => {
  const values = infra["cloudflare/assets-headers.json"].headers;
  const other = {
    id: "rule-other",
    version: "3",
    last_updated: "2026-01-01T00:00:00Z",
    action: "rewrite",
    expression: '(http.host eq "ponzu.cloud")',
    description: "someone else's",
    enabled: true,
    action_parameters: { headers: { "X-Other": { operation: "set", value: "1" } } },
  };

  test("no rule on the host: one PUT keeping every other rule, these bodies exactly", async () => {
    const net = fakeNetwork(cloudflare(undefined, [other]));
    const plan = await planHeaders(applyContext("production", creds, net.fetch));
    const { version: _v, last_updated: _l, ...otherWritable } = other;
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PUT",
        url: `${API}/zones/zone-1/rulesets/phases/http_response_headers_transform/entrypoint`,
        body: {
          rules: [
            otherWritable,
            {
              action: "rewrite",
              expression: '(http.host eq "assets.ponzu.cloud")',
              description:
                "Ponzu: the asset host's headers (infra/cloudflare/assets-headers.json) on assets.ponzu.cloud",
              enabled: true,
              action_parameters: {
                headers: {
                  "Content-Security-Policy": {
                    operation: "set",
                    value: values["Content-Security-Policy"],
                  },
                  "X-Content-Type-Options": { operation: "set", value: "nosniff" },
                },
              },
            },
          ],
        },
      },
    ]);
  });

  test("a wrong rule on the host is replaced in place, keeping its id", async () => {
    const wrong = {
      ...headersRule("assets.ponzu.cloud", { "X-Content-Type-Options": "nosniff" }),
      id: "rule-ours",
    };
    const net = fakeNetwork(cloudflare(undefined, [wrong]));
    const plan = await planHeaders(applyContext("production", creds, net.fetch));
    const rules = (plan.changes[0]!.request.body as { rules: { id?: string }[] }).rules;
    expect(rules).toEqual([{ id: "rule-ours", ...headersRule("assets.ponzu.cloud", values) }]);
  });

  test("--yes sends it, then the check's header line is ok and nothing is left to do", async () => {
    const net = fakeNetwork(cloudflare(undefined, [other]));
    const ctx = applyContext("production", creds, net.fetch);
    const plan = await planHeaders(ctx);
    await plan.changes[0]!.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    expect((await headersArea.verify!(ctx)).map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok cloudflare.headers",
    ]);
    expect((await planHeaders(ctx)).changes).toEqual([]);
  });
});
