import { createDb, type Db } from "@ponzu/db";
import { type RunnerBundle, runnerBundle } from "@ponzu/runner/bundle";
import { type Clock, type Sandboxes, systemClock, vercelSandboxes } from "@ponzu/sandbox";
import manifest from "../../package.json" with { type: "json" };
import { type Analytics, noAnalytics } from "../analytics/analytics.ts";
import { createPosthogAnalytics, type PosthogConfig } from "../analytics/posthog.ts";
import { createPosthogAdmin, type PosthogAdmin } from "../analytics/posthog-admin.ts";
import { DocCache } from "../canvases/doc-cache.ts";
import type { Env, Environment, SandboxConfig } from "../env.ts";
import type { Features } from "../features.ts";
import type { MinimumVersions } from "../http/client-version.ts";
import { consoleSink, createLogger, type Logger } from "../http/log.ts";
import { GitTokens } from "../runner/git-credential.ts";
import { createVault, type Vault } from "../vault/vault.ts";
import { type Anthropic, createAnthropic } from "./anthropic.ts";
import { type Background, createBackground, waitUntil } from "./background.ts";
import type { Fetch } from "./fetch.ts";
import { createGithub, type Github } from "./github.ts";
import { createResendMail, type Mail, noMail } from "./mail.ts";
import { CLAUDE_SONNET, createClaude, type Model } from "./model.ts";
import { createPoke, type Poke } from "./poke.ts";
import { createExpoPush, noPush, type Push } from "./push.ts";
import { type RateLimit, selectRateLimit } from "./rate-limit.ts";
import { createRealtimeSealer, type RealtimeSealer } from "./realtime.ts";
import { createR2Storage, type ObjectStorage } from "./storage.ts";
import { createWorkos, type Workos } from "./workos.ts";

/**
 * Everything the API reaches outside its own code. It is made once, here, and handed down:
 * a handler reads `c.var.deps`, and a function below a handler takes the parts it uses as an
 * argument. Nothing imports a client, a clock or the database as a module-level value, which
 * is what lets `createTestApp` run the whole app on fakes.
 */
export interface Deps {
  /**
   * Neon over HTTP: one statement per call and no transactions (`db.transaction` throws, in
   * tests too). Every statement has `DATABASE_TIMEOUT_MS` to answer.
   */
  db: Db;
  clock: Clock;
  ids: Ids;
  log: Logger;
  background: Background;
  vault: Vault;
  workos: Workos;
  github: Github;
  /**
   * Vercel Sandbox (packages/sandbox). Only `up()` resumes; every other call is pinned to a
   * session. With OIDC it may be called only inside a request, or in work kept by one.
   */
  sandboxes: Sandboxes;
  /** The runner bundle this build serves and names at every start (`@ponzu/runner/bundle`). */
  runnerBundle: () => RunnerBundle;
  /** Checks a person's Anthropic API key. */
  anthropic: Anthropic;
  /** Cloudflare R2: the bytes of canvases' files, previews and exports. */
  storage: ObjectStorage;
  /**
   * Where a checkpoint's archives (a session's transcript, work in progress) are kept: a bucket
   * with no public domain when `R2_PRIVATE_BUCKET` is set, else `storage` under a random key
   * (docs/cloud.md, "Saving the sandbox").
   */
  archives: ObjectStorage;
  /** Tells an awake runner there may be events to claim. */
  poke: Poke;
  realtime: RealtimeSealer;
  /** Claude Haiku, through the AI SDK on Ponzu's own key, for what the API asks itself (repo ideas). */
  model: Model;
  /**
   * Claude Sonnet, the same way on the same key: it reviews what `model` wrote before a person
   * sees it (the ideas gate, `ideas/gate.ts`).
   */
  reviewer: Model;
  /** The canvas documents this instance has built lately. */
  docs: DocCache;
  /** The git tokens this instance hands runners, kept while they may be reused. */
  gitTokens: GitTokens;
  /** PostHog: product events, error tracking and model-call traces. A no-op without a key. */
  analytics: Analytics;
  /**
   * PostHog's private API, which forgets a deleted person (analytics/posthog-admin.ts). Null
   * without PONZU_POSTHOG_PERSONAL_API_KEY and PONZU_POSTHOG_PROJECT_ID: deleting an account
   * then leaves PostHog alone, logged as `analytics_forget_skipped`.
   */
  posthogAdmin: PosthogAdmin | null;
  /** Pings to phones through Expo (deps/push.ts). Off, as `noPush`, without EXPO_ACCESS_TOKEN. */
  push: Push;
  /** The daily email through Resend (deps/mail.ts). Off, as `noMail`, without RESEND_API_KEY. */
  mail: Mail;
  /**
   * Per-caller rate limits through Vercel's firewall (deps/rate-limit.ts, http/rate-limits.ts).
   * Off, as `noRateLimit`, unless PONZU_RATE_LIMITS is `vercel` on Vercel; fails open.
   */
  rateLimit: RateLimit;
  /** Which features are switched on (features.ts), read from the environment once, in env.ts. */
  features: Features;
  config: Config;
}

