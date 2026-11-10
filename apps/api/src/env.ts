import { z } from "zod";
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
  /** What Vercel's cron sends as its bearer token: the only way into `/v1/cron`. */
  CRON_SECRET: z.string().min(32),
  BOAT_API_KEY: z.string(),
  /** The key stored secrets are sealed with: 32 random bytes in base64url. */
  PONZU_VAULT_KEY: z.string(),
  /** Keys that were PONZU_VAULT_KEY before, comma-separated, so what they sealed still opens. */
  PONZU_VAULT_OLD_KEYS: z.string().optional(),
  /** The oldest client each platform may run, like `macos=2.1.0,ios=1.3.0`. Unset: no gate. */
  PONZU_MIN_CLIENT_VERSIONS: z.string().optional(),
  /** Set by Vercel when a deployment is made from a git checkout. */
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

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
  };
  cronSecret: string;
  boatApiKey: string;
  vault: { key: string; oldKeys: string[] };
  minimumClientVersions: MinimumVersions;
  commit: string | null;
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
    },
    cronSecret: env.CRON_SECRET,
    boatApiKey: env.BOAT_API_KEY,
    vault: {
      key: env.PONZU_VAULT_KEY,
      oldKeys: env.PONZU_VAULT_OLD_KEYS?.split(",").filter(Boolean) ?? [],
    },
    minimumClientVersions,
    commit: env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}
