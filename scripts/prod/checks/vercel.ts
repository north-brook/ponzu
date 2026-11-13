/**
 * The Vercel project an environment's API runs in: its settings, the names (never the values) of
 * its environment variables on each target, its domains, the firewall that is live on it, and
 * whether its latest production deployment still carries a legacy cron (the minute is a Vercel
 * Schedule now, declared in apps/api/vercel.json). Read through `@vercel/sdk` with a read-only
 * token; nothing is decrypted (`getProject` answers sensitive values empty, and every value is
 * dropped as soon as it is read).
 *
 * The SDK checks each answer against its own schema, and that schema can lag the API: on
 * 1.28.53, `getProject` refuses dev's real project because `security.managedRules` lacks a
 * `traffic_sources` the schema requires. When the SDK refuses an answer it still hands over
 * what the API sent (`ResponseValidationError.rawValue`), so the check reads that instead. The
 * two differ only in the keys the SDK renames (`bot_protection` comes back `botProtection`),
 * which `normalizeFirewall` reads either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vercel } from "@vercel/sdk";
import { HTTPClient } from "@vercel/sdk/lib/http.js";
import { ResponseValidationError } from "@vercel/sdk/models/responsevalidationerror.js";
import { VercelError } from "@vercel/sdk/models/vercelerror.js";
import { z } from "zod";
import { FORBIDDEN_ENV, OPTIONAL_ENV, REQUIRED_ENV } from "../../../apps/api/src/env.ts";
import { VERCEL_CLI } from "../../ci/schedules.ts";
import type { EnvironmentName, Firewall } from "../desired.ts";
import { type CheckContext, type Finding, findings, list, type Section } from "./finding.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** The team every project lives in, by slug. Public: it is in every image reference. */
export const VERCEL_TEAM_SLUG = "northbrook";

/**
 * The deployment protection settings that count as Standard Protection or stronger while still
 * leaving the API's own domain reachable. `all` would put a login in front of
 * api.ponzu.design, which no app can pass.
 */
export const PROTECTED = ["prod_deployment_urls_and_all_previews", "all_except_custom_domains"];

/**
 * The API's secrets: on production each must be stored as `sensitive`, so not even the team
 * can read it back. Every name here is one the API reads (a test holds this to env.ts).
 */
export const SECRET_ENV = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "CRON_SECRET",
  "PONZU_VAULT_KEY",
  "PONZU_VAULT_OLD_KEYS",
  "NEON_REALTIME_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "PONZU_ANTHROPIC_API_KEY",
  "PONZU_POSTHOG_PERSONAL_API_KEY",
  "EXPO_ACCESS_TOKEN",
  "RESEND_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

// --- desired ------------------------------------------------------------------------------------

export interface VercelDesired {
  env: EnvironmentName;
  /** `null`: not named in infra yet. */
  project: string | null;
  rootDirectory: string;
  nodeVersion: string;
  region: string;
  framework: string;
  domains: string[];
  /**
   * Production's domains that dev's apiDomains still list. In one project (docs/production.md ›
   * One project, two environments) none should be, so this is empty unless infra is mid-change.
   */
  notYetMoved: string[];
  firewall: Firewall;
  /** apps/api/vercel.json's `schedules`, by name. */
  schedules: { name: string; path: string; schedule: string }[];
  required: readonly string[];
  optional: readonly string[];
  forbidden: readonly string[];
  secrets: readonly string[];
}

const VercelJson = z.object({
  framework: z.string(),
  regions: z.array(z.string()).min(1),
  schedules: z.record(z.string(), z.object({ path: z.string(), schedule: z.string() })),
});

