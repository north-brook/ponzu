import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironments, loadInfra } from "../desired.ts";
import type { CheckContext, Finding } from "./finding.ts";
import {
  evaluateWorkos,
  fetchWorkos,
  REDIRECT_URIS,
  trimLocation,
  WorkosAnswers,
  type WorkosDesired,
  workosDesired,
} from "./workos.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const raw = () =>
  JSON.parse(readFileSync(join(FIXTURES, "workos", "dev-answers.json"), "utf8")) as {
    refusedHop: WorkosAnswers["hops"][number];
  };
const recorded = (): WorkosAnswers => WorkosAnswers.parse(raw());
const infra = loadInfra();
const desired = (env: "dev" | "production"): WorkosDesired => workosDesired({ env, infra });
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const DEV_APP_CLIENT = "Iv23liHZazTP8ngUY968";

/** Production once founder steps D6 and D7 are done (the filled fixture's client id). */
function filledProduction(): WorkosDesired {
  const filled = loadEnvironments(join(FIXTURES, "environments-filled.json"));
  return { ...desired("production"), clientId: filled.environments.production.workosClientId };
}

describe("evaluate on dev's recorded answers", () => {
  test("every line, exactly: WorkOS staging sends both redirect URIs to ponzu-dev's client id", () => {
    expect(evaluateWorkos(desired("dev"), recorded())).toEqual([
      {
        id: "workos.jwks",
        area: "workos",
        status: "ok",
        says: "the JWKS for client_01M72Y00K1VV63G6V5D25YCE6K has 1 signing key",
      },
      {
        id: "workos.authorize.loopback",
        area: "workos",
        status: "ok",
        says: `sign-in through the Mac's loopback reaches GitHub with the App's client id ${DEV_APP_CLIENT}`,
      },
      {
        id: "workos.authorize.scheme",
        area: "workos",
        status: "ok",
        says: `sign-in through the phone's ponzu:// reaches GitHub with the App's client id ${DEV_APP_CLIENT}`,
      },
      {
        id: "workos.methods",
        area: "workos",
        status: "manual",
        says: "confirm every WorkOS sign-in method but GitHub is off, and default emails are off, for dev",
        fix: "WorkOS › Authentication, and WorkOS › Emails",
      },
    ]);
  });

  test("the recorded App client id is the one GitHub shows for ponzu-dev", () => {
    const github = JSON.parse(
      readFileSync(join(FIXTURES, "github", "dev-answers.json"), "utf8"),
    ) as { app: { client_id: string } };
    expect(recorded().appClientId).toBe(github.app.client_id);
  });
});

describe("the authorize hop", () => {
  const withHop = (index: number, hop: Partial<WorkosAnswers["hops"][number]>) => {
    const answers = recorded();
    answers.hops[index] = { ...(answers.hops[index] as WorkosAnswers["hops"][number]), ...hop };
    return byId(evaluateWorkos(desired("dev"), answers));
  };

  test("a redirect to GitHub with a client id other than the App's fails", () => {
    const f = withHop(0, {
      location: "https://github.com/login/oauth/authorize?client_id=Iv1.workosdefault0000",
    });
    expect(f["workos.authorize.loopback"]).toEqual({
      id: "workos.authorize.loopback",
      area: "workos",
      status: "fail",
      says: `sign-in through the Mac's loopback reaches GitHub with the client id Iv1.workosdefault0000, not the App's ${DEV_APP_CLIENT}`,
      fix: "WorkOS › Authentication › GitHub: use the App's client id and secret (founder step D7)",
    });
  });

  test("a 200 error page fails", () => {
    const f = withHop(1, { status: 200, location: null });
    expect(f["workos.authorize.scheme"]?.status).toBe("fail");
    expect(f["workos.authorize.scheme"]?.says).toBe(
      "sign-in through the phone's ponzu:// answered 200 rather than a redirect to GitHub (an error page)",
    );
  });

  test("a redirect URI WorkOS does not allow (recorded) fails, naming the redirect step", () => {
    const refused = raw().refusedHop;
    const f = withHop(1, { status: refused.status, location: refused.location });
    expect(f["workos.authorize.scheme"]?.status).toBe("fail");
    expect(f["workos.authorize.scheme"]?.says).toBe(
      "WorkOS refuses the phone's ponzu:// redirect URI ponzu://auth/callback",
    );
    expect(f["workos.authorize.scheme"]?.fix).toContain("founder step D7");
  });

  test("a redirect elsewhere than GitHub fails", () => {
    const f = withHop(0, { location: "https://evil.example/login/oauth/authorize?client_id=x" });
    expect(f["workos.authorize.loopback"]?.says).toBe(
      "sign-in through the Mac's loopback goes to https://evil.example/login/oauth/authorize, not GitHub",
    );
  });

  test("a hop not tried fails", () => {
    const answers = recorded();
    answers.hops = [];
    const f = byId(evaluateWorkos(desired("dev"), answers));
    expect(f["workos.authorize.loopback"]?.status).toBe("fail");
    expect(f["workos.authorize.scheme"]?.status).toBe("fail");
  });

  test("a JWKS that answers 404 or holds no key fails", () => {
    expect(
      byId(evaluateWorkos(desired("dev"), { ...recorded(), jwks: { status: 404, keys: [] } }))[
        "workos.jwks"
      ]?.says,
    ).toBe("the JWKS for client_01M72Y00K1VV63G6V5D25YCE6K answered 404");
    expect(
      byId(evaluateWorkos(desired("dev"), { ...recorded(), jwks: { status: 200, keys: [] } }))[
        "workos.jwks"
      ]?.status,
    ).toBe("fail");
  });
});

