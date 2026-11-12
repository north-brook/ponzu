/**
 * The API as it answers: `GET /v1/health` (public) says which environment, commit, image and
 * migrations a deployment has, and `GET /v1/cron/selfcheck` (behind `CRON_SECRET`) says whether
 * its own keys and settings work, in fixed words that never quote a secret.
 *
 * The bearer is sent only to an API whose health has just said it is the environment being
 * checked, so a dev cron secret never goes to production or the reverse. Before founder step D11
 * moves the domains, production's address still serves dev; the check reads that as pending.
 */
import { z } from "zod";
import currentImage from "../../../apps/runner/image/current.json" with { type: "json" };
import type { EnvironmentName } from "../desired.ts";
import {
  type CheckContext,
  describeError,
  type Finding,
  findings,
  list,
  type Section,
} from "./finding.ts";

/** Every check the selfcheck answers (apps/api/src/ops/selfcheck.ts; a test holds them equal). */
export const SELFCHECK_IDS = [
  "database",
  "migrations",
  "realtime",
  "storage_assets",
  "storage_private",
  "workos",
  "github_app",
  "github_webhook",
  "anthropic",
  "sandboxes",
  "vault_old_keys",
  "posthog",
] as const;

const HEALTH_TIMEOUT_MS = 10_000;
/** Each selfcheck has 5 seconds and they run at once; this leaves room for a cold start. */
const SELFCHECK_TIMEOUT_MS = 30_000;

export interface ApiDesired {
  env: EnvironmentName;
  /** `null`: the environment has no address yet. */
  apiUrl: string | null;
  /** The address is still in both environments' apiDomains: the move (D11) has not happened. */
  shared: boolean;
  /** current.json's `ponzu-runner@sha256:…`. */
  image: string;
  /** For production, the repository whose `main` a deployment must be built from. */
  repository: string;
}

export function apiDesired(ctx: Pick<CheckContext, "env" | "infra">): ApiDesired {
  const { environments } = ctx.infra["environments.json"];
  const mine = environments[ctx.env];
  const other = environments[ctx.env === "dev" ? "production" : "dev"];
  const host = mine.apiUrl ? new URL(mine.apiUrl).hostname : null;
  return {
    env: ctx.env,
    apiUrl: mine.apiUrl,
    shared: host !== null && other.apiDomains.includes(host),
    image: currentImage.image,
    repository: ctx.infra["github/repo.json"].repository,
  };
}

const Health = z.object({
  status: z.string(),
  version: z.string(),
  commit: z.string().nullable(),
  environment: z.string(),
  image: z.string(),
  runnerBundle: z.string().nullable().optional(),
  migrations: z.object({ applied: z.number().nullable(), expected: z.number() }),
  database: z.boolean(),
});
export type Health = z.infer<typeof Health>;

const Selfcheck = z.object({
  checks: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      count: z.number().optional(),
      missing: z.array(z.string()).optional(),
    }),
  ),
});
export type SelfcheckAnswer = z.infer<typeof Selfcheck>;

type Read<T> = { ok: true; status: number; body: T } | { ok: false; error: string };

export interface ApiObserved {
  health: Read<Health> | null;
  /** `skipped`: no CRON_SECRET; `withheld`: not sent, because health named another environment. */
  selfcheck: Read<SelfcheckAnswer> | { skipped: string } | { withheld: string };
  /** For production: the head of `main`, or why it could not be read. */
  main: { sha: string } | { error: string } | null;
}

