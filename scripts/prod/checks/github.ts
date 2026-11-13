/**
 * The GitHub side of an environment, against `infra/github-app/` and `infra/github/`:
 *
 * - The environment's GitHub App, from GitHub's public `GET /apps/{slug}`: it exists and is the
 *   repository owner's, and its permissions, events and homepage are the manifest's exactly. A
 *   permission the manifest does not grant fails (security review item 10). Each App is judged
 *   against its own manifest, `infra/github-app/<slug>.json` (ponzu-dev's when infra has none);
 *   a test holds `ponzu.json` to ponzu-dev's permissions and events.
 * - The repository, with a token: the merge settings in `github/repo.json`, each ruleset in
 *   `github/ruleset-*.json`, each environment (the branches that may deploy, a required reviewer,
 *   its secrets' names), and the names of the repository's variables and secrets.
 * - `RELEASE_TOKEN`'s expiry, read from GitHub's `github-authentication-token-expiration` header
 *   on an answer to that token, when whoever runs the check has it in their environment.
 *
 * Read through `@octokit/core` (the version apps/api uses). Every call is a GET. Only names are
 * read, never a variable's or a secret's value.
 *
 * The App's lines need no credential (GitHub answers them publicly). The repository's need
 * `GH_TOKEN` or `GITHUB_TOKEN` (`GH_TOKEN=$(gh auth token)` works for an admin); without one
 * they are one `skipped` line. The token's line needs `RELEASE_TOKEN`; without it, `skipped`.
 */
import { Octokit } from "@octokit/core";
import { z } from "zod";
import type { EnvironmentName, GithubAppManifest, Infra, InfraFile, Ruleset } from "../desired.ts";
import {
  type CheckContext,
  describeError,
  type Finding,
  findings,
  list,
  type Section,
} from "./finding.ts";

/** A token that expires sooner than this fails, so it is renewed before Release Please stops. */
export const RELEASE_TOKEN_WARN_DAYS = 30;

/** The rulesets infra writes down, by file. `pending` names the step that creates one. */
const RULESET_FILES = [
  { file: "github/ruleset-main.json", id: "ruleset.main", pending: null },
  {
    file: "github/ruleset-cloud.json",
    id: "ruleset.cloud",
    pending: "founder step D12: bun scripts/prod/apply.ts github-rulesets --yes",
  },
] as const;

/** Environments that do not exist until a founder step makes them. */
const ENVIRONMENT_PENDING: Record<string, string> = {
  // Made by hand, limited to `cloud`, before API_DEPLOY is set to true; otherwise the first dev
  // deploy makes it with no branch limit (docs/production.md › The GitHub repository).
  dev: "make it, limited to cloud, before setting API_DEPLOY=true",
  production: "founder step D12",
};

// --- desired ------------------------------------------------------------------------------------

type Repo = Infra["github/repo.json"];

export interface GithubDesired {
  env: EnvironmentName;
  /** infra/environments.json's githubAppSlug; `null`: not chosen yet. */
  appSlug: string | null;
  /** `github-app/<slug>.json` when infra has one, else ponzu-dev's (the same permissions). */
  manifestFile: InfraFile;
  manifest: GithubAppManifest;
  /** `north-brook/ponzu`. */
  repository: string;
  merge: Repo["merge"];
  rulesets: { id: string; pending: string | null; ruleset: Ruleset }[];
  environments: Repo["environments"];
  variables: string[];
  secrets: string[];
}

/** The manifest file infra keeps for an App: `github-app/<slug>.json`, else ponzu-dev's. */
export function manifestFile(infra: Infra, slug: string | null): InfraFile {
  const file = `github-app/${slug}.json`;
  return file in infra ? (file as InfraFile) : "github-app/ponzu-dev.json";
}

/** The App manifest infra keeps for a slug (see `manifestFile`). */
export function appManifest(infra: Infra, slug: string | null): GithubAppManifest {
  return infra[manifestFile(infra, slug)] as GithubAppManifest;
}

export function githubDesired(ctx: Pick<CheckContext, "env" | "infra">): GithubDesired {
  const repo = ctx.infra["github/repo.json"];
  const appSlug = ctx.infra["environments.json"].environments[ctx.env].githubAppSlug;
  return {
    env: ctx.env,
    appSlug,
    manifestFile: manifestFile(ctx.infra, appSlug),
    manifest: appManifest(ctx.infra, appSlug),
    repository: repo.repository,
    merge: repo.merge,
    rulesets: RULESET_FILES.map(({ file, id, pending }) => ({
      id,
      pending,
      ruleset: ctx.infra[file],
    })),
    environments: repo.environments,
    variables: repo.variables,
    secrets: repo.secrets,
  };
}

