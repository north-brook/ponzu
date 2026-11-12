import { createHash } from "node:crypto";
import type { SandboxLimits } from "@ponzu/db";
import current from "@ponzu/runner/image/current.json" with { type: "json" };
import type { VercelCredentials } from "@ponzu/sandbox";
import { z } from "zod";
import type { PosthogConfig } from "./analytics/posthog.ts";
import type { PosthogAdminConfig } from "./analytics/posthog-admin.ts";
import type { R2Config } from "./deps/storage.ts";
import {
  BILLING_MODES,
  type Features,
  featuresFrom,
  MAINTENANCE_MODES,
  RATE_LIMIT_MODES,
} from "./features.ts";
import { type MinimumVersions, parseMinimumVersions } from "./http/client-version.ts";

/** Where an API runs. Each has its own database, WorkOS environment, bucket and GitHub App. */
export const ENVIRONMENTS = ["production", "dev", "preview", "local"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Where a sandbox's runner reaches the API when PONZU_API_URL is unset, which only off Vercel is allowed. */
export const DEFAULT_API_URL = "https://api.ponzu.design";

/** What every Vercel deployment must set beyond the variables the API always needs. */
const REQUIRED_ON_VERCEL = ["PONZU_ENVIRONMENT", "PONZU_API_URL"] as const;

/**
 * Names Vercel sets itself on every deployment. A person never sets them, so they are in neither
 * REQUIRED_ENV nor OPTIONAL_ENV.
 */
export const SYSTEM_ENV = ["VERCEL", "VERCEL_GIT_COMMIT_SHA"] as const;

/**
 * Names that must never be set on a deployment. A token on Vercel is already refused at boot
 * (sandboxes use OIDC there); the others are leftovers of earlier plans, which the production
 * check (`scripts/prod/check.ts`) reports.
 */
export const FORBIDDEN_ENV = ["VERCEL_TOKEN", "BOAT_API_KEY", "PONZU_SANDBOX_SNAPSHOT"] as const;

/**
 * Every environment variable the API reads, and the only place it reads them. `.env.example`
 * lists the same names; a variable added here is added there.
 */
const schema = z.object({
  /** Neon's pooled connection string. */
  DATABASE_URL: z.url(),
  WORKOS_API_KEY: z.string(),
  WORKOS_CLIENT_ID: z.string(),
  GITHUB_APP_CLIENT_ID: z.string(),
  GITHUB_APP_CLIENT_SECRET: z.string(),
  /** The App's private key, as the PEM GitHub gave: many lines, stored as they are. */
  GITHUB_APP_PRIVATE_KEY: z.string().includes("PRIVATE KEY-----"),
  /** The App's slug, from its public page `github.com/apps/<slug>`: where installs begin. */
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/),
  /** What GitHub signs each webhook delivery with (the App's webhook secret). */
  GITHUB_WEBHOOK_SECRET: z.string().min(32),
  /** The GitHub user id of the App's bot, `<slug>[bot]`: who commits are committed by. */
  GITHUB_APP_BOT_USER_ID: z.coerce.number().int().positive(),
  /** What Vercel's cron sends as its bearer token: the only way into `/v1/cron`. */
  CRON_SECRET: z.string().min(32),
  /**
   * Vercel Sandbox, off Vercel (a laptop, a script, CI): a token scoped to the team and the
   * ponzu-api project, with their ids. All three or none. On Vercel (`VERCEL=1`) the API uses
   * the function's OIDC token instead, and a VERCEL_TOKEN there is refused.
   */
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  /** Set to "1" by Vercel on every deployment. */
  VERCEL: z.string().optional(),
  /**
   * Which environment this deployment is: production, dev, preview or local. Required on Vercel
   * (`VERCEL=1`), so a deployment always says which one it is; `local` when unset off Vercel.
   * `/v1/health` reports it.
   */
  PONZU_ENVIRONMENT: z.enum(ENVIRONMENTS).optional(),
  /**
   * Where a sandbox's runner reaches this API. Required on Vercel: a default there would be
   * production's address, and a dev deployment's runners would call production. Off Vercel it is
   * `DEFAULT_API_URL` when unset.
   */
  PONZU_API_URL: z.url().optional(),
  /** How long a sandbox stays awake after the last activity, in seconds. */
  PONZU_SANDBOX_IDLE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** How many sandboxes may be waking or awake at once in one workspace, and for one owner. */
  PONZU_SANDBOX_MAX_PER_WORKSPACE: z.coerce.number().int().min(1).default(5),
  PONZU_SANDBOX_MAX_PER_OWNER: z.coerce.number().int().min(1).default(3),
  /** The key stored secrets are sealed with: 32 random bytes in base64url. */
  PONZU_VAULT_KEY: z.string(),
  /** Neon Realtime for the database's branch: where clients subscribe, and what seals queries. */
  NEON_REALTIME_URL: z.url(),
  NEON_REALTIME_SECRET: z.string(),
  /** Where canvases' files are served from, without a trailing slash: `https://assets.ponzu.cloud`. */
  PONZU_ASSETS_URL: z.url(),
  /** The Cloudflare R2 bucket behind PONZU_ASSETS_URL, and an API token that can write it. */
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  R2_ACCESS_KEY_ID: z.string(),
  R2_SECRET_ACCESS_KEY: z.string(),
  R2_BUCKET: z.string(),
  /**
   * A bucket on the same account with no public domain, for checkpoint archives (transcripts,
   * work in progress). Unset: they go in R2_BUCKET under a random key (docs/cloud.md).
   */
  R2_PRIVATE_BUCKET: z.string().optional(),
  /** Ponzu's own Anthropic API key, for what the API asks a model itself (repo ideas). */
  PONZU_ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),
  /** Keys that were PONZU_VAULT_KEY before, comma-separated, so what they sealed still opens. */
  PONZU_VAULT_OLD_KEYS: z.string().optional(),
  /** The oldest client each platform may run, like `macos=2.1.0,ios=1.3.0`. Unset: no gate. */
  PONZU_MIN_CLIENT_VERSIONS: z.string().optional(),
  /** Set by Vercel when a deployment is made from a git checkout. */
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  /**
   * The PostHog project this environment reports to: its project token, which is public.
   * Unset, the API captures nothing and loads nothing for it (docs/analytics.md).
   */
  PONZU_POSTHOG_KEY: z
    .string()
    .regex(/^phc_\w+$/)
    .optional(),
  /** Where PostHog takes events. */
  PONZU_POSTHOG_HOST: z.url().default("https://us.i.posthog.com"),
  /** "1": model calls and agent turns are traced with their prompts and answers. Off otherwise. */
  PONZU_POSTHOG_AI_CONTENT: z.enum(["0", "1"]).default("0"),

  // Account deletion: forgetting a deleted person at PostHog (analytics/posthog-admin.ts).
  /**
   * A PostHog personal API key with `person:write`, scoped to the project: a secret. Set with
   * PONZU_POSTHOG_PROJECT_ID or not at all. Unset, deleting an account leaves PostHog alone.
   */
  PONZU_POSTHOG_PERSONAL_API_KEY: z.string().min(16).optional(),
  /** The numeric id of the PostHog project the key may delete people in. */
  PONZU_POSTHOG_PROJECT_ID: z.string().regex(/^\d+$/).optional(),
  /** PostHog's app host, where its private API is: not the ingestion host. */
  PONZU_POSTHOG_API_HOST: z.url().default("https://us.posthog.com"),

  // Notifications: pings to phones (deps/push.ts).
  /**
   * An access token for Ponzu's Expo project, which has Enhanced Security for push turned on.
   * Unset, push is off: nothing is sent to a phone, and the Mac and the inbox work regardless.
   */
  EXPO_ACCESS_TOKEN: z.string().min(20).optional(),

  // Notifications: the email digest (deps/mail.ts, when it is built).
  /** Resend's API key. Unset, email is off: no digest is sent and Settings hides its row. */
  RESEND_API_KEY: z.string().min(1).optional(),

  // Feature switches (features.ts). Each is off when unset.
  /** off, observe (the gate is computed and what it would refuse is logged), or on. */
  PONZU_BILLING: z.enum(BILLING_MODES).default("off"),
  /** "1": repo bases are built, and canvases wake from them. */
  PONZU_REPO_BASES: z.enum(["0", "1"]).default("0"),
  /** "1": Merge adds a pull request to its repo's merge queue instead of refusing. */
  PONZU_MERGE_QUEUE: z.enum(["0", "1"]).default("0"),
  /**
   * off, or "vercel": per-caller limits through Vercel's firewall (deps/rate-limit.ts), which
   * only a deployment on Vercel (`VERCEL=1`) can ask. Turn it on only once the firewall's
   * rate-limit rules are applied: a check whose rule is missing lets the request through,
   * logged as `rate_limit_unavailable`.
   */
  PONZU_RATE_LIMITS: z.enum(RATE_LIMIT_MODES).default("off"),
  /** The incident switch: off, wakes_paused (nothing wakes), or read_only (nothing writes). */
  PONZU_MAINTENANCE: z.enum(MAINTENANCE_MODES).default("off"),
});