/** apps/api/vercel.json: what every deployment of the API is built with. */
export function readVercelJson(path = join(ROOT, "apps", "api", "vercel.json")) {
  return VercelJson.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** apps/api/package.json's Node range, as Vercel's project setting writes it (`26.x`). */
export function apiNodeVersion(path = join(ROOT, "apps", "api", "package.json")): string {
  const engines = z.object({ engines: z.object({ node: z.string() }).optional() });
  const node = engines.parse(JSON.parse(readFileSync(path, "utf8"))).engines?.node;
  const major = node ? /(\d+)/.exec(node)?.[1] : undefined;
  if (!major) throw new Error(`${path} names no Node version in engines`);
  return `${major}.x`;
}

export function vercelDesired(ctx: Pick<CheckContext, "env" | "infra">): VercelDesired {
  const environments = ctx.infra["environments.json"].environments;
  const environment = environments[ctx.env];
  const vercelJson = readVercelJson();
  return {
    env: ctx.env,
    project: environment.vercelProject,
    rootDirectory: "apps/api",
    nodeVersion: apiNodeVersion(),
    region: vercelJson.regions[0] as string,
    framework: vercelJson.framework,
    domains: environment.apiDomains,
    notYetMoved:
      ctx.env === "production"
        ? environment.apiDomains.filter((d) => environments.dev.apiDomains.includes(d))
        : [],
    firewall: ctx.infra["vercel-firewall.json"],
    schedules: Object.entries(vercelJson.schedules).map(([name, { path, schedule }]) => ({
      name,
      path,
      schedule,
    })),
    required: REQUIRED_ENV,
    optional: OPTIONAL_ENV,
    forbidden: FORBIDDEN_ENV,
    secrets: SECRET_ENV,
  };
}

// --- observed -----------------------------------------------------------------------------------

const RawProject = z.object({
  name: z.string(),
  id: z.string(),
  framework: z.string().nullish(),
  nodeVersion: z.string().nullish(),
  rootDirectory: z.string().nullish(),
  serverlessFunctionRegion: z.string().nullish(),
  link: z.unknown().optional(),
  oidcTokenConfig: z
    .object({ enabled: z.boolean().optional(), issuerMode: z.string().optional() })
    .nullish(),
  ssoProtection: z.object({ deploymentType: z.string() }).nullish(),
  passwordProtection: z.unknown().optional(),
  crons: z
    .object({
      disabledAt: z.number().nullish(),
      definitions: z.array(z.object({ path: z.string(), schedule: z.string() })).default([]),
    })
    .nullish(),
  env: z
    .array(
      z.object({
        key: z.string(),
        target: z.union([z.array(z.string()), z.string()]).nullish(),
        type: z.string(),
      }),
    )
    .default([]),
  targets: z
    .object({
      production: z
        .object({
          readyState: z.string().nullish(),
          meta: z.object({ gitCommitSha: z.string().optional() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const RawDomains = z.object({
  domains: z.array(
    z.object({
      name: z.string(),
      verified: z.boolean(),
      redirect: z.string().nullish(),
    }),
  ),
});

const RawCondition = z.object({
  type: z.string(),
  op: z.string(),
  neg: z.boolean().nullish(),
  key: z.string().nullish(),
  value: z.unknown().optional(),
});

const RawRule = z.object({
  name: z.string(),
  active: z.boolean(),
  conditionGroup: z.array(z.object({ conditions: z.array(RawCondition) })),
  action: z.object({
    mitigate: z
      .object({
        action: z.string(),
        rateLimit: z
          .object({
            algo: z.string(),
            window: z.number(),
            limit: z.number(),
            keys: z.array(z.string()),
            action: z.string().nullish(),
          })
          .nullish(),
      })
      .nullish(),
  }),
});

const RawToggle = z.object({ active: z.boolean(), action: z.string().nullish() });

const RawFirewall = z.object({
  firewallEnabled: z.boolean(),
  crs: z.record(z.string(), RawToggle).nullish(),
  managedRules: z.record(z.string(), RawToggle).nullish(),
  rules: z.array(RawRule).default([]),
});

export interface ObservedEnv {
  key: string;
  targets: string[];
  type: string;
}

export interface NormalRule {
  name: string;
  active: boolean;
  conditionGroup: { conditions: Record<string, unknown>[] }[];
  action: string;
  rateLimit: { algo: string; window: number; limit: number; keys: string[]; action: string } | null;
}

export interface NormalFirewall {
  firewallEnabled: boolean;
  crs: Record<string, { active: boolean; action: string | null }>;
  managedRules: Record<string, { active: boolean; action: string | null }>;
  rules: NormalRule[];
}

export interface VercelObserved {
  /** `null`: the project does not exist. */
  project: null | {
    name: string;
    framework: string | null;
    nodeVersion: string | null;
    rootDirectory: string | null;
    region: string | null;
    gitConnected: boolean;
    oidc: { enabled: boolean; issuerMode: string | null };
    protection: string | null;
    env: ObservedEnv[];
    crons: { disabled: boolean; definitions: { path: string; schedule: string }[] } | null;
    production: { readyState: string | null; commit: string | null } | null;
  };
  domains: { name: string; verified: boolean; redirect: string | null }[];
  /** `null`: the project has no firewall configuration at all. */
  firewall: NormalFirewall | null;
}

/** `botProtection` → `bot_protection`: the SDK renames these; the API and infra do not. */
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The firewall as the check compares it: names, conditions, actions and limits, nothing else. */
export function normalizeFirewall(raw: unknown): NormalFirewall {
  const fw = RawFirewall.parse(raw);
  const toggles = (record: Record<string, z.infer<typeof RawToggle>> | null | undefined) =>
    Object.fromEntries(
      Object.entries(record ?? {}).map(([key, value]) => [
        snake(key),
        { active: value.active, action: value.action ?? null },
      ]),
    );
  return {
    firewallEnabled: fw.firewallEnabled,
    crs: toggles(fw.crs),
    managedRules: toggles(fw.managedRules),
    rules: fw.rules.map((rule) => {
      const limit = rule.action.mitigate?.rateLimit;
      return {
        name: rule.name,
        active: rule.active,
        conditionGroup: rule.conditionGroup.map((group) => ({
          conditions: group.conditions.map((c) => ({
            type: c.type,
            op: c.op,
            neg: c.neg ?? false,
            ...(c.key != null ? { key: c.key } : {}),
            ...(c.value !== undefined && c.value !== null ? { value: c.value } : {}),
          })),
        })),
        action: rule.action.mitigate?.action ?? "none",
        rateLimit: limit
          ? {
              algo: limit.algo,
              window: limit.window,
              limit: limit.limit,
              keys: [...limit.keys].sort(),
              action: limit.action ?? "rate_limit",
            }
          : null,
      };
    }),
  };
}

/**
 * What the check keeps of the three answers: settings, variable names and targets (never a
 * value), domains, and the firewall. Pure, so tests feed it recorded answers.
 */
export function observeVercel(
  rawProject: unknown,
  rawDomains: unknown,
  rawFirewall: unknown,
): VercelObserved {
  if (rawProject === null) return { project: null, domains: [], firewall: null };
  const project = RawProject.parse(rawProject);
  const production = project.targets?.production;
  return {
    project: {
      name: project.name,
      framework: project.framework ?? null,
      nodeVersion: project.nodeVersion ?? null,
      rootDirectory: project.rootDirectory ?? null,
      region: project.serverlessFunctionRegion ?? null,
      gitConnected: project.link != null,
      oidc: {
        enabled: project.oidcTokenConfig?.enabled ?? false,
        issuerMode: project.oidcTokenConfig?.issuerMode ?? null,
      },
      protection: project.ssoProtection?.deploymentType ?? null,
      env: project.env.map((entry) => ({
        key: entry.key,
        targets: entry.target == null ? [] : [entry.target].flat(),
        type: entry.type,
      })),
      crons: project.crons
        ? {
            disabled: project.crons.disabledAt != null,
            definitions: project.crons.definitions.map(({ path, schedule }) => ({
              path,
              schedule,
            })),
          }
        : null,
      production: production
        ? {
            readyState: production.readyState ?? null,
            commit: production.meta?.gitCommitSha ?? null,
          }
        : null,
    },
    domains: rawDomains
      ? RawDomains.parse(rawDomains).domains.map((d) => ({
          name: d.name,
          verified: d.verified,
          redirect: d.redirect ?? null,
        }))
      : [],
    firewall: rawFirewall ? normalizeFirewall(rawFirewall) : null,
  };
}

/** What the SDK answered, or what the API sent when the SDK's schema refused it. */
export async function answer<T>(call: () => Promise<T>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ResponseValidationError) return error.rawValue;
    throw error;
  }
}

/** The same, but `null` for a 404: the thing does not exist. */
export async function answerOrMissing<T>(call: () => Promise<T>): Promise<unknown> {
  try {
    return await answer(call);
  } catch (error) {
    if (error instanceof VercelError && error.statusCode === 404) return null;
    throw error;
  }
}

/** The team, by id when one is given, otherwise by its public slug. */
export function team(
  ctx: Pick<CheckContext, "credentials">,
): { teamId: string } | { slug: string } {
  const teamId = ctx.credentials.VERCEL_TEAM_ID;
  return teamId ? { teamId } : { slug: VERCEL_TEAM_SLUG };
}

/** A read-only SDK client over `ctx.fetch`. */
export function vercelClient(ctx: CheckContext): Vercel {
  return new Vercel({
    bearerToken: ctx.credentials.VERCEL_TOKEN as string,
    httpClient: new HTTPClient({ fetcher: (input, init) => ctx.fetch(input, init) }),
  });
}

/** The project's id, or `null` when it does not exist. */
export async function readProjectId(ctx: CheckContext, idOrName: string): Promise<string | null> {
  const vercel = vercelClient(ctx);
  const project = await answerOrMissing(() =>
    vercel.projects.getProject({ idOrName, ...team(ctx) }),
  );
  return project === null ? null : RawProject.parse(project).id;
}

export async function fetchVercel(
  ctx: CheckContext,
  desired: VercelDesired,
): Promise<VercelObserved> {
  if (!desired.project) return { project: null, domains: [], firewall: null };
  const vercel = vercelClient(ctx);
  const scope = team(ctx);
  const idOrName = desired.project;
  const project = await answerOrMissing(() => vercel.projects.getProject({ idOrName, ...scope }));
  if (project === null) return observeVercel(null, null, null);
  const projectId = RawProject.parse(project).id;
  const [domains, firewall] = await Promise.all([
    answer(() => vercel.projects.getProjectDomains({ idOrName: projectId, ...scope })),
    answerOrMissing(() =>
      vercel.security.getFirewallConfig({ projectId, configVersion: "active", ...scope }),
    ),
  ]);
  return observeVercel(project, domains, firewall);
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("vercel");

/** Production's founder step that creates the project. */
const CREATE = (env: EnvironmentName) =>
  `bun scripts/prod/apply.ts vercel-project --env ${env} --yes (founder step D2)`;

export function evaluateVercel(desired: VercelDesired, observed: VercelObserved): Finding[] {
  const { env } = desired;
  if (!desired.project) {
    return [f.pending("project", `infra names no Vercel project for ${env} yet`)];
  }
  const project = observed.project;
  if (!project) {
    return env === "production"
      ? [f.pending("project", `${desired.project} does not exist yet`, CREATE(env))]
      : [f.fail("project", `${desired.project} does not exist`, CREATE(env))];
  }
  const out: Finding[] = [];
  const name = project.name;

  // Settings.
  const wrong: string[] = [];
  if (project.rootDirectory !== desired.rootDirectory) {
    wrong.push(
      `root directory is ${project.rootDirectory ?? "unset"}, not ${desired.rootDirectory}`,
    );
  }
  if (project.nodeVersion !== desired.nodeVersion) {
    wrong.push(`Node is ${project.nodeVersion ?? "unset"}, not ${desired.nodeVersion}`);
  }
  if (project.region !== desired.region) {
    wrong.push(`function region is ${project.region ?? "unset"}, not ${desired.region}`);
  }
  // vercel.json names the framework, so a project left on "Other" (null) builds as it says.
  if (project.framework !== null && project.framework !== desired.framework) {
    wrong.push(`framework is ${project.framework}, not ${desired.framework}`);
  }
  if (project.gitConnected) {
    wrong.push("a Git repository is connected, so a push would deploy outside the workflow");
  }
  out.push(
    wrong.length
      ? f.fail(
          "settings",
          `${name}: ${list(wrong)}`,
          `bun scripts/prod/apply.ts vercel-project --env ${env}`,
        )
      : f.ok(
          "settings",
          `${name}: root ${desired.rootDirectory}, Node ${desired.nodeVersion}, region ${desired.region}, no Git connection`,
        ),
  );

  out.push(
    project.oidc.enabled && project.oidc.issuerMode === "team"
      ? f.ok("oidc", "OIDC tokens are on, issued by the team")
      : f.fail(
          "oidc",
          `OIDC is ${project.oidc.enabled ? `on with issuer ${project.oidc.issuerMode ?? "unset"}` : "off"}; sandboxes need the team issuer`,
          `Vercel › ${name} › Settings › Security › Secure backend access with OIDC federation: Team`,
        ),
  );

  out.push(
    project.protection && PROTECTED.includes(project.protection)
      ? f.ok("protection", `Standard Deployment Protection is on (${project.protection})`)
      : f.fail(
          "protection",
          `deployment protection is ${project.protection ?? "off"}: every deployment holds the live secrets`,
          `Vercel › ${name} › Settings › Deployment Protection: Standard Protection`,
        ),
  );

  out.push(...evaluateEnv(desired, name, project.env));

  // Domains.
  const missing = desired.domains.filter(
    (domain) => !observed.domains.some((d) => d.name === domain && d.verified && !d.redirect),
  );
  const domainsSay = `${list(missing)} ${missing.length === 1 ? "is" : "are"} not a verified domain of ${name}`;
  const domainsFix = `Vercel › ${name} › Settings › Domains (docs/production.md › Vercel \`ponzu-api\`)`;
  out.push(
    !missing.length
      ? f.ok("domains", `${list(desired.domains)} on ${name}, verified`)
      : missing.every((domain) => desired.notYetMoved.includes(domain))
        ? f.pending("domains", `${domainsSay}: infra still lists it as dev's too`, domainsFix)
        : f.fail("domains", domainsSay, domainsFix),
  );

  out.push(...evaluateFirewall(desired, observed.firewall));

  // The latest production deployment, and whether a legacy cron is still on.
  const production = project.production;
  out.push(
    production?.readyState === "READY"
      ? f.ok(
          "deployment",
          `the latest production deployment is ready${production.commit ? `, built from ${production.commit.slice(0, 12)}` : ""}`,
        )
      : f.fail(
          "deployment",
          production
            ? `the latest production deployment is ${production.readyState ?? "in an unknown state"}`
            : `${name} has no production deployment`,
          "the deploy-api workflow, or docs/production.md › The founder's steps (D15)",
        ),
  );
  // The minute is a Schedule (apps/api/vercel.json's `schedules`). vercel.json still carries the
  // legacy cron so production never went a minute without a run while it moved; once the schedule
  // has fired in production the project's Disable Cron Jobs switch turns the cron off, and until
  // then this line fails, because both run the minute.
  const crons = project.crons;
  const legacy = crons && !crons.disabled ? crons.definitions.map(cronLine).sort() : [];
  out.push(
    legacy.length
      ? f.fail(
          "crons",
          `a legacy cron is still on (${list(legacy)}), beside the minute schedule`,
          `Vercel › ${name} › Settings › Cron Jobs: Disable Cron Jobs, once the minute schedule has fired in production (docs/production.md › The minute)`,
        )
      : f.ok("crons", "no legacy cron is on"),
  );
  // Whether a schedule is active is per environment and is read through Vercel's Schedules API,
  // which this check does not call yet: the deploy job's scripts/ci/schedules.ts checks it.
  out.push(
    f.manual(
      "schedules",
      `vercel.json declares ${list(desired.schedules.map((s) => `${s.name}: ${s.path} (${s.schedule})`))}; that it is active in ${env} is not read here`,
      `bunx ${VERCEL_CLI} schedules list${env === "production" ? "" : ` --environment ${env}`} (docs/production.md › The minute)`,
    ),
  );
  return out;
}

const cronLine = (cron: { path: string; schedule: string }) => `${cron.path} (${cron.schedule})`;

function evaluateEnv(desired: VercelDesired, name: string, env: ObservedEnv[]): Finding[] {
  const out: Finding[] = [];
  const on = (target: string) =>
    new Set(env.filter((e) => e.targets.includes(target)).map((e) => e.key));
  const production = on("production");
  const known = new Set([...desired.required, ...desired.optional]);
  const forbidden = new Set(desired.forbidden);
  const varsFix = `Vercel › ${name} › Settings › Environment Variables (docs/production.md › Env and secrets)`;

  const missing = desired.required.filter((key) => !production.has(key));
  out.push(
    missing.length
      ? f.fail(
          "env.required",
          `the Production target lacks ${list(missing)}`,
          `secrets: bun scripts/prod/apply.ts secrets generate --names <NAMES> --env ${desired.env} or the dashboard as sensitive; public values: bun scripts/prod/apply.ts vercel-env --env ${desired.env}`,
        )
      : f.ok(
          "env.required",
          `the Production target has all ${desired.required.length} names the API needs`,
        ),
  );

  const unknown = [...production].filter((key) => !known.has(key) && !forbidden.has(key)).sort();
  out.push(
    unknown.length
      ? f.fail(
          "env.unknown",
          `the API reads no ${list(unknown)}, set on the Production target`,
          `remove it: ${varsFix}`,
        )
      : f.ok("env.unknown", "every name on the Production target is one the API reads"),
  );

  const banned = desired.forbidden
    .map((key) => ({ key, targets: env.filter((e) => e.key === key).flatMap((e) => e.targets) }))
    .filter((entry) => entry.targets.length);
  out.push(
    banned.length
      ? f.fail(
          "env.forbidden",
          banned
            .map((b) => `${b.key} is set on ${list([...new Set(b.targets)].sort())}`)
            .join("; "),
          `remove it: ${varsFix}`,
        )
      : f.ok("env.forbidden", `none of ${list([...desired.forbidden])} is set`),
  );

  if (desired.env === "production") {
    // One project holds both environments, so Preview may hold dev's values in its own entries.
    // What must never happen is one entry covering Production and another target: one entry is
    // one value, so that would be a production secret on a preview. (Entries scoped to the `dev`
    // custom environment are not read here yet: docs/production.md › Checking production.)
    const shared = env
      .filter((e) => e.targets.includes("production") && e.targets.some((t) => t !== "production"))
      .map((e) => `${e.key} (${list(e.targets.filter((t) => t !== "production").sort())})`)
      .sort();
    out.push(
      shared.length
        ? f.fail(
            "env.preview",
            `${list(shared)} ${shared.length === 1 ? "is one entry" : "are entries"} shared by the Production target and another`,
            `give Production its own entry: ${varsFix}`,
          )
        : f.ok("env.preview", "no entry on the Production target covers another target"),
    );
    const readable = env
      .filter((e) => e.targets.includes("production") && desired.secrets.includes(e.key))
      .filter((e) => e.type !== "sensitive")
      .map((e) => e.key)
      .sort();
    out.push(
      readable.length
        ? f.fail(
            "env.sensitive",
            `${list(readable)} ${readable.length === 1 ? "is" : "are"} not stored as sensitive`,
            `set again as sensitive: ${varsFix}`,
          )
        : f.ok("env.sensitive", "every secret on the Production target is stored as sensitive"),
    );
  }
  return out;
}

/** The firewall that is live, against infra/vercel-firewall.json: one line for each part. */
export function evaluateFirewall(desired: VercelDesired, live: NormalFirewall | null): Finding[] {
  const fix = `bun scripts/prod/apply.ts firewall --env ${desired.env}`;
  if (!live) return [f.fail("firewall", "the project has no firewall configuration", fix)];
  const want = normalizeFirewall(desired.firewall);
  const out: Finding[] = [];

  out.push(
    live.firewallEnabled === want.firewallEnabled
      ? f.ok("firewall.enabled", `the firewall is ${want.firewallEnabled ? "on" : "off"}`)
      : f.fail(
          "firewall.enabled",
          `the firewall is ${live.firewallEnabled ? "on" : "off"}, not ${want.firewallEnabled ? "on" : "off"}`,
          fix,
        ),
  );

  const toggles = (what: string, wanted: NormalFirewall["crs"], have: NormalFirewall["crs"]) => {
    // Absent is off: the API leaves out what was never turned on.
    const state = (t: { active: boolean; action: string | null } | undefined) =>
      t?.active ? (t.action ?? "on") : "off";
    const off = Object.entries(wanted)
      .filter(([key, value]) => state(have[key]) !== state(value))
      .map(([key, value]) => `${key} ${state(have[key])} (file: ${state(value)})`);
    return off.length
      ? f.fail(`firewall.${what}`, `live differs: ${off.join(", ")}`, fix)
      : f.ok(
          `firewall.${what}`,
          `${Object.keys(wanted).length} ${what === "crs" ? "OWASP categories" : "managed rulesets"} as the file says`,
        );
  };
  out.push(toggles("crs", want.crs, live.crs));
  out.push(toggles("managed", want.managedRules, live.managedRules));

  const problems: string[] = [];
  const liveByName = new Map(live.rules.map((rule) => [rule.name, rule]));
  for (const rule of want.rules) {
    const got = liveByName.get(rule.name);
    if (!got) {
      problems.push(`"${rule.name}" is missing`);
      continue;
    }
    const differs: string[] = [];
    if (got.active !== rule.active) differs.push(got.active ? "is active" : "is inactive");
    if (JSON.stringify(got.conditionGroup) !== JSON.stringify(rule.conditionGroup)) {
      differs.push("its conditions differ");
    }
    if (got.action !== rule.action) differs.push(`its action is ${got.action}, not ${rule.action}`);
    if (JSON.stringify(got.rateLimit) !== JSON.stringify(rule.rateLimit)) {
      const a = got.rateLimit;
      const b = rule.rateLimit;
      differs.push(
        a && b
          ? `its limit is ${a.limit} per ${a.window} s (${a.algo}, keys ${a.keys.join("+")}), not ${b.limit} per ${b.window} s (${b.algo}, keys ${b.keys.join("+")})`
          : `its rate limit is ${a ? "set" : "absent"}, not ${b ? "set" : "absent"}`,
      );
    }
    if (differs.length) problems.push(`"${rule.name}": ${list(differs)}`);
  }
  const extra = live.rules.filter((rule) => !want.rules.some((w) => w.name === rule.name));
  for (const rule of extra) problems.push(`"${rule.name}" is live but not in the file`);
  out.push(
    problems.length
      ? f.fail("firewall.rules", problems.join("; "), fix)
      : f.ok("firewall.rules", `all ${want.rules.length} rules live, as the file says`),
  );
  return out;
}

export const vercelSection: Section<VercelDesired, VercelObserved> = {
  area: "vercel",
  needs: ["VERCEL_TOKEN"],
  desired: vercelDesired,
  fetchObserved: fetchVercel,
  evaluate: evaluateVercel,
};