// --- observed -----------------------------------------------------------------------------------

/** The public App, as `GET /apps/{slug}` answers it, ids dropped. */
export const GithubApp = z.object({
  slug: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }).nullish(),
  external_url: z.string().nullish(),
  /** Public: GitHub shows it to anyone, and WorkOS sends every sign-in to GitHub with it. */
  client_id: z.string().nullish(),
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
});
export type GithubApp = z.infer<typeof GithubApp>;

/**
 * What the check keeps of GitHub's answers about the repository, in GitHub's field names. The
 * fixture fixtures/github/dev-answers.json is this shape; `fetchGithub` builds it live.
 */
export const GithubAnswers = z.object({
  /** `null`: no App by that slug (GitHub answered 404). */
  app: GithubApp.nullable(),
  /** The merge settings of `GET /repos/{owner}/{repo}`; `null` when no token was given. */
  repository: z.record(z.string(), z.unknown()).nullable(),
  rulesets: z.array(
    z.object({
      name: z.string(),
      target: z.string().nullish(),
      enforcement: z.string(),
      /** Absent when the token may not see who can bypass. */
      bypass_actors: z.array(z.record(z.string(), z.unknown())).nullish(),
      conditions: z.unknown(),
      rules: z.array(
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).nullish(),
        }),
      ),
    }),
  ),
  environments: z.array(
    z.object({
      name: z.string(),
      protection_rules: z
        .array(z.object({ type: z.string(), reviewers: z.array(z.unknown()).nullish() }))
        .nullish(),
      deployment_branch_policy: z
        .object({ protected_branches: z.boolean(), custom_branch_policies: z.boolean() })
        .nullish(),
      branch_policies: z.array(z.object({ name: z.string(), type: z.string().nullish() })),
      secrets: z.array(z.string()),
    }),
  ),
  variables: z.array(z.string()),
  secrets: z.array(z.string()),
});
export type GithubAnswers = z.infer<typeof GithubAnswers>;

export interface GithubObserved {
  checkedAt: string;
  /** Whether a token was given; without one only the App was read. */
  token: boolean;
  answers: GithubAnswers;
  /**
   * `null`: no RELEASE_TOKEN in the environment. Otherwise GitHub's status for it and the expiry
   * its answer carried (`null`: the token never expires).
   */
  releaseToken: null | { status: number; expiresAt: string | null };
  /**
   * Why the repository could not be read with the token (GitHub's status and what the token
   * needs, never the token), so one refused read is one failing line and the App's lines, which
   * need no token, are still judged. Absent or `null`: read, or no token to read with.
   */
  repositoryError?: string | null;
}

export const EMPTY_ANSWERS: GithubAnswers = {
  app: null,
  repository: null,
  rulesets: [],
  environments: [],
  variables: [],
  secrets: [],
};

/** `@octokit/core`, speaking through `ctx.fetch` so tests can answer for GitHub. */
export function githubClient(ctx: Pick<CheckContext, "fetch">, token?: string): Octokit {
  return new Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: "ponzu-prod-check",
    request: { fetch: ctx.fetch },
  });
}

/** An Octokit error's HTTP status, if it has one. */
export function githubStatus(error: unknown): number | null {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}

/** Strips an Octokit error to its status, so a printed line never carries a request. */
function plainError(error: unknown, what: string): Error {
  const status = githubStatus(error);
  if (status === null) return error instanceof Error ? error : new Error(String(error));
  const hint =
    status === 401 || status === 403 || status === 404
      ? " (the token needs to read the repository's administration, environments, secrets and variables)"
      : "";
  return new Error(`GitHub answered ${status} for ${what}${hint}`);
}

/**
 * The public App by its slug; `null` when GitHub shows no one such an App. It is asked without a
 * token on purpose: GitHub shows a private App to its owner, so an answer to an anonymous request
 * is what proves the App is public, as the apps' install links need.
 */
