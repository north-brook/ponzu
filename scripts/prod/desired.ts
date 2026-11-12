#!/usr/bin/env bun
/**
 * Production's desired state, as the repository writes it down (docs/production.md). `infra/`
 * holds only public values: who talks to what in each environment, and the settings each vendor
 * must have. Secrets never live there. This module is the one reader of those files: the zod
 * schemas, the loaders, and the two questions everything else asks of them.
 *
 *   bun scripts/prod/desired.ts status <dev|production> [--file <environments.json>]
 *       every field of that environment, one line each: `ok`, `none` (deliberately absent) or
 *       `pending` (not created yet, with the step that creates it). Exit 0 unless a file fails
 *       to parse.
 *   bun scripts/prod/desired.ts assert-release <dev|production> [--file <environments.json>]
 *       exit 0 only when the release build is set to that environment, every one of its fields
 *       is set, and none of the fields that say where to connect is the other environment's;
 *       otherwise print why, one line each, and exit 1. release.yml will run it with
 *       `production` so no release can ship pointing at dev.
 *
 * In environments.json, `null` always means "not created yet", and is never read as a pass.
 * A field that is absent on purpose says so with `false` (dev has no private bucket and no
 * minimum client versions). `neonBranch: "@default"` names the Neon project's default branch,
 * whatever it is called, as the scripts resolve it by id.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

export const INFRA_DIR = join(import.meta.dir, "..", "..", "infra");

export const ENVIRONMENT_NAMES = ["dev", "production"] as const;
export const EnvironmentName = z.enum(ENVIRONMENT_NAMES);
export type EnvironmentName = z.infer<typeof EnvironmentName>;

// --- environments.json --------------------------------------------------------------------------

/** An https origin with no path, query or trailing slash, as clients compare them. */
const httpsOrigin = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", "not https")
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, "not a bare origin");

const hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
/** An R2 bucket name: 3 to 63 lowercase letters, digits and hyphens. */
const bucket = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
/** What PONZU_MIN_CLIENT_VERSIONS takes in apps/api: `platform=x.y.z`, comma-separated. */
const minClientVersions = z
  .string()
  .regex(/^(macos|windows|linux|ios)=\d+\.\d+\.\d+(,(macos|windows|linux|ios)=\d+\.\d+\.\d+)*$/);

export const EnvironmentSchema = z
  .strictObject({
    /** Where the apps and the runners call: PONZU_API_URL. */
    apiUrl: httpsOrigin.nullable(),
    /** The WorkOS environment's client id, which the apps ship. */
    workosClientId: z
      .string()
      .regex(/^client_[0-9A-Z]{26}$/)
      .nullable(),
    /** Neon Realtime's host, which the API hands clients and the desktop's CSP allows. */
    realtimeUrl: httpsOrigin.nullable(),
    /** Where a canvas's files are served (PONZU_ASSETS_URL). */
    assetsUrl: httpsOrigin.nullable(),
    githubAppSlug: slug.nullable(),
    vercelProject: slug.nullable(),
    /** A named child branch, or `@default` for the project's default branch. */
    neonBranch: z.union([z.literal("@default"), slug]).nullable(),
    r2: z.strictObject({
      assets: bucket.nullable(),
      /** `false`: no private bucket, so checkpoints sit in the assets bucket. */
      private: z.union([bucket, z.literal(false)]).nullable(),
    }),
    posthog: z.strictObject({
      projectId: z.number().int().positive().nullable(),
      host: httpsOrigin,
      replay: z.enum(["full", "private"]),
      aiContent: z.boolean(),
    }),
    /** The API's own public domains on its Vercel project. */
    apiDomains: z.array(hostname).min(1),
    /** `false`: no client is turned away for its version. */
    minClientVersions: z.union([minClientVersions, z.literal(false)]).nullable(),
  })
  .refine(
    (env) => env.apiUrl === null || env.apiDomains.includes(new URL(env.apiUrl).hostname),
    "apiUrl's host is not one of apiDomains",
  );
export type Environment = z.infer<typeof EnvironmentSchema>;

