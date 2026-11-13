import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadInfra } from "../desired.ts";
import { infraBeforeLaunch } from "../fixtures/infra.ts";
import type { CheckContext, Finding } from "./finding.ts";
import {
  covers,
  EMPTY_ANSWERS,
  evaluateGithub,
  fetchGithub,
  GithubAnswers,
  type GithubDesired,
  type GithubObserved,
  githubDesired,
  parseExpiry,
  RELEASE_TOKEN_WARN_DAYS,
} from "./github.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const recorded = (): GithubAnswers =>
  GithubAnswers.parse(
    JSON.parse(readFileSync(join(FIXTURES, "github", "dev-answers.json"), "utf8")),
  );
const infra = infraBeforeLaunch();
const desired = (env: "dev" | "production"): GithubDesired => githubDesired({ env, infra });
const NOW = "2026-11-12T15:00:00.000Z";
const statuses = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.id}`);
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));

function observed(answers: GithubAnswers, extra: Partial<GithubObserved> = {}): GithubObserved {
  return { checkedAt: NOW, token: true, answers, releaseToken: null, ...extra };
}

/** The repository as it is once founder step D12 is done: what infra asks for, all there. */
function afterD12(): GithubAnswers {
  const answers = recorded();
  const repo = infra["github/repo.json"];
  return {
    ...answers,
    rulesets: [...answers.rulesets, { ...infra["github/ruleset-cloud.json"], bypass_actors: [] }],
    environments: [
      ...answers.environments,
      {
        name: "dev",
        protection_rules: [{ type: "branch_policy", reviewers: [] }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        branch_policies: [{ name: "main", type: "branch" }],
        secrets: ["VERCEL_TOKEN"],
      },
      {
        name: "production",
        protection_rules: [
          { type: "required_reviewers", reviewers: [{}] },
          { type: "branch_policy", reviewers: [] },
        ],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        branch_policies: [{ name: "main", type: "branch" }],
        secrets: ["NEON_API_KEY", "VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_TOKEN_PRODUCTION"],
      },
    ],
    variables: [...repo.variables],
    secrets: [...repo.secrets],
  };
}

describe("the recorded ponzu-dev App and its manifest", () => {
  test("the public /apps/ponzu-dev equals infra/github-app/ponzu-dev.json", () => {
    const app = recorded().app;
    const manifest = infra["github-app/ponzu-dev.json"];
    expect(app?.slug).toBe("ponzu-dev");
    expect(app?.name).toBe(manifest.name);
    expect(app?.external_url).toBe(manifest.url);
    expect(app?.permissions).toEqual(manifest.default_permissions);
    expect([...(app?.events ?? [])].sort()).toEqual(manifest.default_events);
  });

  test("the manifest's webhook and setup URLs are on dev's API", () => {
    const manifest = infra["github-app/ponzu-dev.json"];
    // The manifest is what the App should be now, so it follows today's infra, not the recording's.
    const api = loadInfra()["environments.json"].environments.dev.apiUrl;
    expect(manifest.hook_attributes.url).toBe(`${api}/v1/github/webhook`);
    expect(manifest.setup_url).toBe(`${api}/v1/github/setup`);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(manifest.setup_on_update).toBe(true);
  });
});

describe("production's App and its manifest", () => {
  test("ponzu.json is ponzu-dev.json but for its name and its API: the same permissions and events", () => {
    const { name, hook_attributes, setup_url, ...prod } = infra["github-app/ponzu.json"];
    const {
      name: devName,
      hook_attributes: devHook,
      setup_url: devSetup,
      ...dev
    } = infra["github-app/ponzu-dev.json"];
    expect(name).toBe("Ponzu");
    expect(devName).toBe("Ponzu Dev");
    expect(prod).toEqual(dev);
    // Each App's webhook and setup URL are on its own environment's API, never the other's.
    expect(hook_attributes.url).not.toBe(devHook.url);
    expect(setup_url).not.toBe(devSetup);
  });

  test("its webhook and setup URLs are on production's API", () => {
    const manifest = infra["github-app/ponzu.json"];
    const api = infra["environments.json"].environments.production.apiUrl;
    expect(manifest.hook_attributes.url).toBe(`${api}/v1/github/webhook`);
    expect(manifest.setup_url).toBe(`${api}/v1/github/setup`);
    expect(manifest.public).toBe(true);
  });

  test("each environment's App is judged against its own file", () => {
    expect(desired("dev").manifestFile).toBe("github-app/ponzu-dev.json");
    expect(desired("production").manifestFile).toBe("github-app/ponzu.json");
    expect(desired("production").manifest).toEqual(infra["github-app/ponzu.json"]);
    // A slug infra has no file for falls back to ponzu-dev's permissions and events.
    const other = githubDesired({
      env: "production",
      infra: {
        ...infra,
        "environments.json": {
          ...infra["environments.json"],
          environments: {
            ...infra["environments.json"].environments,
            production: {
              ...infra["environments.json"].environments.production,
              githubAppSlug: "ponzu-cloud",
            },
          },
        },
      },
    });
    expect(other.manifestFile).toBe("github-app/ponzu-dev.json");
  });
});

describe("evaluate on dev's recorded answers", () => {
  test("every line, exactly", () => {
    expect(evaluateGithub(desired("dev"), observed(recorded()))).toEqual([
      {
        id: "github.app",
        area: "github",
        status: "ok",
        says: 'the GitHub App "ponzu-dev" (Ponzu Dev) is north-brook\'s',
      },
      {
        id: "github.app.permissions",
        area: "github",
        status: "ok",
        says: "ponzu-dev asks for exactly the manifest's 7 permissions",
      },
      {
        id: "github.app.events",
        area: "github",
        status: "ok",
        says: "ponzu-dev subscribes to exactly the manifest's 10 events",
      },
      {
        id: "github.app.homepage",
        area: "github",
        status: "ok",
        says: "ponzu-dev's homepage is https://ponzu.design",
      },
      {
        id: "github.merge",
        area: "github",
        status: "ok",
        says: "north-brook/ponzu squash-merges only, as infra/github/repo.json says",
      },
      {
        id: "github.ruleset.main",
        area: "github",
        status: "ok",
        says: 'the ruleset "Protect main" protects main as infra says',
      },
      {
        id: "github.ruleset.cloud",
        area: "github",
        status: "pending",
        says: 'the ruleset "Protect cloud" does not exist yet',
        fix: "founder step D12: bun scripts/prod/apply.ts github-rulesets --yes",
      },
      {
        id: "github.environment.release-signing",
        area: "github",
        status: "ok",
        says: 'the environment "release-signing" deploys only from main and holds its 5 secrets',
      },
      {
        id: "github.environment.dev",
        area: "github",
        status: "pending",
        says: 'the environment "dev" does not exist yet',
        fix: "GitHub › the repository › Settings › Environments › dev (make it, limited to cloud, before setting API_DEPLOY=true)",
      },
      {
        id: "github.environment.production",
        area: "github",
        status: "pending",
        says: 'the environment "production" does not exist yet',
        fix: "GitHub › the repository › Settings › Environments › production (founder step D12)",
      },
      {
        id: "github.variables",
        area: "github",
        status: "pending",
        says: "8 of the 11 repository variables the workflows read are not set: API_DEPLOY, API_DEPLOY_PRODUCTION, NEON_PROJECT_ID, PONZU_APP_POSTHOG_CLI_PROJECT_ID, PONZU_APP_POSTHOG_HOST, PONZU_APP_POSTHOG_KEY, PONZU_APP_POSTHOG_REPLAY and RELEASES_HELD (also set, not in infra/github/repo.json: PONZU_POSTHOG_KEY)",
        fix: "gh variable set <NAME> --repo north-brook/ponzu (docs/production.md › Env and secrets; production's are founder step D12)",
      },
      {
        id: "github.secrets",
        area: "github",
        status: "pending",
        says: "2 of the 5 repository secrets the workflows read are not set: NEON_API_KEY and PONZU_APP_POSTHOG_CLI_API_KEY",
        fix: "gh secret set <NAME> --repo north-brook/ponzu (docs/production.md › Env and secrets; production's are founder step D12)",
      },
      {
        id: "github.release-token",
        area: "github",
        status: "skipped",
        says: "skipped (no RELEASE_TOKEN): its expiry is read from GitHub's answer to the token itself",
        fix: "RELEASE_TOKEN=<the token> bun scripts/prod/check.ts …",
      },
    ]);
  });

  test("after founder step D12, every repository line is ok", () => {
    const lines = evaluateGithub(
      desired("dev"),
      observed(afterD12(), {
        releaseToken: { status: 200, expiresAt: "2027-03-01T00:00:00.000Z" },
      }),
    );
    expect(lines.filter((l) => l.status !== "ok")).toEqual([]);
    expect(byId(lines)["github.environment.production"]?.says).toBe(
      'the environment "production" deploys only from main, with a required reviewer, and holds its 3 secrets',
    );
    expect(byId(lines)["github.release-token"]?.says).toBe(
      "RELEASE_TOKEN expires on 2027-03-01, in 108 days",
    );
  });

  test("production: no App yet is pending, and nothing about it is judged", () => {
    const answers = { ...recorded(), app: null };
    const lines = evaluateGithub(desired("production"), observed(answers));
    expect(lines[0]).toEqual({
      id: "github.app",
      area: "github",
      status: "pending",
      says: 'the GitHub App "ponzu" does not exist yet',
      fix: "founder step D6: bun scripts/prod/github-app.ts create --env production",
    });
    expect(statuses(lines).filter((s) => s.includes("github.app."))).toEqual([]);
  });

  test("dev: an App GitHub does not show fails", () => {
    const lines = evaluateGithub(desired("dev"), observed({ ...recorded(), app: null }));
    expect(byId(lines)["github.app"]?.status).toBe("fail");
  });
});

describe("the App against its manifest", () => {
  const app = () => recorded().app as NonNullable<GithubAnswers["app"]>;
  const judge = (changed: Partial<NonNullable<GithubAnswers["app"]>>) =>
    byId(
      evaluateGithub(desired("dev"), observed({ ...recorded(), app: { ...app(), ...changed } })),
    );

  test("a permission the manifest does not grant fails, naming it", () => {
    const f = judge({ permissions: { ...app().permissions, administration: "write" } });
    expect(f["github.app.permissions"]?.status).toBe("fail");
    expect(f["github.app.permissions"]?.says).toBe(
      "ponzu-dev asks for more than the manifest: administration: write",
    );
  });

  test("a stronger level of a granted permission fails", () => {
    const f = judge({ permissions: { ...app().permissions, checks: "write" } });
    expect(f["github.app.permissions"]?.says).toBe("ponzu-dev's checks is write, not read");
  });

  test("a permission the manifest grants and the App lacks fails", () => {
    const { members: _, ...rest } = app().permissions;
    const f = judge({ permissions: rest });
    expect(f["github.app.permissions"]?.says).toBe("ponzu-dev's members is not granted, not read");
  });

  test("an event more or less fails", () => {
    const f = judge({ events: [...app().events.filter((e) => e !== "push"), "issues"] });
    expect(f["github.app.events"]?.status).toBe("fail");
    expect(f["github.app.events"]?.says).toBe(
      "ponzu-dev does not subscribe to push; ponzu-dev also subscribes to issues",
    );
  });

  test("another owner or homepage fails", () => {
    const f = judge({ owner: { login: "someone-else" }, external_url: "https://example.com" });
    expect(f["github.app"]?.status).toBe("fail");
    expect(f["github.app.homepage"]?.status).toBe("fail");
  });
});

describe("the repository", () => {
  test("without a token the repository is one skipped line, and the App is still judged", () => {
    const lines = evaluateGithub(
      desired("dev"),
      observed({ ...EMPTY_ANSWERS, app: recorded().app }, { token: false }),
    );
    expect(statuses(lines)).toEqual([
      "ok github.app",
      "ok github.app.permissions",
      "ok github.app.events",
      "ok github.app.homepage",
      "skipped github.credentials",
      "skipped github.release-token",
    ]);
  });

  test("a merge setting that drifts fails", () => {
    const answers = recorded();
    answers.repository = { ...answers.repository, allow_merge_commit: true };
    const f = byId(evaluateGithub(desired("dev"), observed(answers)));
    expect(f["github.merge"]?.says).toBe(
      "north-brook/ponzu's merge settings: allow_merge_commit is true, not false",
    );
  });

  test("main's ruleset gone fails (it is not a founder step to come)", () => {
    const f = byId(evaluateGithub(desired("dev"), observed({ ...recorded(), rulesets: [] })));
    expect(f["github.ruleset.main"]?.status).toBe("fail");
  });

  test("a ruleset with a bypass, a dropped check or another enforcement fails", () => {
    const answers = afterD12();
    const cloud = answers.rulesets.find((r) => r.name === "Protect cloud");
    if (!cloud) throw new Error("no cloud ruleset");
    cloud.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
    cloud.enforcement = "evaluate";
    cloud.rules = cloud.rules.map((r) =>
      r.type === "required_status_checks"
        ? {
            ...r,
            parameters: {
              ...r.parameters,
              required_status_checks: [
                { context: "Conventional commit messages", integration_id: 15368 },
              ],
            },
          }
        : r,
    );
    const f = byId(evaluateGithub(desired("dev"), observed(answers)));
    expect(f["github.ruleset.cloud"]?.status).toBe("fail");
    expect(f["github.ruleset.cloud"]?.says).toBe(
      'the ruleset "Protect cloud": it is evaluate, not active, 1 actor may bypass it and its required_status_checks rule\'s settings differ',
    );
  });

  test("a ruleset whose bypass list the token cannot see fails rather than passing", () => {
    const answers = afterD12();
    const main = answers.rulesets.find((r) => r.name === "Protect main");
    if (main) main.bypass_actors = null;
    const f = byId(evaluateGithub(desired("dev"), observed(answers)));
    expect(f["github.ruleset.main"]?.says).toBe(
      'the ruleset "Protect main": the token cannot see who may bypass it',
    );
  });

  test("a live rule with parameters GitHub added since still matches", () => {
    const answers = recorded();
    const main = answers.rulesets[0];
    if (!main) throw new Error("no main ruleset");
    main.rules = main.rules.map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...r.parameters, newer_setting: false } }
        : r,
    );
    expect(
      byId(evaluateGithub(desired("dev"), observed(answers)))["github.ruleset.main"]?.status,
    ).toBe("ok");
  });

  test("production's environment without a reviewer, or open to any branch, fails", () => {
    const answers = afterD12();
    const production = answers.environments.find((e) => e.name === "production");
    if (!production) throw new Error("no production");
    production.protection_rules = [];
    production.deployment_branch_policy = null;
    production.secrets = ["VERCEL_TOKEN"];
    const f = byId(evaluateGithub(desired("dev"), observed(answers)));
    expect(f["github.environment.production"]).toEqual({
      id: "github.environment.production",
      area: "github",
      status: "fail",
      says: 'the environment "production": any branch may deploy to it, no one has to approve a run and it lacks the secrets NEON_API_KEY, VERCEL_AUTOMATION_BYPASS_SECRET and VERCEL_TOKEN_PRODUCTION',
      fix: "GitHub › the repository › Settings › Environments › production",
    });
  });

  test("an environment open to another branch too fails", () => {
    const answers = afterD12();
    const production = answers.environments.find((e) => e.name === "production");
    if (production) production.branch_policies.push({ name: "cloud", type: "branch" });
    const f = byId(evaluateGithub(desired("dev"), observed(answers)));
    expect(f["github.environment.production"]?.says).toBe(
      'the environment "production": main and cloud may deploy to it, not only main',
    );
  });

  test("covers: arrays as sets, the wanted object's keys only", () => {
    expect(covers([1, 2], [2, 1])).toBe(true);
    expect(covers([1, 2], [1, 2, 3])).toBe(false);
    expect(covers({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(covers({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    // A field GitHub adds inside an array item is ignored too; the item count still must match.
    expect(covers([{ a: 1 }], [{ a: 1, b: 2 }])).toBe(true);
    expect(covers([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(covers([{ a: 1, b: 2 }], [{ a: 1 }])).toBe(false);
    // Not greedy: the loose item does not take the only match the strict one has.
    expect(covers([{ a: 1 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1 }])).toBe(true);
    expect(
      covers(
        { required_status_checks: [{ context: "Check, typecheck, test" }] },
        { required_status_checks: [{ context: "Check, typecheck, test", integration_id: 15368 }] },
      ),
    ).toBe(true);
  });
});

describe("RELEASE_TOKEN", () => {
  const line = (releaseToken: GithubObserved["releaseToken"]) =>
    byId(evaluateGithub(desired("dev"), observed(recorded(), { releaseToken })))[
      "github.release-token"
    ];

  test(`under ${RELEASE_TOKEN_WARN_DAYS} days left fails, more is ok`, () => {
    expect(line({ status: 200, expiresAt: "2026-11-22T15:00:00.000Z" })).toEqual({
      id: "github.release-token",
      area: "github",
      status: "fail",
      says: "RELEASE_TOKEN expires on 2026-11-22, in 10 days, under 30",
      fix: "make a new token, set it as the repository secret RELEASE_TOKEN, and note its expiry",
    });
    expect(line({ status: 200, expiresAt: "2026-12-13T15:00:00.000Z" })?.status).toBe("ok");
  });

  test("refused, expired or never expiring", () => {
    expect(line({ status: 401, expiresAt: null })?.says).toBe(
      "GitHub refuses RELEASE_TOKEN: it has expired or was revoked",
    );
    expect(line({ status: 200, expiresAt: "2026-11-01T00:00:00.000Z" })?.says).toBe(
      "RELEASE_TOKEN expired on 2026-11-01",
    );
    expect(line({ status: 200, expiresAt: null })).toEqual({
      id: "github.release-token",
      area: "github",
      status: "ok",
      says: "RELEASE_TOKEN has no expiry date",
    });
  });

  test("GitHub's expiry header", () => {
    expect(parseExpiry("2026-12-01 10:00:00 UTC")).toBe("2026-12-01T10:00:00.000Z");
    expect(parseExpiry("2026-12-01 10:00:00 -0800")).toBe("2026-12-01T18:00:00.000Z");
    expect(parseExpiry("next tuesday")).toBe("next tuesday");
  });

  test("an expiry that will not parse fails rather than passing", () => {
    expect(line({ status: 200, expiresAt: "next tuesday" })?.status).toBe("fail");
  });
});

// --- fetch, against a fake GitHub ---------------------------------------------------------------

const GH = "gh-token-0123456789abcdef";
const RELEASE = "release-token-0123456789abcdef";

/** A GitHub that answers from the recorded fixture, and remembers every request. */
function fakeGithub(
  opts: {
    variables?: string[];
    app?: boolean;
    refuseEnvironments?: boolean;
    rateLimit?: number;
  } = {},
) {
  const answers = recorded();
  const requests: { method: string; url: string; auth: string | null }[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      auth: headers.get("authorization"),
    });
    const page = Number(url.searchParams.get("page") ?? "1");
    const path = url.pathname;
    if (path === "/apps/ponzu-dev") {
      return opts.app === false
        ? json({ message: "Not Found" }, 404)
        : json({ ...answers.app, id: 1, node_id: "x" });
    }
    if (path === "/rate_limit") {
      if (opts.rateLimit) return json({ message: `blocked ${RELEASE}` }, opts.rateLimit);
      return headers.get("authorization") === `token ${RELEASE}`
        ? json({ resources: {} }, 200, {
            "github-authentication-token-expiration": "2027-01-31 08:00:00 UTC",
          })
        : json({ message: "Bad credentials" }, 401);
    }
    const repo = "/repos/north-brook/ponzu";
    if (opts.refuseEnvironments && path.startsWith(`${repo}/environments`)) {
      return json({ message: `Resource not accessible by integration ${GH}` }, 403);
    }
    if (path === repo) return json({ ...answers.repository, id: 1, name: "ponzu" });
    if (path === `${repo}/rulesets`) return json(page === 1 ? [{ id: 25478973 }] : []);
    if (path === `${repo}/rulesets/25478973`) return json(answers.rulesets[0]);
    if (path === `${repo}/environments`) {
      return json({
        total_count: 1,
        environments:
          page === 1 ? answers.environments.map(({ branch_policies, secrets, ...e }) => e) : [],
      });
    }
    if (path === `${repo}/environments/release-signing/deployment-branch-policies`) {
      return json({ branch_policies: answers.environments[0]?.branch_policies ?? [] });
    }
    if (path === `${repo}/environments/release-signing/secrets`) {
      return json({ secrets: (answers.environments[0]?.secrets ?? []).map((name) => ({ name })) });
    }
    if (path === `${repo}/actions/variables`) {
      const all = opts.variables ?? answers.variables;
      const names = all.slice((page - 1) * 30, page * 30);
      return json({
        total_count: all.length,
        variables: names.map((name) => ({ name, value: "v" })),
      });
    }
    if (path === `${repo}/actions/secrets`) {
      return json({ secrets: page === 1 ? answers.secrets.map((name) => ({ name })) : [] });
    }
    return json({ message: `no fake for ${path}` }, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function ctx(
  fetch: typeof globalThis.fetch,
  credentials: CheckContext["credentials"],
): CheckContext {
  return {
    env: "dev",
    infra,
    credentials,
    fetch,
    now: () => new Date(NOW),
    deep: false,
  };
}

describe("fetchGithub", () => {
  test("reads exactly what the recorded fixture holds, with GETs only", async () => {
    const gh = fakeGithub();
    const got = await fetchGithub(ctx(gh.fetch, { GH_TOKEN: GH }), desired("dev"));
    expect(got.answers).toEqual(recorded());
    expect(got.token).toBe(true);
    expect(got.releaseToken).toBeNull();
    expect(new Set(gh.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(gh.requests.some((r) => r.url.startsWith("/rate_limit"))).toBe(false);
    // The App is asked anonymously, so a private App can never pass as public.
    expect(gh.requests.find((r) => r.url === "/apps/ponzu-dev")?.auth).toBeNull();
    expect(
      gh.requests.filter((r) => r.url !== "/apps/ponzu-dev").every((r) => r.auth === `token ${GH}`),
    ).toBe(true);
  });

  test("without a token it reads only the public App", async () => {
    const gh = fakeGithub();
    const got = await fetchGithub(ctx(gh.fetch, {}), desired("dev"));
    expect(gh.requests.map((r) => [r.url, r.auth])).toEqual([["/apps/ponzu-dev", null]]);
    expect(got.token).toBe(false);
    expect(got.answers.repository).toBeNull();
  });

  test("RELEASE_TOKEN goes only to GET /rate_limit, and its expiry comes back", async () => {
    const gh = fakeGithub();
    const got = await fetchGithub(ctx(gh.fetch, { RELEASE_TOKEN: RELEASE }), desired("dev"));
    expect(got.releaseToken).toEqual({ status: 200, expiresAt: "2027-01-31T08:00:00.000Z" });
    expect(gh.requests.filter((r) => r.auth?.includes(RELEASE)).map((r) => r.url)).toEqual([
      "/rate_limit",
    ]);
  });

  test("a refused RELEASE_TOKEN is a 401, not a crash", async () => {
    const gh = fakeGithub();
    const got = await fetchGithub(
      ctx(gh.fetch, { RELEASE_TOKEN: "release-token-revoked-0123456789" }),
      desired("dev"),
    );
    expect(got.releaseToken).toEqual({ status: 401, expiresAt: null });
  });

  test("variables are read 30 a page until a short page", async () => {
    const many = Array.from({ length: 31 }, (_, i) => `VAR_${String(i).padStart(2, "0")}`);
    const gh = fakeGithub({ variables: many });
    const got = await fetchGithub(ctx(gh.fetch, { GH_TOKEN: GH }), desired("dev"));
    expect(got.answers.variables).toEqual(many);
  });

  test("production's App not existing is null, not an error", async () => {
    const gh = fakeGithub({ app: false });
    const got = await fetchGithub(ctx(gh.fetch, {}), desired("dev"));
    expect(got.answers.app).toBeNull();
  });

  test("a token that may not read the environments is one failing line; the App is still judged", async () => {
    const gh = fakeGithub({ refuseEnvironments: true });
    const got = await fetchGithub(ctx(gh.fetch, { GH_TOKEN: GH }), desired("dev"));
    expect(got.repositoryError).toMatch(
      /^GitHub answered 403 for the environments \(the token needs/,
    );
    expect(got.repositoryError).not.toContain(GH);
    const lines = evaluateGithub(desired("dev"), got);
    expect(statuses(lines)).toEqual([
      "ok github.app",
      "ok github.app.permissions",
      "ok github.app.events",
      "ok github.app.homepage",
      "fail github.repository",
      "skipped github.release-token",
    ]);
    expect(JSON.stringify(lines)).not.toContain(GH);
  });

  test("a RELEASE_TOKEN GitHub turns away with a 403 fails its own line, not the section", async () => {
    const gh = fakeGithub({ rateLimit: 403 });
    const got = await fetchGithub(ctx(gh.fetch, { RELEASE_TOKEN: RELEASE }), desired("dev"));
    expect(got.releaseToken).toEqual({ status: 403, expiresAt: null });
    const lines = byId(evaluateGithub(desired("dev"), got));
    expect(lines["github.app"]?.status).toBe("ok");
    expect(lines["github.release-token"]).toEqual({
      id: "github.release-token",
      area: "github",
      status: "fail",
      says: "GitHub answered 403 for RELEASE_TOKEN, so its expiry could not be read",
      fix: "make a new token, set it as the repository secret RELEASE_TOKEN, and note its expiry",
    });
  });

  test("an error says GitHub's status and never the token", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ message: `bad ${GH}` }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const error = await fetchGithub(ctx(fetch, { GH_TOKEN: GH }), desired("dev")).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain(GH);
    expect(String(error.message)).toMatch(/^GitHub answered 403 for /);
  });
});