export async function readApp(
  ctx: Pick<CheckContext, "fetch">,
  slug: string,
): Promise<GithubApp | null> {
  try {
    const { data } = await githubClient(ctx).request("GET /apps/{app_slug}", {
      app_slug: slug,
    });
    const app = GithubApp.parse(data);
    return {
      slug: app.slug,
      name: app.name,
      owner: app.owner ? { login: app.owner.login } : null,
      external_url: app.external_url ?? null,
      client_id: app.client_id ?? null,
      permissions: app.permissions,
      events: app.events,
    };
  } catch (error) {
    if (githubStatus(error) === 404) return null;
    throw plainError(error, `the App ${slug}`);
  }
}

/** Reads page after page until one comes back short. */
async function allPages<T>(perPage: number, read: (page: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const items = await read(page);
    out.push(...items);
    if (items.length < perPage) return out;
  }
  throw new Error("GitHub kept answering more pages");
}

const MERGE_KEYS = [
  "allow_auto_merge",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_squash_merge",
  "allow_update_branch",
  "delete_branch_on_merge",
  "squash_merge_commit_message",
  "squash_merge_commit_title",
] as const;

export async function fetchGithub(
  ctx: CheckContext,
  desired: GithubDesired,
): Promise<GithubObserved> {
  const checkedAt = ctx.now().toISOString();
  const token = ctx.credentials.GH_TOKEN ?? ctx.credentials.GITHUB_TOKEN;
  const [app, repo, releaseToken] = await Promise.all([
    desired.appSlug ? readApp(ctx, desired.appSlug) : Promise.resolve(null),
    token
      ? readRepository(ctx, token, desired.repository).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        )
      : Promise.resolve(null),
    ctx.credentials.RELEASE_TOKEN
      ? readTokenExpiry(ctx, ctx.credentials.RELEASE_TOKEN)
      : Promise.resolve(null),
  ]);
  const repositoryError = repo instanceof Error ? describeError(repo) : null;
  return {
    checkedAt,
    token: !!token,
    answers: GithubAnswers.parse({
      ...EMPTY_ANSWERS,
      ...(repo instanceof Error ? {} : repo),
      app,
    }),
    releaseToken,
    repositoryError,
  };
}

async function readRepository(
  ctx: CheckContext,
  token: string,
  repository: string,
): Promise<Omit<GithubAnswers, "app">> {
  const [owner, repo] = repository.split("/") as [string, string];
  const gh = githubClient(ctx, token);
  const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw plainError(error, what);
    }
  };
  const [settings, rulesets, environments, variables, secrets] = await Promise.all([
    step("the repository", async () => {
      const { data } = await gh.request("GET /repos/{owner}/{repo}", { owner, repo });
      const all = data as Record<string, unknown>;
      return Object.fromEntries(MERGE_KEYS.map((key) => [key, all[key] ?? null]));
    }),
    step("the rulesets", async () => {
      const list = await allPages(100, async (page) => {
        const { data } = await gh.request("GET /repos/{owner}/{repo}/rulesets", {
          owner,
          repo,
          includes_parents: false,
          per_page: 100,
          page,
        });
        return data;
      });
      return Promise.all(
        list.map(async ({ id }) => {
          const { data } = await gh.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
            owner,
            repo,
            ruleset_id: id,
          });
          return {
            name: data.name,
            target: data.target ?? null,
            enforcement: data.enforcement,
            bypass_actors: data.bypass_actors ?? null,
            conditions: data.conditions ?? null,
            rules: (data.rules ?? []).map((rule) => {
              const r = rule as { type: string; parameters?: Record<string, unknown> };
              return r.parameters ? { type: r.type, parameters: r.parameters } : { type: r.type };
            }),
          };
        }),
      );
    }),
    step("the environments", async () => {
      const list = await allPages(100, async (page) => {
        const { data } = await gh.request("GET /repos/{owner}/{repo}/environments", {
          owner,
          repo,
          per_page: 100,
          page,
        });
        return data.environments ?? [];
      });
      return Promise.all(
        list.map(async (environment) => {
          const name = environment.name;
          const policy = environment.deployment_branch_policy ?? null;
          const [branchPolicies, environmentSecrets] = await Promise.all([
            policy?.custom_branch_policies
              ? allPages(100, async (page) => {
                  const { data } = await gh.request(
                    "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
                    { owner, repo, environment_name: name, per_page: 100, page },
                  );
                  return data.branch_policies.map((p) => ({
                    name: p.name ?? "",
                    type: p.type ?? null,
                  }));
                })
              : Promise.resolve([]),
            allPages(100, async (page) => {
              const { data } = await gh.request(
                "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets",
                { owner, repo, environment_name: name, per_page: 100, page },
              );
              return data.secrets.map((s) => s.name);
            }),
          ]);
          return {
            name,
            protection_rules: (environment.protection_rules ?? []).map((rule) => {
              const r = rule as { type: string; reviewers?: unknown[] };
              return { type: r.type, reviewers: (r.reviewers ?? []).map(() => ({})) };
            }),
            deployment_branch_policy: policy,
            branch_policies: branchPolicies,
            secrets: environmentSecrets,
          };
        }),
      );
    }),
    step("the variables", () =>
      // GitHub answers at most 30 variables a page.
      allPages(30, async (page) => {
        const { data } = await gh.request("GET /repos/{owner}/{repo}/actions/variables", {
          owner,
          repo,
          per_page: 30,
          page,
        });
        return data.variables.map((v) => v.name);
      }),
    ),
    step("the secrets", () =>
      allPages(100, async (page) => {
        const { data } = await gh.request("GET /repos/{owner}/{repo}/actions/secrets", {
          owner,
          repo,
          per_page: 100,
          page,
        });
        return data.secrets.map((s) => s.name);
      }),
    ),
  ]);
  return { repository: settings, rulesets, environments, variables, secrets };
}