export const EnvironmentsSchema = z
  .strictObject({
    /** Which environment a `release` desktop build bakes in. Flipped only by the cutover PR. */
    release: EnvironmentName,
    environments: z.strictObject({ dev: EnvironmentSchema, production: EnvironmentSchema }),
  })
  // Production keeps checkpoints out of the publicly served assets bucket from its first day.
  .refine((file) => file.environments.production.r2.private !== false, {
    message: "production must have a private bucket (r2.private may be null, never false)",
    path: ["environments", "production", "r2", "private"],
  });
export type Environments = z.infer<typeof EnvironmentsSchema>;

/** Why a field is still `null`, and what makes it set. Anything not named is "not created yet". */
export const PENDING_BECAUSE: Record<string, string> = {
  "production.workosClientId": "founder step D7",
  "production.realtimeUrl": "founder step D3",
  "production.posthog.projectId": "founder step D8",
  "dev.r2.assets": "read from Cloudflare by production slice 9",
};

export interface FieldLine {
  /** `production.posthog.projectId` */
  path: string;
  state: "ok" | "none" | "pending";
  says: string;
}

/** One line for every field of an environment. A `null` is `pending`, never `ok`. */
export function fieldLines(file: Environments, env: EnvironmentName): FieldLine[] {
  const lines: FieldLine[] = [];
  const walk = (value: unknown, path: string) => {
    if (value === null) {
      lines.push({ path, state: "pending", says: PENDING_BECAUSE[path] ?? "not created yet" });
    } else if (value === false && !path.endsWith(".aiContent")) {
      lines.push({ path, state: "none", says: "absent on purpose" });
    } else if (typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, `${path}.${key}`);
      }
    } else {
      lines.push({ path, state: "ok", says: JSON.stringify(value) });
    }
  };
  walk(file.environments[env], env);
  return lines;
}

/** Why a release build may not ship pointing at `env`, one sentence each; empty when it may. */
export function releaseProblems(file: Environments, env: EnvironmentName): string[] {
  const problems: string[] = [];
  if (file.release !== env) {
    problems.push(`release is "${file.release}" in infra/environments.json, not "${env}"`);
  }
  for (const line of fieldLines(file, env)) {
    if (line.state === "pending") {
      problems.push(`${line.path} is not set in infra/environments.json (${line.says})`);
    }
  }
  const other = env === "dev" ? "production" : "dev";
  for (const path of SEPARATE_FIELDS) {
    const mine = at(file.environments[env], path);
    if (mine !== null && mine !== false && mine === at(file.environments[other], path)) {
      problems.push(`${env}.${path} is the same as ${other}'s, so a release would reach ${other}`);
    }
  }
  for (const domain of file.environments[env].apiDomains) {
    if (file.environments[other].apiDomains.includes(domain)) {
      problems.push(`${domain} is in both environments' apiDomains; move ${other}'s first`);
    }
  }
  return problems;
}

/**
 * Fields no two environments may share once a release points at one: sharing any of them would
 * put a production build on dev's API, sign-in, database, files or analytics, or the reverse.
 * Today dev and production both name api.ponzu.design, and founder step D11 moves dev off it.
 */
export const SEPARATE_FIELDS = [
  "apiUrl",
  "workosClientId",
  "realtimeUrl",
  "assetsUrl",
  "githubAppSlug",
  "vercelProject",
  "neonBranch",
  "r2.assets",
  "r2.private",
  "posthog.projectId",
] as const;

function at(env: Environment, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], env);
}

// --- vercel-firewall.json -----------------------------------------------------------------------

const firewallAction = z.enum(["log", "deny", "challenge", "bypass", "rate_limit"]);

const FirewallCondition = z.strictObject({
  type: z.string().min(1),
  op: z.enum(["eq", "neq", "pre", "suf", "sub", "re", "inc", "ninc", "ex", "nex", "gt", "lt"]),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  key: z.string().optional(),
  neg: z.boolean().optional(),
});