describe("production", () => {
  test("with no client id in infra: pending and manual, and nothing is read", async () => {
    const lines = evaluateWorkos(desired("production"), { hops: [], jwks: null });
    expect(lines.map((l) => `${l.status} ${l.id}`)).toEqual([
      "pending workos.client",
      "manual workos.methods",
    ]);
    let calls = 0;
    const fetch = (async () => {
      calls++;
      throw new Error("no network");
    }) as unknown as typeof globalThis.fetch;
    await fetchWorkos(ctx(fetch, "production"), desired("production"));
    expect(calls).toBe(0);
  });

  test("with a client id but no App yet, the hop is pending on the App", () => {
    const lines = evaluateWorkos(filledProduction(), { ...recorded(), appClientId: null });
    expect(byId(lines)["workos.authorize"]?.status).toBe("pending");
    expect(byId(lines)["workos.authorize"]?.fix).toBe("founder steps D6 and D7");
  });

  test("dev's App missing fails rather than pending", () => {
    const lines = evaluateWorkos(desired("dev"), { ...recorded(), appClientId: null });
    expect(byId(lines)["workos.authorize"]?.status).toBe("fail");
  });
});

// --- fetch, against a fake WorkOS and GitHub ----------------------------------------------------

function ctx(fetch: typeof globalThis.fetch, env: "dev" | "production" = "dev"): CheckContext {
  return {
    env,
    infra,
    credentials: {},
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
    deep: false,
  };
}

describe("fetchWorkos", () => {
  test("asks WorkOS for each redirect URI without following, and keeps no key material", async () => {
    const seen: { url: URL; redirect?: RequestRedirect; method: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url, redirect: init?.redirect, method: init?.method ?? "GET" });
      if (url.host === "api.github.com") {
        return Response.json({
          slug: "ponzu-dev",
          name: "Ponzu Dev",
          client_id: DEV_APP_CLIENT,
          permissions: {},
          events: [],
        });
      }
      if (url.pathname === "/user_management/authorize") {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://github.com/login/oauth/authorize?client_id=${DEV_APP_CLIENT}&state=opaque-state&redirect_uri=x`,
          },
        });
      }
      if (url.pathname.startsWith("/sso/jwks/")) {
        return Response.json({
          keys: [{ kty: "RSA", use: "sig", alg: "RS256", n: "secret-ish", e: "AQAB" }],
        });
      }
      return new Response("no fake", { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const got = await fetchWorkos(ctx(fetch), desired("dev"));
    const authorize = seen.filter((s) => s.url.pathname === "/user_management/authorize");
    expect(authorize.map((s) => s.url.searchParams.get("redirect_uri"))).toEqual(
      REDIRECT_URIS.map((r) => r.uri),
    );
    for (const s of authorize) {
      expect(s.url.host).toBe("api.workos.com");
      expect(s.redirect).toBe("manual");
      expect(s.url.searchParams.get("provider")).toBe("GitHubOAuth");
      expect(s.url.searchParams.get("client_id")).toBe("client_01M72Y00K1VV63G6V5D25YCE6K");
      expect(s.url.searchParams.get("code_challenge_method")).toBe("S256");
    }
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(got.appClientId).toBe(DEV_APP_CLIENT);
    expect(got.jwks).toEqual({ status: 200, keys: [{ kty: "RSA", use: "sig", alg: "RS256" }] });
    expect(got.hops[0]?.location).toBe(
      `https://github.com/login/oauth/authorize?client_id=${DEV_APP_CLIENT}&redirect_uri=x`,
    );
    expect(
      evaluateWorkos(desired("dev"), got).every((l) => l.status === "ok" || l.status === "manual"),
    ).toBe(true);
  });

  test("trimLocation drops the state and challenge, and leaves other text alone", () => {
    expect(trimLocation("https://a.example/p?state=s&client_id=c&code_challenge=x")).toBe(
      "https://a.example/p?client_id=c",
    );
    expect(trimLocation(null)).toBeNull();
    expect(trimLocation("not a url")).toBe("not a url");
  });
});