/**
 * GitHub's answer to the token itself carries its expiry in `github-authentication-token-
 * expiration` ("2026-12-01 10:00:00 UTC"). `GET /rate_limit` costs nothing against the limit.
 */
async function readTokenExpiry(
  ctx: CheckContext,
  token: string,
): Promise<{ status: number; expiresAt: string | null }> {
  try {
    const { status, headers } = await githubClient(ctx, token).request("GET /rate_limit");
    const raw = headers["github-authentication-token-expiration"];
    return { status, expiresAt: typeof raw === "string" ? parseExpiry(raw) : null };
  } catch (error) {
    // Any answer GitHub gives is judged on the token's own line (401: refused; anything else:
    // unreadable), so a token GitHub turns away never takes the App's lines down with it.
    const status = githubStatus(error);
    if (status !== null) return { status, expiresAt: null };
    throw plainError(error, "RELEASE_TOKEN");
  }
}

/**
 * `2026-12-01 10:00:00 UTC` or `2026-12-01 10:00:00 -0800` (GitHub's forms) as an ISO time; the
 * raw text when it is neither, which the evaluation then reports as unreadable.
 */
export function parseExpiry(raw: string): string {
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!match) return raw;
  const [, day, time, zone] = match as unknown as [string, string, string, string];
  const offset = zone === "UTC" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const at = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(at.getTime()) ? raw : at.toISOString();
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("github");

const STEP_APP = "founder step D6: bun scripts/prod/github-app.ts create --env production";

export function evaluateGithub(desired: GithubDesired, observed: GithubObserved): Finding[] {
  const out = evaluateApp(desired, observed.answers.app);
  if (!observed.token) {
    out.push(
      f.skipped(
        "credentials",
        "skipped (no GH_TOKEN, no GITHUB_TOKEN): the repository's merge settings, rulesets, environments, variables and secrets",
        "GH_TOKEN=$(gh auth token) bun scripts/prod/check.ts …, as a repository admin",
      ),
    );
  } else if (observed.repositoryError) {
    out.push(
      f.fail(
        "repository",
        `the repository could not be read: ${observed.repositoryError}`,
        "GH_TOKEN=$(gh auth token) as a repository admin, or a fine-grained token with Administration, Environments, Secrets and Variables read",
      ),
    );
  } else {
    out.push(evaluateMerge(desired, observed.answers));
    for (const want of desired.rulesets) out.push(evaluateRuleset(want, observed.answers));
    for (const [name, want] of Object.entries(desired.environments)) {
      out.push(evaluateEnvironment(name, want, observed.answers));
    }
    out.push(
      evaluateNames("variables", "variable", desired.variables, observed.answers.variables),
      evaluateNames("secrets", "secret", desired.secrets, observed.answers.secrets),
    );
  }
  out.push(evaluateReleaseToken(observed));
  return out;
}