const FirewallRule = z
  .strictObject({
    name: z.string().min(1).max(160),
    description: z.string().max(256),
    active: z.boolean(),
    conditionGroup: z
      .array(z.strictObject({ conditions: z.array(FirewallCondition).min(1) }))
      .min(1),
    action: z.strictObject({
      mitigate: z.strictObject({
        action: firewallAction,
        rateLimit: z
          .strictObject({
            algo: z.enum(["fixed_window", "token_bucket"]),
            window: z.number().int().min(10).max(3600),
            limit: z.number().int().min(1).max(10_000_000),
            keys: z.array(z.string()).min(1),
            action: z.enum(["rate_limit", "deny", "log"]),
          })
          .optional(),
      }),
    }),
  })
  .refine(
    (rule) => (rule.action.mitigate.action === "rate_limit") === !!rule.action.mitigate.rateLimit,
    "a rate_limit rule needs rateLimit, and only it",
  );

const crsCategory = z.strictObject({ active: z.boolean(), action: z.enum(["log", "deny"]) });

export const FirewallSchema = z
  .strictObject({
    firewallEnabled: z.boolean(),
    /** The OWASP core ruleset, by category. */
    crs: z.strictObject({
      sd: crsCategory,
      ma: crsCategory,
      lfi: crsCategory,
      rfi: crsCategory,
      rce: crsCategory,
      php: crsCategory,
      gen: crsCategory,
      xss: crsCategory,
      sqli: crsCategory,
      sf: crsCategory,
      java: crsCategory,
    }),
    managedRules: z.strictObject({
      bot_protection: z.strictObject({ active: z.boolean(), action: z.enum(["log", "deny"]) }),
      ai_bots: z.strictObject({ active: z.boolean(), action: z.enum(["log", "deny"]) }),
    }),
    rules: z.array(FirewallRule),
  })
  // Canvas HTML in ops matches the XSS and SQL rules, so they only ever log.
  .refine((fw) => fw.crs.xss.action === "log" && fw.crs.sqli.action === "log", {
    message: "the xss and sqli categories must only log: canvas HTML matches them",
  })
  // The apps cannot solve a challenge, so nothing on the API host ever asks for one.
  .refine((fw) => fw.rules.every((rule) => rule.action.mitigate.action !== "challenge"), {
    message: "no rule may challenge: the apps cannot solve one",
  })
  .refine((fw) => new Set(fw.rules.map((rule) => rule.name)).size === fw.rules.length, {
    message: "rule names must be unique",
  });
export type Firewall = z.infer<typeof FirewallSchema>;

// --- neon.json ----------------------------------------------------------------------------------

const NeonEnvironment = z.strictObject({
  realtime: z.boolean(),
  /** `PATCH /projects/{id}/endpoints/{ep}`. -1 turns scale-to-zero off. */
  compute: z
    .strictObject({
      suspendTimeoutSeconds: z.number().int().min(-1),
      autoscalingLimitMinCu: z.number().positive(),
      autoscalingLimitMaxCu: z.number().positive(),
    })
    .refine((c) => c.autoscalingLimitMinCu <= c.autoscalingLimitMaxCu, "min above max")
    .optional(),
  /** Point-in-time history on the project. */
  historyRetentionSeconds: z.number().int().positive().optional(),
  /** `PUT /projects/{id}/branches/{branch}/backup_schedule`. */
  backupSchedule: z
    .array(
      z.strictObject({
        frequency: z.enum(["hourly", "daily", "weekly", "monthly"]),
        hour: z.number().int().min(0).max(23),
        retentionSeconds: z.number().int().positive(),
      }),
    )
    .min(1)
    .optional(),
  protected: z.boolean().optional(),
  /** Taken by the production deploy before it migrates: `pre-<sha12>`. */
  preDeploySnapshot: z
    .strictObject({ namePrefix: z.string().min(1), expiresAfterDays: z.number().int().positive() })
    .optional(),
});

export const NeonSchema = z
  .strictObject({
    environments: z.strictObject({ dev: NeonEnvironment, production: NeonEnvironment }),
  })
  // A waking database eats the health check's 3 seconds, so production never sleeps.
  .refine((neon) => neon.environments.production.compute?.suspendTimeoutSeconds === -1, {
    message: "production's compute must have scale-to-zero off (suspendTimeoutSeconds -1)",
  });
export type Neon = z.infer<typeof NeonSchema>;

// --- r2/lifecycle.json, r2/cors.json ------------------------------------------------------------

const age = z.strictObject({
  condition: z.strictObject({ type: z.literal("Age"), maxAge: z.number().int().positive() }),
});

