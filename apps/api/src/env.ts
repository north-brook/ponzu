import { createHash } from "node:crypto";
import type { SandboxLimits } from "@ponzu/db";
import { z } from "zod";
import type { PosthogConfig } from "./analytics/posthog.ts";
import type { R2Config } from "./deps/storage.ts";
import { type MinimumVersions, parseMinimumVersions } from "./http/client-version.ts";

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
  BOAT_API_KEY: z.string(),
  /**
   * The sandbox image every design's sandbox is created from: the name a bake of
   * apps/runner/image prints. Unset, a wake fails saying so and nothing else is affected.
   */
  PONZU_SANDBOX_SNAPSHOT: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  /** Where a sandbox's runner reaches this API. */
  PONZU_API_URL: z.url().default("https://api.ponzu.design"),
  /** How long a sandbox stays awake after the last activity, in seconds. */
  PONZU_SANDBOX_IDLE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** How many sandboxes may be waking or awake at once in one workspace, and for one owner. */
  PONZU_SANDBOX_MAX_PER_WORKSPACE: z.coerce.number().int().min(1).default(5),
  PONZU_SANDBOX_MAX_PER_OWNER: z.coerce.number().int().min(1).default(3),
  /**
   * How many designs may be moving onto a new image at once, across the deployment: each move
   * is a create, a start the provider rations. A wake past it wakes the old sandbox instead.
   */
  PONZU_SANDBOX_MAX_MOVES: z.coerce.number().int().min(0).default(3),
  /** The key stored secrets are sealed with: 32 random bytes in base64url. */
  PONZU_VAULT_KEY: z.string(),
  /** Neon Realtime for the database's branch: where clients subscribe, and what seals queries. */
  NEON_REALTIME_URL: z.url(),
  NEON_REALTIME_SECRET: z.string(),
  /** Where design files are served from, without a trailing slash: `https://assets.ponzu.cloud`. */
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
});

/** How designs' sandboxes are made and kept. */
export interface SandboxConfig {
  /** The snapshot a sandbox is created from; null when PONZU_SANDBOX_SNAPSHOT is unset. */
  snapshot: string | null;
  /** The API's own address as a sandbox reaches it, with no trailing slash. */
  apiUrl: string;
  /** How long a sandbox stays awake after the last activity. */
  idleSeconds: number;
  /** How many may be up at once. Until billing exists, this is what bounds the provider's bill. */
  limits: SandboxLimits;
  /**
   * How many designs may be moving onto a new image at once (docs/cloud.md, "How images roll
   * out"). 0 turns moving off: every design stays on the image its sandbox was made from.
   */
  maxMoves: number;
  /**
   * The label value that marks this database's sandboxes at the provider (`scope`). Every
   * deployment shares the provider account, and a sweep destroys only what its own database
   * should know of, so it must never take another database's sandboxes for orphans.
   */
  scope: string;
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
  boatApiKey: string;
  sandbox: SandboxConfig;
  vault: { key: string; oldKeys: string[] };
  realtime: { url: string; secret: string };
  assetsUrl: string;
  r2: R2Config;
  r2PrivateBucket: string | null;
  anthropicApiKey: string;
  minimumClientVersions: MinimumVersions;
  commit: string | null;
  /** PostHog, or null when PONZU_POSTHOG_KEY is unset and analytics is off. */
  posthog: PosthogConfig | null;
}

/**
 * Reads and checks the environment once. It throws an `EnvError` that names every variable
 * that is missing or malformed, and never quotes a value.
 */
export function readEnv(source: Record<string, string | undefined>): Env {
  // An empty value is how a dashboard or a shell says "unset".
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(set);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvError(
      names.map((name) => `${name} is ${set[name] === undefined ? "not set" : "malformed"}.`),
    );
  }
  const env = parsed.data;

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
    boatApiKey: env.BOAT_API_KEY,
    sandbox: {
      snapshot: env.PONZU_SANDBOX_SNAPSHOT ?? null,
      apiUrl: env.PONZU_API_URL.replace(/\/+$/, ""),
      idleSeconds: env.PONZU_SANDBOX_IDLE_SECONDS,
      limits: {
        perWorkspace: env.PONZU_SANDBOX_MAX_PER_WORKSPACE,
        perOwner: env.PONZU_SANDBOX_MAX_PER_OWNER,
      },
      maxMoves: env.PONZU_SANDBOX_MAX_MOVES,
      scope: sandboxScope(env.DATABASE_URL),
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
    commit: env.VERCEL_GIT_COMMIT_SHA ?? null,
    posthog: env.PONZU_POSTHOG_KEY
      ? {
          key: env.PONZU_POSTHOG_KEY,
          host: env.PONZU_POSTHOG_HOST.replace(/\/+$/, ""),
          aiContent: env.PONZU_POSTHOG_AI_CONTENT === "1",
        }
      : null,
  };
}