function evaluateApp(desired: GithubDesired, app: GithubApp | null): Finding[] {
  const { env, appSlug, manifest, manifestFile: file } = desired;
  if (!appSlug) {
    return [f.pending("app", `infra/environments.json names no GitHub App for ${env} yet`)];
  }
  if (!app) {
    return [
      env === "production"
        ? f.pending("app", `the GitHub App "${appSlug}" does not exist yet`, STEP_APP)
        : f.fail(
            "app",
            `GitHub shows no public App "${appSlug}" (it is private, or gone)`,
            `GitHub › north-brook › Developer settings › GitHub Apps › ${appSlug}: make it public`,
          ),
    ];
  }
  const owner = desired.repository.split("/")[0] as string;
  const where = `GitHub › ${owner} › Developer settings › GitHub Apps › ${appSlug} › Permissions & events, as infra/${file} says`;
  const out: Finding[] = [];
  out.push(
    app.owner?.login === owner
      ? f.ok("app", `the GitHub App "${appSlug}" (${app.name}) is ${owner}'s`)
      : f.fail(
          "app",
          `the GitHub App "${appSlug}" belongs to ${app.owner?.login ?? "no one GitHub names"}, not ${owner}`,
          `make the App in ${owner}'s organisation (${STEP_APP})`,
        ),
  );

  const want = manifest.default_permissions;
  const extra = Object.keys(app.permissions)
    .filter((name) => !(name in want))
    .sort()
    .map((name) => `${name}: ${app.permissions[name]}`);
  const differs = Object.keys(want)
    .filter((name) => app.permissions[name] !== want[name])
    .sort()
    .map((name) => `${name} is ${app.permissions[name] ?? "not granted"}, not ${want[name]}`);
  out.push(
    !extra.length && !differs.length
      ? f.ok(
          "app.permissions",
          `${appSlug} asks for exactly the manifest's ${Object.keys(want).length} permissions`,
        )
      : f.fail(
          "app.permissions",
          [
            extra.length ? `${appSlug} asks for more than the manifest: ${list(extra)}` : "",
            differs.length ? `${appSlug}'s ${list(differs)}` : "",
          ]
            .filter(Boolean)
            .join("; "),
          where,
        ),
  );

  const events = new Set(app.events);
  const missing = manifest.default_events.filter((e) => !events.has(e));
  const more = [...events].filter((e) => !manifest.default_events.includes(e)).sort();
  out.push(
    !missing.length && !more.length
      ? f.ok("app.events", `${appSlug} subscribes to exactly the manifest's ${events.size} events`)
      : f.fail(
          "app.events",
          [
            missing.length ? `${appSlug} does not subscribe to ${list(missing)}` : "",
            more.length ? `${appSlug} also subscribes to ${list(more)}` : "",
          ]
            .filter(Boolean)
            .join("; "),
          where,
        ),
  );

  out.push(
    app.external_url === manifest.url
      ? f.ok("app.homepage", `${appSlug}'s homepage is ${manifest.url}`)
      : f.fail(
          "app.homepage",
          `${appSlug}'s homepage is ${app.external_url ?? "not set"}, not ${manifest.url}`,
          `GitHub › the App › General › Homepage URL: ${manifest.url}`,
        ),
  );
  return out;
}

function evaluateMerge(desired: GithubDesired, answers: GithubAnswers): Finding {
  const got = answers.repository ?? {};
  const wrong = (Object.keys(desired.merge) as (keyof GithubDesired["merge"])[])
    .filter((key) => got[key] !== desired.merge[key])
    .map(
      (key) =>
        `${key} is ${JSON.stringify(got[key] ?? null)}, not ${JSON.stringify(desired.merge[key])}`,
    );
  return wrong.length
    ? f.fail(
        "merge",
        `${desired.repository}'s merge settings: ${list(wrong)}`,
        "GitHub › the repository › Settings › General › Pull Requests, as infra/github/repo.json says",
      )
    : f.ok("merge", `${desired.repository} squash-merges only, as infra/github/repo.json says`);
}

/**
 * Deep equality where arrays are compared as sets and only the wanted object's keys count, at
 * every depth: an array must have exactly as many items as wanted, each wanted item covered by
 * its own live item, and fields GitHub adds inside an item (a status check's integration id, say)
 * are ignored like any other added field.
 */