async function getJson<T>(
  ctx: CheckContext,
  url: string,
  schema: z.ZodType<T>,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Read<T>> {
  try {
    const response = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `answered ${response.status} with no JSON` };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      return { ok: false, error: `answered ${response.status} in an unknown shape` };
    return { ok: true, status: response.status, body: parsed.data };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function fetchApi(ctx: CheckContext, desired: ApiDesired): Promise<ApiObserved> {
  if (!desired.apiUrl) return { health: null, selfcheck: { withheld: "no address" }, main: null };
  const health = await getJson(ctx, `${desired.apiUrl}/v1/health`, Health, HEALTH_TIMEOUT_MS);
  const secret = ctx.credentials.CRON_SECRET;
  let selfcheck: ApiObserved["selfcheck"];
  if (!health.ok || health.body.environment !== desired.env) {
    selfcheck = { withheld: `health did not say ${desired.env}` };
  } else if (!secret) {
    selfcheck = { skipped: "no CRON_SECRET" };
  } else {
    selfcheck = await getJson(
      ctx,
      `${desired.apiUrl}/v1/cron/selfcheck`,
      Selfcheck,
      SELFCHECK_TIMEOUT_MS,
      { authorization: `Bearer ${secret}` },
    );
  }
  const main = desired.env === "production" ? await mainHead(ctx, desired.repository) : null;
  return { health, selfcheck, main };
}

/** `main`'s head commit, from GitHub's API (a token is used when there is one). */
async function mainHead(
  ctx: CheckContext,
  repository: string,
): Promise<{ sha: string } | { error: string }> {
  const token = ctx.credentials.GH_TOKEN ?? ctx.credentials.GITHUB_TOKEN;
  try {
    const response = await ctx.fetch(`https://api.github.com/repos/${repository}/commits/main`, {
      headers: {
        accept: "application/vnd.github.sha",
        "user-agent": "ponzu-prod-check",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const sha = (await response.text()).trim();
    return response.ok && /^[0-9a-f]{40}$/.test(sha)
      ? { sha }
      : { error: `GitHub answered ${response.status}` };
  } catch (error) {
    return { error: describeError(error) };
  }
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("api");

const STEP_DEPLOY = "docs/production.md › The founder's steps (D11 moves the domain, D15 deploys)";

export function evaluateApi(desired: ApiDesired, observed: ApiObserved): Finding[] {
  const { env } = desired;
  if (!desired.apiUrl || !observed.health) {
    return [f.pending("health", `${env} has no API address in infra/environments.json yet`)];
  }
  const url = desired.apiUrl;
  const health = observed.health;
  if (!health.ok) {
    return [
      f.fail(
        "health",
        `${url}/v1/health could not be read: ${health.error}`,
        "docs/production.md › DNS",
      ),
    ];
  }
  const body = health.body;
  if (body.environment !== env) {
    const says = `${url} answers as ${body.environment}, not ${env}`;
    return desired.shared
      ? [
          f.pending(
            "health",
            `${says}: the address still belongs to ${body.environment}`,
            STEP_DEPLOY,
          ),
        ]
      : [
          f.fail(
            "health",
            says,
            "move the domain to this environment's project (docs/production.md)",
          ),
        ];
  }
  const out: Finding[] = [];
  out.push(
    body.status === "ok" && body.database && health.status === 200
      ? f.ok("health", `${url} is ${env}, ok, and reaches its database (version ${body.version})`)
      : f.fail(
          "health",
          `${url} answers ${health.status} ${body.status}${body.database ? "" : ", without its database"}`,
          "the API's logs on Vercel",
        ),
  );
  const { applied, expected } = body.migrations;
  out.push(
    applied === expected
      ? f.ok("migrations", `${applied} of ${expected} migrations applied`)
      : f.fail(
          "migrations",
          applied === null
            ? `the applied migrations could not be counted (the build expects ${expected})`
            : `${applied} migrations applied, but the build expects ${expected}`,
          applied !== null && applied < expected
            ? "run the deploy workflow, which migrates before it deploys"
            : "deploy the build that matches the database",
        ),
  );
  out.push(
    body.image === desired.image
      ? f.ok("image", `sandboxes run ${desired.image}`)
      : f.fail(
          "image",
          `sandboxes run ${body.image}, not current.json's ${desired.image}`,
          "deploy again: the image ships with the API",
        ),
  );
  if (env === "production") {
    const main = observed.main;
    if (!main || "error" in main) {
      out.push(
        f.fail("commit", `main's head could not be read: ${main ? main.error : "not asked"}`),
      );
    } else {
      out.push(
        body.commit === main.sha
          ? f.ok("commit", `built from main's head, ${main.sha.slice(0, 12)}`)
          : f.fail(
              "commit",
              `built from ${body.commit ? body.commit.slice(0, 12) : "an unknown commit"}, but main is at ${main.sha.slice(0, 12)}`,
              "approve the waiting production deploy in GitHub Actions",
            ),
      );
    }
  } else {
    out.push(
      f.ok(
        "commit",
        body.commit
          ? `built from ${body.commit.slice(0, 12)}`
          : "the build did not record its commit",
      ),
    );
  }
  out.push(...evaluateSelfcheck(observed.selfcheck));
  return out;
}

function evaluateSelfcheck(selfcheck: ApiObserved["selfcheck"]): Finding[] {
  if ("skipped" in selfcheck) return [f.skipped("selfcheck", `skipped (${selfcheck.skipped})`)];
  if ("withheld" in selfcheck) return [f.skipped("selfcheck", `not asked: ${selfcheck.withheld}`)];
  if (!selfcheck.ok) {
    return [f.fail("selfcheck", `/v1/cron/selfcheck could not be read: ${selfcheck.error}`)];
  }
  if (selfcheck.status !== 200) {
    return [
      f.fail(
        "selfcheck",
        `/v1/cron/selfcheck answered ${selfcheck.status}`,
        selfcheck.status === 401 ? "CRON_SECRET is not this environment's" : undefined,
      ),
    ];
  }
  const out: Finding[] = [];
  const answered = new Map(selfcheck.body.checks.map((check) => [check.id, check]));
  for (const id of SELFCHECK_IDS) {
    const check = answered.get(id);
    if (!check) {
      out.push(
        f.fail(
          `selfcheck.${id}`,
          "the selfcheck did not answer it; is the deployment older than this check?",
        ),
      );
      continue;
    }
    const extra = [
      check.count !== undefined ? `${check.count}` : null,
      check.missing?.length ? `missing ${list(check.missing)}` : null,
    ].filter(Boolean);
    const says = `${check.detail}${extra.length ? ` (${extra.join(", ")})` : ""}`;
    out.push(
      check.ok ? f.ok(`selfcheck.${id}`, says) : f.fail(`selfcheck.${id}`, says, SELFCHECK_FIX[id]),
    );
  }
  for (const check of selfcheck.body.checks) {
    if (!(SELFCHECK_IDS as readonly string[]).includes(check.id)) {
      out.push(
        check.ok
          ? f.ok(`selfcheck.${check.id}`, check.detail)
          : f.fail(`selfcheck.${check.id}`, check.detail),
      );
    }
  }
  return out;
}

const SELFCHECK_FIX: Partial<Record<(typeof SELFCHECK_IDS)[number], string>> = {
  migrations: "run the deploy workflow, which migrates before it deploys",
  vault_old_keys: "bun apps/api/scripts/reseal.ts (docs/production.md › Rotating secrets)",
  github_webhook: "bun scripts/github-webhook.ts configure",
};

export const apiSection: Section<ApiDesired, ApiObserved> = {
  area: "api",
  needs: [],
  desired: apiDesired,
  fetchObserved: fetchApi,
  evaluate: evaluateApi,
};