export const LifecycleSchema = z
  .strictObject({
    rules: z.array(
      z.strictObject({
        id: z.string().min(1),
        enabled: z.boolean(),
        conditions: z.strictObject({ prefix: z.string() }),
        deleteObjectsTransition: age.optional(),
        abortMultipartUploadsTransition: age.optional(),
      }),
    ),
  })
  // A delete rule on an empty prefix would empty the bucket.
  .refine((lc) => lc.rules.every((r) => !r.deleteObjectsTransition || r.conditions.prefix !== ""), {
    message: "a delete rule needs a prefix",
  })
  // A rule cannot tell a recorded checkpoint from an unrecorded one (program §5.15); the API's
  // sweep tidies private/ instead. A prefix covers private/ when it is inside it ("private/x")
  // or when private/ is inside it ("p", "priv"). Aborting incomplete uploads everywhere is fine:
  // it never deletes a finished object.
  .refine(
    (lc) =>
      lc.rules.every(
        (r) =>
          !r.conditions.prefix.startsWith("private") &&
          !(r.deleteObjectsTransition && "private/".startsWith(r.conditions.prefix)),
      ),
    { message: "no lifecycle rule may touch private/: it would delete live checkpoints" },
  );

export const CorsSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        allowed: z.strictObject({
          origins: z.array(z.string().min(1)).min(1),
          methods: z.array(z.enum(["GET", "PUT", "HEAD", "POST", "DELETE"])).min(1),
          headers: z.array(z.string().min(1)),
        }),
        maxAgeSeconds: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

// --- cloudflare/assets-headers.json -------------------------------------------------------------

export const AssetsHeadersSchema = z.strictObject({
  zone: hostname,
  phase: z.literal("http_response_headers_transform"),
  hosts: z.strictObject({
    dev: z.strictObject({ host: hostname, required: z.boolean() }),
    production: z.strictObject({ host: hostname, required: z.literal(true) }),
  }),
  headers: z.record(z.string(), z.string().min(1)),
});

// --- posthog.json -------------------------------------------------------------------------------

export const PosthogSchema = z.strictObject({
  /** Fields of PostHog's project (`/api/projects/:id`) both projects must have. */
  project: z.strictObject({
    session_recording_opt_in: z.boolean(),
    autocapture_exceptions_opt_in: z.boolean(),
    capture_console_log_opt_in: z.boolean(),
    heatmaps_opt_in: z.boolean(),
  }),
  /** Group types that must exist once the first event has come in. */
  groupTypes: z.array(z.string().min(1)),
});

// --- github/*.json ------------------------------------------------------------------------------

/** The fields GitHub's "create a repository ruleset" request takes, and nothing else. */
export const RULESET_REQUEST_FIELDS = [
  "name",
  "target",
  "enforcement",
  "bypass_actors",
  "conditions",
  "rules",
] as const;