export function covers(want: unknown, got: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || want.length !== got.length) return false;
    // Each wanted item gets a different live item. A search, not a greedy pick, so a loose wanted
    // item cannot take the only live item a stricter one could match.
    const used = new Set<number>();
    const match = (i: number): boolean => {
      if (i === want.length) return true;
      for (let j = 0; j < got.length; j++) {
        if (used.has(j) || !covers(want[i], got[j])) continue;
        used.add(j);
        if (match(i + 1)) return true;
        used.delete(j);
      }
      return false;
    };
    return match(0);
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object" || Array.isArray(got)) return false;
    return Object.entries(want).every(([key, value]) =>
      covers(value, (got as Record<string, unknown>)[key]),
    );
  }
  return want === got;
}

/**
 * GitHub adds parameters to rules over time; a live rule may carry more than the file names, and
 * the file's must all be there with the same values. Rule types must match exactly.
 */
export function rulesetDifferences(
  want: Ruleset,
  got: GithubAnswers["rulesets"][number],
): string[] {
  const out: string[] = [];
  if (got.enforcement !== want.enforcement) {
    out.push(`it is ${got.enforcement}, not ${want.enforcement}`);
  }
  if ((got.target ?? "branch") !== want.target)
    out.push(`it targets ${got.target}, not ${want.target}`);
  if (!covers(want.conditions, got.conditions) || !covers(got.conditions, want.conditions)) {
    out.push("it applies to other branches");
  }
  if (got.bypass_actors == null) {
    out.push("the token cannot see who may bypass it");
  } else if (!covers(want.bypass_actors, got.bypass_actors)) {
    out.push(
      want.bypass_actors.length
        ? "its bypass list differs"
        : `${got.bypass_actors.length} actor${got.bypass_actors.length === 1 ? "" : "s"} may bypass it`,
    );
  }
  const wantTypes = want.rules.map((r) => r.type).sort();
  const gotTypes = got.rules.map((r) => r.type).sort();
  const missing = wantTypes.filter((t) => !gotTypes.includes(t));
  const extra = gotTypes.filter((t) => !wantTypes.includes(t));
  if (missing.length) out.push(`it lacks ${list(missing)}`);
  if (extra.length) out.push(`it also has ${list(extra)}`);
  for (const rule of want.rules) {
    const live = got.rules.find((r) => r.type === rule.type);
    if (live && rule.parameters && !covers(rule.parameters, live.parameters ?? {})) {
      out.push(`its ${rule.type} rule's settings differ`);
    }
  }
  return out;
}

function evaluateRuleset(want: GithubDesired["rulesets"][number], answers: GithubAnswers): Finding {
  const { ruleset } = want;
  const live = answers.rulesets.filter((r) => r.name === ruleset.name);
  const fix = "bun scripts/prod/apply.ts github-rulesets --yes (founder step D12)";
  if (!live.length) {
    return want.pending
      ? f.pending(want.id, `the ruleset "${ruleset.name}" does not exist yet`, want.pending)
      : f.fail(want.id, `the ruleset "${ruleset.name}" is gone`, fix);
  }
  if (live.length > 1) {
    return f.fail(
      want.id,
      `${live.length} rulesets are named "${ruleset.name}"`,
      "delete all but one",
    );
  }
  const wrong = rulesetDifferences(ruleset, live[0] as GithubAnswers["rulesets"][number]);
  const branches = list(
    ruleset.conditions.ref_name.include.map((r) => r.replace("refs/heads/", "")),
  );
  return wrong.length
    ? f.fail(want.id, `the ruleset "${ruleset.name}": ${list(wrong)}`, fix)
    : f.ok(want.id, `the ruleset "${ruleset.name}" protects ${branches} as infra says`);
}