type Name = keyof typeof schema.shape;
const NAMES = Object.keys(schema.shape) as Name[];
const unsetIsFine = (name: Name) => schema.shape[name].safeParse(undefined).success;
const system = new Set<string>(SYSTEM_ENV);
const forbidden = new Set<string>(FORBIDDEN_ENV);
const requiredOnVercel = new Set<string>(REQUIRED_ON_VERCEL);

/**
 * Every name a Vercel deployment must set: what the API always needs, plus PONZU_ENVIRONMENT
 * and PONZU_API_URL. The production check compares a project's Production target with this.
 */
export const REQUIRED_ENV: readonly string[] = NAMES.filter(
  (name) => !unsetIsFine(name) || requiredOnVercel.has(name),
);

/**
 * Every other name a deployment may set: each has a default or turns its feature off when
 * unset. Vercel's own names and the forbidden ones are not here.
 */
export const OPTIONAL_ENV: readonly string[] = NAMES.filter(
  (name) =>
    unsetIsFine(name) && !requiredOnVercel.has(name) && !system.has(name) && !forbidden.has(name),
);

/** How canvases' sandboxes are made and kept. */
export interface SandboxConfig {
  /**
   * The image every sandbox runs: `ponzu-runner@sha256:…` in the ponzu-api project's container
   * registry, from apps/runner/image/current.json at build time, so an image ships with the API.
   */
  image: string;
  /** The API's own address as a sandbox reaches it, with no trailing slash. */
  apiUrl: string;
  /** How long a sandbox stays awake after the last activity. */
  idleSeconds: number;
  /** How many may be up at once. Until billing exists, this is what bounds the provider's bill. */
  limits: SandboxLimits;
  /**
   * What this database's sandbox names begin with after `pz-` (`pz-<scope>-…`). Every
   * deployment shares the Vercel project, and reconcile looks only at its own database's names,
   * so it never takes another database's sandboxes for orphans.
   */
  scope: string;
  /** The token triple off Vercel; null for OIDC (on Vercel). */
  vercel: VercelCredentials | null;
}

