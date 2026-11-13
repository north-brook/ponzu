import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadInfra } from "../desired.ts";
import { infraBeforeLaunch } from "../fixtures/infra.ts";
import {
  type CertificateReader,
  type DnsObserved,
  dnsDesired,
  evaluateDns,
  fetchDns,
  type HostObserved,
} from "./dns.ts";
import type { CheckContext, Finding } from "./finding.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "dns");
const fixture = (name: string): DnsObserved =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const infra = infraBeforeLaunch();
const triples = (findings: Finding[]) => findings.map((f) => [f.status, f.id, f.says]);
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));

function withHost(
  observed: DnsObserved,
  host: string,
  change: (h: HostObserved) => void,
): DnsObserved {
  const copy = structuredClone(observed);
  change(copy.hosts.find((h) => h.host === host)!);
  return copy;
}

describe("evaluate on what was recorded", () => {
  test("dev: every line, exactly", () => {
    expect(triples(evaluateDns(dnsDesired({ env: "dev", infra }), fixture("dev.json")))).toEqual([
      [
        "ok",
        "dns.api.ponzu.design",
        "served by Vercel, certificate valid until 2027-01-18, answers 200",
      ],
      [
        "ok",
        "dns.assets-dev.ponzu.cloud",
        "resolves, certificate valid until 2027-02-08, answers 404, without the header rule, which dev may go without (founder step B6)",
      ],
      [
        "ok",
        "dns.ponzu.design",
        "served by Vercel, certificate valid until 2027-01-18, answers 200",
      ],
    ]);
  });

  test("production before its founder steps: pending lines, not passes", () => {
    const findings = evaluateDns(
      dnsDesired({ env: "production", infra }),
      fixture("production.json"),
    );
    expect(triples(findings)).toEqual([
      [
        "pending",
        "dns.api.ponzu.design",
        "api.ponzu.design is still listed as dev's in infra/environments.json",
      ],
      ["pending", "dns.assets.ponzu.cloud", "answers 525: no bucket answers behind it"],
      [
        "ok",
        "dns.ponzu.design",
        "served by Vercel, certificate valid until 2027-01-18, answers 200",
      ],
    ]);
    expect(byId(findings)["dns.assets.ponzu.cloud"]?.fix).toBe("founder step D4");
  });
});