/** Settings a route may need, already read from the environment. */
export interface Config {
  /** What `/v1/health` reports about this build, and which environment it runs in. */
  build: { version: string; commit: string | null; environment: Environment };
  minimumClientVersions: MinimumVersions;
  /** Where canvases' files are served from; a canvas's are under `<assetsUrl>/<asset key>/`. */
  assetsUrl: string;
  /** What a canvas's runner reports its turns to PostHog with, or null when analytics is off. */
  posthog: PosthogConfig | null;
  /**
   * The GitHub App's slug, where installs begin, the secret its webhooks are signed with, and
   * the user id of its bot, who commits are committed by.
   */
  githubApp: { slug: string; webhookSecret: string; botUserId: number };
  /** What the scheduler's requests carry (`routes/cron.ts`). */
  cronSecret: string;
  /** How canvases' sandboxes are made and kept. */
  sandbox: SandboxConfig;
}

/** Ids the API makes itself. Rows get theirs from `@ponzu/db`. */
export interface Ids {
  requestId(): string;
}

export const randomIds: Ids = {
  requestId: () => `req_${crypto.randomUUID().replaceAll("-", "")}`,
};

/** The API's own version: what Release Please last wrote to its manifest. */
export const VERSION = manifest.version;

/**
 * How long the database has to answer one statement, the same as WorkOS and GitHub get. A
 * statement that runs out fails as 503 `database_unavailable`. Without this the wait is
 * Node's own, five minutes, which is also as long as the function may run.
 */
export const DATABASE_TIMEOUT_MS = 10_000;

/** The real thing, for a deployment or `bun run dev`. */
export function createDeps(env: Env): Deps {
  const clock = systemClock;
  const outbound: Fetch = (url, init) => fetch(url, init);
  const log = createLogger(consoleSink);
  const storage = createR2Storage({ ...env.r2, fetch: outbound, clock });
  const analytics = createPosthogAnalytics(env.posthog, { keep: waitUntil, log }) ?? noAnalytics;
  return {
    db: createDb(env.databaseUrl, { deadline: () => clock.timeout(DATABASE_TIMEOUT_MS) }),
    clock,
    ids: randomIds,
    log,
    analytics,
    background: createBackground(log, waitUntil, (name, error) =>
      analytics.exception(error, { background: name }),
    ),
    vault: createVault(env.vault),
    workos: createWorkos({ ...env.workos, fetch: outbound, clock }),
    github: createGithub({
      clientId: env.githubApp.clientId,
      clientSecret: env.githubApp.clientSecret,
      privateKey: env.githubApp.privateKey,
      fetch: outbound,
      clock,
    }),
    // Makes no call yet: under OIDC the first one must come from inside a request.
    sandboxes: vercelSandboxes({
      clock,
      ...(env.sandbox.vercel ? { credentials: env.sandbox.vercel } : {}),
    }),
    runnerBundle,
    anthropic: createAnthropic({ fetch: outbound, clock, ownKey: env.anthropicApiKey }),
    storage,
    archives: env.r2PrivateBucket
      ? createR2Storage({ ...env.r2, bucket: env.r2PrivateBucket, fetch: outbound, clock })
      : storage,
    poke: createPoke({ fetch: outbound, clock }),
    realtime: createRealtimeSealer({
      ...env.realtime,
      database: new URL(env.databaseUrl).pathname.slice(1),
    }),
    model: createClaude({ apiKey: env.anthropicApiKey, fetch: outbound, tracing: analytics.ai }),
    reviewer: createClaude({
      apiKey: env.anthropicApiKey,
      fetch: outbound,
      model: CLAUDE_SONNET,
      tracing: analytics.ai,
    }),
    docs: new DocCache(),
    gitTokens: new GitTokens(),
    posthogAdmin: env.posthogAdmin
      ? createPosthogAdmin({ config: env.posthogAdmin, fetch: outbound, clock })
      : null,
    push: env.push ? createExpoPush({ accessToken: env.push.accessToken, clock, log }) : noPush,
    mail: env.mail ? createResendMail({ ...env.mail, clock, log }) : noMail,
    rateLimit: selectRateLimit(
      { mode: env.features.rateLimits, onVercel: env.onVercel },
      { clock, log },
    ),
    features: env.features,
    config: {
      build: { version: VERSION, commit: env.commit, environment: env.environment },
      minimumClientVersions: env.minimumClientVersions,
      assetsUrl: env.assetsUrl,
      posthog: env.posthog,
      githubApp: {
        slug: env.githubApp.slug,
        webhookSecret: env.githubApp.webhookSecret,
        botUserId: env.githubApp.botUserId,
      },
      cronSecret: env.cronSecret,
      sandbox: env.sandbox,
    },
  };
}