/**
 * The database a connection string reaches, as a short hash: the same for every deployment on
 * one database, whichever of Neon's hosts for it they connect through.
 */
export function sandboxScope(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const host = url.hostname.replace("-pooler.", ".");
  return createHash("sha256").update(`${host}${url.pathname}`).digest("hex").slice(0, 12);
}

/** The environment was read and something the API needs is missing or malformed. */
export class EnvError extends Error {
  constructor(problems: string[]) {
    super(`The API cannot start. ${problems.join(" ")}`);
    this.name = "EnvError";
  }
}

export interface Env {
  databaseUrl: string;
  workos: { apiKey: string; clientId: string };
  githubApp: {
    clientId: string;
    clientSecret: string;
    privateKey: string;
    slug: string;
    webhookSecret: string;
    botUserId: number;
  };
  cronSecret: string;
  sandbox: SandboxConfig;
  vault: { key: string; oldKeys: string[] };
  realtime: { url: string; secret: string };
  assetsUrl: string;
  r2: R2Config;
  r2PrivateBucket: string | null;
  anthropicApiKey: string;
  minimumClientVersions: MinimumVersions;
  /** Which environment this is (PONZU_ENVIRONMENT): `local` off Vercel when unset. */
  environment: Environment;
  commit: string | null;
  /** PostHog, or null when PONZU_POSTHOG_KEY is unset and analytics is off. */
  posthog: PosthogConfig | null;
  /**
   * PostHog's private API, for forgetting a deleted person, or null when its personal key and
   * project id are unset.
   */
  posthogAdmin: PosthogAdminConfig | null;
  /** Pings to phones through Expo, or null when EXPO_ACCESS_TOKEN is unset and push is off. */
  push: { accessToken: string } | null;
  /** Which features are switched on (features.ts): all off unless their variables say so. */
  features: Features;
  /** Whether this runs as a Vercel deployment (`VERCEL=1`): only there can rate limits be asked. */
  onVercel: boolean;
}

/**
 * Reads and checks the environment once. It throws an `EnvError` that names every variable
 * that is missing or malformed, and never quotes a value.
 */