function evaluateEnvironment(
  name: string,
  want: GithubDesired["environments"][string],
  answers: GithubAnswers,
): Finding {
  const id = `environment.${name}`;
  const live = answers.environments.find((e) => e.name === name);
  const where = `GitHub › the repository › Settings › Environments › ${name}`;
  if (!live) {
    const step = ENVIRONMENT_PENDING[name];
    return step
      ? f.pending(id, `the environment "${name}" does not exist yet`, `${where} (${step})`)
      : f.fail(id, `the environment "${name}" is gone`, where);
  }
  const wrong: string[] = [];
  const policy = live.deployment_branch_policy;
  const branches = live.branch_policies.filter((p) => (p.type ?? "branch") === "branch");
  const branchNames = branches.map((p) => p.name).sort();
  if (!policy) {
    wrong.push("any branch may deploy to it");
  } else if (policy.protected_branches) {
    wrong.push("any protected branch may deploy to it");
  } else if (
    branchNames.length !== want.branches.length ||
    want.branches.some((b) => !branchNames.includes(b)) ||
    branches.length !== live.branch_policies.length
  ) {
    wrong.push(
      `${list(live.branch_policies.map((p) => p.name)) || "no branch"} may deploy to it, not only ${list(want.branches)}`,
    );
  }
  const reviewers = (live.protection_rules ?? [])
    .filter((r) => r.type === "required_reviewers")
    .reduce((n, r) => n + (r.reviewers?.length ?? 0), 0);
  if (want.requiredReviewers && !reviewers) wrong.push("no one has to approve a run");
  if (!want.requiredReviewers && reviewers)
    wrong.push("a reviewer is required, which infra does not ask for");
  const missing = want.secrets.filter((s) => !live.secrets.includes(s));
  if (missing.length)
    wrong.push(`it lacks the secret${missing.length === 1 ? "" : "s"} ${list(missing)}`);
  return wrong.length
    ? f.fail(id, `the environment "${name}": ${list(wrong)}`, where)
    : f.ok(
        id,
        `the environment "${name}" deploys only from ${list(want.branches)}${want.requiredReviewers ? ", with a required reviewer," : ""} and holds its ${want.secrets.length} secret${want.secrets.length === 1 ? "" : "s"}`,
      );
}

/** Every name infra lists must be set. A name set that infra does not list is mentioned. */
function evaluateNames(
  what: "variables" | "secrets",
  one: string,
  want: readonly string[],
  got: readonly string[],
): Finding {
  const missing = want.filter((name) => !got.includes(name));
  const extra = got.filter((name) => !want.includes(name)).sort();
  const also = extra.length ? ` (also set, not in infra/github/repo.json: ${list(extra)})` : "";
  return missing.length
    ? f.pending(
        what,
        `${missing.length} of the ${want.length} repository ${what} the workflows read ${missing.length === 1 ? "is" : "are"} not set: ${list(missing)}${also}`,
        `gh ${one} set <NAME> --repo north-brook/ponzu (docs/production.md › Env and secrets; production's are founder step D12)`,
      )
    : f.ok(
        what,
        `every one of the ${want.length} repository ${what} the workflows read is set${also}`,
      );
}

function evaluateReleaseToken(observed: GithubObserved): Finding {
  const token = observed.releaseToken;
  const renew =
    "make a new token, set it as the repository secret RELEASE_TOKEN, and note its expiry";
  if (!token) {
    return f.skipped(
      "release-token",
      "skipped (no RELEASE_TOKEN): its expiry is read from GitHub's answer to the token itself",
      "RELEASE_TOKEN=<the token> bun scripts/prod/check.ts …",
    );
  }
  if (token.status === 401) {
    return f.fail(
      "release-token",
      "GitHub refuses RELEASE_TOKEN: it has expired or was revoked",
      renew,
    );
  }
  if (token.status < 200 || token.status >= 300) {
    return f.fail(
      "release-token",
      `GitHub answered ${token.status} for RELEASE_TOKEN, so its expiry could not be read`,
      renew,
    );
  }
  if (!token.expiresAt) return f.ok("release-token", "RELEASE_TOKEN has no expiry date");
  const left = Math.floor(
    (new Date(token.expiresAt).getTime() - new Date(observed.checkedAt).getTime()) / 86_400_000,
  );
  const day = token.expiresAt.slice(0, 10);
  if (!Number.isFinite(left)) {
    return f.fail(
      "release-token",
      `RELEASE_TOKEN's expiry "${token.expiresAt}" could not be read`,
      renew,
    );
  }
  return left < RELEASE_TOKEN_WARN_DAYS
    ? f.fail(
        "release-token",
        left < 0
          ? `RELEASE_TOKEN expired on ${day}`
          : `RELEASE_TOKEN expires on ${day}, in ${left} day${left === 1 ? "" : "s"}, under ${RELEASE_TOKEN_WARN_DAYS}`,
        renew,
      )
    : f.ok("release-token", `RELEASE_TOKEN expires on ${day}, in ${left} days`);
}

export const githubSection: Section<GithubDesired, GithubObserved> = {
  area: "github",
  // The App reads publicly; the repository's lines and the token's line each say when their
  // credential is missing, so the section itself never needs one to run.
  needs: [],
  desired: githubDesired,
  fetchObserved: fetchGithub,
  evaluate: evaluateGithub,
};