export const RulesetSchema = z.strictObject({
  name: z.string().min(1),
  target: z.enum(["branch", "tag", "push"]),
  enforcement: z.enum(["disabled", "active", "evaluate"]),
  bypass_actors: z.array(
    z.strictObject({
      actor_id: z.number().int().nullable(),
      actor_type: z.enum([
        "Integration",
        "OrganizationAdmin",
        "RepositoryRole",
        "Team",
        "DeployKey",
      ]),
      bypass_mode: z.enum(["always", "pull_request", "exempt"]),
    }),
  ),
  conditions: z.strictObject({
    ref_name: z.strictObject({ include: z.array(z.string()), exclude: z.array(z.string()) }),
  }),
  rules: z
    .array(
      z.strictObject({
        type: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const sortedUnique = (names: string[]) =>
  names.every((name, i) => i === 0 || (names[i - 1] as string) < name);

export const RepoSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  merge: z.strictObject({
    allow_auto_merge: z.boolean(),
    allow_merge_commit: z.boolean(),
    allow_rebase_merge: z.boolean(),
    allow_squash_merge: z.boolean(),
    allow_update_branch: z.boolean(),
    delete_branch_on_merge: z.boolean(),
    squash_merge_commit_message: z.enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"]),
    squash_merge_commit_title: z.enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"]),
  }),
  environments: z.record(
    z.string(),
    z.strictObject({
      /** The only branches that may deploy to it. */
      branches: z.array(z.string().min(1)).min(1),
      /** Whether a person must approve each run (the founder, for production). */
      requiredReviewers: z.boolean(),
      secrets: z.array(secretName).refine(sortedUnique, "sorted and unique"),
    }),
  ),
  variables: z.array(secretName).refine(sortedUnique, "sorted and unique"),
  secrets: z.array(secretName).refine(sortedUnique, "sorted and unique"),
});

// --- every file ---------------------------------------------------------------------------------

/** Every file in infra/, with the schema it must parse with. A file not named here is an error. */
export const INFRA_FILES = {
  "environments.json": EnvironmentsSchema,
  "vercel-firewall.json": FirewallSchema,
  "neon.json": NeonSchema,
  "r2/lifecycle.json": LifecycleSchema,
  "r2/cors.json": CorsSchema,
  "cloudflare/assets-headers.json": AssetsHeadersSchema,
  "posthog.json": PosthogSchema,
  "github/ruleset-main.json": RulesetSchema,
  "github/ruleset-cloud.json": RulesetSchema,
  "github/repo.json": RepoSchema,
} as const satisfies Record<string, z.ZodType>;

export type InfraFile = keyof typeof INFRA_FILES;
export type Infra = { [K in InfraFile]: z.infer<(typeof INFRA_FILES)[K]> };

/** Reads and checks one infra file; throws naming the file and the field when it is wrong. */
export function loadInfraFile<K extends InfraFile>(name: K, dir = INFRA_DIR): Infra[K] {
  return parseFile(join(dir, name), INFRA_FILES[name] as unknown as z.ZodType<Infra[K]>);
}

/** Every infra file, checked. Throws on a file infra/ has that no schema names. */
export function loadInfra(dir = INFRA_DIR): Infra {
  const known = new Set<string>(Object.keys(INFRA_FILES));
  const unknown = listJson(dir).filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`infra/ has files no schema reads: ${unknown.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(INFRA_FILES) as InfraFile[]) out[name] = loadInfraFile(name, dir);
  return out as Infra;
}

/** infra/environments.json, or another file of the same shape (a test's filled fixture). */
export function loadEnvironments(path = join(INFRA_DIR, "environments.json")): Environments {
  return parseFile(path, EnvironmentsSchema);
}

function parseFile<T>(path: string, schema: z.ZodType<T>): T {
  const result = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (result.success) return result.data;
  const where = relative(process.cwd(), path) || path;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`);
  throw new Error(`${where} is not valid:\n  ${issues.join("\n  ")}`);
}

/** Every .json under `dir`, as paths relative to it with forward slashes. */
export function listJson(dir: string, prefix = ""): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dir, rel)).isDirectory()) names.push(...listJson(dir, rel));
    else if (entry.endsWith(".json")) names.push(rel);
  }
  return names;
}

// --- command line -------------------------------------------------------------------------------

const USAGE =
  "usage: bun scripts/prod/desired.ts <status|assert-release> <dev|production> [--file <path>]";

/** Runs the command line; returns the exit code. `print` is stdout, one line a call. */
export function main(argv: string[], print: (line: string) => void = console.log): number {
  const [command, envArg, ...rest] = argv;
  const env = EnvironmentName.safeParse(envArg);
  const fileFlag = rest.indexOf("--file");
  const extra =
    fileFlag === -1 ? rest : rest.filter((_, i) => i !== fileFlag && i !== fileFlag + 1);
  if (!env.success || extra.length || (fileFlag !== -1 && !rest[fileFlag + 1])) {
    print(USAGE);
    return 2;
  }
  const file = loadEnvironments(fileFlag === -1 ? undefined : rest[fileFlag + 1]);
  if (command === "status") {
    for (const line of fieldLines(file, env.data)) {
      print(`${line.state.padEnd(7)} ${line.path}: ${line.says}`);
    }
    return 0;
  }
  if (command === "assert-release") {
    const problems = releaseProblems(file, env.data);
    if (!problems.length) {
      print(`ok      the release build talks to ${env.data}, and every field is set`);
      return 0;
    }
    for (const problem of problems) print(`fail    ${problem}`);
    return 1;
  }
  print(USAGE);
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