export function readEnv(source: Record<string, string | undefined>): Env {
  // An empty value is how a dashboard or a shell says "unset".
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(set);
  // On Vercel these two have no fallback: a deployment that does not say where it is and where
  // its runners reach it never starts, rather than guessing production's address.
  const missingOnVercel =
    set.VERCEL === "1" ? REQUIRED_ON_VERCEL.filter((name) => set[name] === undefined) : [];
  if (!parsed.success || missingOnVercel.length > 0) {
    const names = [
      ...new Set([
        ...(parsed.error?.issues.map((issue) => String(issue.path[0])) ?? []),
        ...missingOnVercel,
      ]),
    ];
    throw new EnvError(
      names.map((name) => `${name} is ${set[name] === undefined ? "not set" : "malformed"}.`),
    );
  }
  const env = parsed.data;
  // `local` is a computer's: a deployment that calls itself local would be read as one by
  // everything that reports or checks the environment.
  if (env.VERCEL === "1" && env.PONZU_ENVIRONMENT === "local") {
    throw new EnvError([
      "PONZU_ENVIRONMENT is local on Vercel, where it must be production, dev or preview.",
    ]);
  }
  const vercel = vercelCredentials(env);

  let minimumClientVersions: MinimumVersions;
  try {
    minimumClientVersions = parseMinimumVersions(env.PONZU_MIN_CLIENT_VERSIONS ?? "");
  } catch {
    throw new EnvError(["PONZU_MIN_CLIENT_VERSIONS is malformed."]);
  }

  return {
    databaseUrl: env.DATABASE_URL,
    workos: { apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID },
    githubApp: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      slug: env.GITHUB_APP_SLUG,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      botUserId: env.GITHUB_APP_BOT_USER_ID,
    },
    cronSecret: env.CRON_SECRET,
    sandbox: {
      image: current.image,
      apiUrl: (env.PONZU_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
      idleSeconds: env.PONZU_SANDBOX_IDLE_SECONDS,
      limits: {
        perWorkspace: env.PONZU_SANDBOX_MAX_PER_WORKSPACE,
        perOwner: env.PONZU_SANDBOX_MAX_PER_OWNER,
      },
      scope: sandboxScope(env.DATABASE_URL),
      vercel,
    },
    vault: {
      key: env.PONZU_VAULT_KEY,
      oldKeys: env.PONZU_VAULT_OLD_KEYS?.split(",").filter(Boolean) ?? [],
    },
    realtime: { url: env.NEON_REALTIME_URL, secret: env.NEON_REALTIME_SECRET },
    assetsUrl: env.PONZU_ASSETS_URL.replace(/\/+$/, ""),
    r2: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
    },
    r2PrivateBucket: env.R2_PRIVATE_BUCKET || null,
    anthropicApiKey: env.PONZU_ANTHROPIC_API_KEY,
    minimumClientVersions,
    environment: env.PONZU_ENVIRONMENT ?? "local",
    commit: env.VERCEL_GIT_COMMIT_SHA ?? null,
    posthog: env.PONZU_POSTHOG_KEY
      ? {
          key: env.PONZU_POSTHOG_KEY,
          host: env.PONZU_POSTHOG_HOST.replace(/\/+$/, ""),
          aiContent: env.PONZU_POSTHOG_AI_CONTENT === "1",
        }
      : null,
    posthogAdmin: posthogAdmin(env),
    push: env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : null,
    features: featuresFrom(env),
    onVercel: env.VERCEL === "1",
  };
}

/** PostHog's private API: its personal key and project id together, or neither. */
function posthogAdmin(env: z.infer<typeof schema>): PosthogAdminConfig | null {
  const key = env.PONZU_POSTHOG_PERSONAL_API_KEY;
  const projectId = env.PONZU_POSTHOG_PROJECT_ID;
  if (key === undefined && projectId === undefined) return null;
  if (key === undefined || projectId === undefined) {
    throw new EnvError([
      "PONZU_POSTHOG_PERSONAL_API_KEY and PONZU_POSTHOG_PROJECT_ID are both set or neither.",
    ]);
  }
  return {
    personalApiKey: key,
    projectId,
    host: env.PONZU_POSTHOG_API_HOST.replace(/\/+$/, ""),
  };
}

/**
 * The Vercel token triple, or null for OIDC. All three or none, and none on Vercel itself: a
 * deployment's sandboxes run on the function's own token, which nothing can leak.
 */
function vercelCredentials(env: z.infer<typeof schema>): VercelCredentials | null {
  const given = [env.VERCEL_TOKEN, env.VERCEL_TEAM_ID, env.VERCEL_PROJECT_ID];
  if (env.VERCEL === "1") {
    // Vercel sets project and team ids of its own on a deployment; only a token is a mistake.
    if (env.VERCEL_TOKEN) {
      throw new EnvError(["VERCEL_TOKEN is set on Vercel, where sandboxes use OIDC: remove it."]);
    }
    return null;
  }
  if (given.every((value) => value === undefined)) return null;
  if (given.some((value) => value === undefined)) {
    throw new EnvError([
      "VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are all set or none of them.",
    ]);
  }
  return {
    token: env.VERCEL_TOKEN!,
    teamId: env.VERCEL_TEAM_ID!,
    projectId: env.VERCEL_PROJECT_ID!,
  };
}