describe("hand-made failures", () => {
  const production = dnsDesired({ env: "production", infra });
  const dev = dnsDesired({ env: "dev", infra });

  test("production's assets host answering without the CSP fails", () => {
    const observed = withHost(fixture("production.json"), "assets.ponzu.cloud", (h) => {
      h.https = { status: 404, server: "cloudflare", headers: { "content-security-policy": null } };
    });
    expect(byId(evaluateDns(production, observed))["dns.assets.ponzu.cloud"]).toMatchObject({
      status: "fail",
      says: "lacks the header rule: Content-Security-Policy and X-Content-Type-Options are missing or different",
      fix: "bun scripts/prod/apply.ts cloudflare-headers --env production",
    });
  });

  test("production's assets host with the rule passes", () => {
    const rule = infra["cloudflare/assets-headers.json"].headers;
    const observed = withHost(fixture("production.json"), "assets.ponzu.cloud", (h) => {
      h.https = {
        status: 404,
        server: "cloudflare",
        headers: {
          "content-security-policy": rule["Content-Security-Policy"] ?? null,
          "x-content-type-options": rule["X-Content-Type-Options"] ?? null,
        },
      };
    });
    expect(byId(evaluateDns(production, observed))["dns.assets.ponzu.cloud"]?.says).toBe(
      "resolves, certificate valid until 2027-02-08, answers 404 with the header rule",
    );
  });

  test("a certificate inside its last 14 days fails", () => {
    const observed = withHost(fixture("dev.json"), "ponzu.design", (h) => {
      h.certificate = { authorized: true, error: null, validTo: "2026-11-20T00:00:00.000Z" };
    });
    expect(byId(evaluateDns(dev, observed))["dns.ponzu.design"]?.says).toBe(
      "its certificate expires in 7 days",
    );
  });

  test("an untrusted certificate fails", () => {
    const observed = withHost(fixture("dev.json"), "api.ponzu.design", (h) => {
      h.certificate = { authorized: false, error: "CERT_HAS_EXPIRED", validTo: null };
    });
    expect(byId(evaluateDns(dev, observed))["dns.api.ponzu.design"]?.says).toBe(
      "presents no valid certificate: CERT_HAS_EXPIRED",
    );
  });

  test("a name that does not exist fails on dev, and is pending on production", () => {
    const gone = (observed: DnsObserved, host: string) =>
      withHost(observed, host, (h) => {
        h.dns = { status: 3, addresses: [] };
        h.certificate = null;
        h.https = null;
      });
    expect(
      byId(evaluateDns(dev, gone(fixture("dev.json"), "assets-dev.ponzu.cloud")))[
        "dns.assets-dev.ponzu.cloud"
      ]?.status,
    ).toBe("fail");
    expect(
      byId(evaluateDns(production, gone(fixture("production.json"), "assets.ponzu.cloud")))[
        "dns.assets.ponzu.cloud"
      ]?.status,
    ).toBe("pending");
  });

  test("an API domain Vercel has no project for fails on dev", () => {
    const observed = withHost(fixture("dev.json"), "api.ponzu.design", (h) => {
      h.https = {
        status: 404,
        server: "Vercel",
        headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" },
      };
    });
    expect(byId(evaluateDns(dev, observed))["dns.api.ponzu.design"]).toMatchObject({
      status: "fail",
      says: "reaches Vercel, but no project serves it (DEPLOYMENT_NOT_FOUND)",
    });
  });

  test("an API domain served by something else fails", () => {
    const observed = withHost(fixture("dev.json"), "api.ponzu.design", (h) => {
      h.https = { status: 200, server: "nginx", headers: {} };
    });
    expect(byId(evaluateDns(dev, observed))["dns.api.ponzu.design"]?.says).toBe(
      "is served by nginx, not Vercel",
    );
  });

  test("infra naming two assets hosts fails before anything is read", () => {
    const copy = structuredClone(infra);
    copy["environments.json"].environments.dev.assetsUrl = "https://elsewhere.ponzu.cloud";
    const findings = evaluateDns(dnsDesired({ env: "dev", infra: copy }), fixture("dev.json"));
    expect(findings[0]).toMatchObject({ id: "dns.infra", status: "fail" });
  });
});

describe("fetchDns", () => {
  test("asks DNS-over-HTTPS, then the certificate and the page, and never asks a name that is not this environment's yet", async () => {
    const seen: string[] = [];
    const ctx: CheckContext = {
      env: "production",
      infra,
      credentials: {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url);
        seen.push(`${url.host}${url.pathname}${url.search}`);
        if (url.host === "cloudflare-dns.com") {
          return new Response(
            JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] }),
          );
        }
        return new Response("", { status: 200, headers: { server: "Vercel" } });
      }) as typeof fetch,
      now: () => new Date("2026-11-12T12:00:00Z"),
      deep: false,
    };
    const certs: string[] = [];
    const reader: CertificateReader = async (host) => {
      certs.push(host);
      return { authorized: true, error: null, validTo: "2027-01-01T00:00:00.000Z" };
    };
    const observed = await fetchDns(ctx, dnsDesired(ctx), reader);
    expect(seen).toEqual([
      "cloudflare-dns.com/dns-query?name=assets.ponzu.cloud&type=A",
      "cloudflare-dns.com/dns-query?name=ponzu.design&type=A",
      "assets.ponzu.cloud/ponzu-selfcheck/absent",
      "ponzu.design/",
    ]);
    expect(certs).toEqual(["assets.ponzu.cloud", "ponzu.design"]);
    expect(observed.checkedAt).toBe("2026-11-12T12:00:00.000Z");
    expect(observed.hosts.map((h) => h.host)).toEqual(["assets.ponzu.cloud", "ponzu.design"]);
  });
});

describe("today's infra, in one project", () => {
  test("each environment checks its own API domain, and production's is not waiting on dev", () => {
    const today = loadInfra();
    const api = (env: "dev" | "production") =>
      dnsDesired({ env, infra: today })
        .hosts.filter((h) => h.role === "api")
        .map((h) => [h.host, h.notYet ?? null]);
    expect(api("dev")).toEqual([["api-dev.ponzu.design", null]]);
    expect(api("production")).toEqual([["api.ponzu.design", null]]);
  });
});
