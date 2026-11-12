import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import current from "@ponzu/runner/image/current.json" with { type: "json" };
import { EnvError, readEnv, sandboxScope } from "./env.ts";

const complete = {
  DATABASE_URL: "postgres://user:hunter2@ep-example-pooler.us-east-1.aws.neon.tech/neondb",
  WORKOS_API_KEY: "sk_test_example",
  WORKOS_CLIENT_ID: "client_example",
  GITHUB_APP_CLIENT_ID: "Iv23example",
  GITHUB_APP_CLIENT_SECRET: "github-secret",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
  GITHUB_APP_SLUG: "ponzu-dev",
  GITHUB_WEBHOOK_SECRET: "a-webhook-secret-of-at-least-32-characters",
  CRON_SECRET: "a-cron-secret-of-at-least-32-characters",
  PONZU_VAULT_KEY: "vault-key",
  NEON_REALTIME_URL: "https://ep-example.rt.c-1.us-east-1.aws.neon.tech/",
  NEON_REALTIME_SECRET: "nrt_live_1example",
  PONZU_ASSETS_URL: "https://assets.example/",
  GITHUB_APP_BOT_USER_ID: "354938669",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "r2-key-id",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_BUCKET: "ponzu-test",
  PONZU_ANTHROPIC_API_KEY: "sk-ant-example",
};

test("a complete environment is read into one typed value", () => {
  expect(readEnv({ ...complete, UNRELATED: "ignored" })).toEqual({
    databaseUrl: complete.DATABASE_URL,
    workos: { apiKey: "sk_test_example", clientId: "client_example" },
    githubApp: {
      clientId: "Iv23example",
      clientSecret: "github-secret",
      privateKey: complete.GITHUB_APP_PRIVATE_KEY,
      slug: "ponzu-dev",
      webhookSecret: complete.GITHUB_WEBHOOK_SECRET,
      botUserId: 354938669,
    },
    cronSecret: complete.CRON_SECRET,
    // The image is the one this build ships; without the Vercel triple, sandboxes use OIDC.
    sandbox: {
      image: current.image,
      apiUrl: "https://api.ponzu.design",
      idleSeconds: 300,
      limits: { perWorkspace: 5, perOwner: 3 },
      scope: sandboxScope(complete.DATABASE_URL),
      vercel: null,
    },
    vault: { key: "vault-key", oldKeys: [] },
    realtime: { url: complete.NEON_REALTIME_URL, secret: "nrt_live_1example" },
    // Without its trailing slash, so a path can follow it.
    assetsUrl: "https://assets.example",
    r2: {
      accountId: complete.R2_ACCOUNT_ID,
      accessKeyId: "r2-key-id",
      secretAccessKey: "r2-secret",
      bucket: "ponzu-test",
    },
    // Unset, checkpoint archives go in the assets bucket under a random key.
    r2PrivateBucket: null,
    anthropicApiKey: "sk-ant-example",
    minimumClientVersions: {},
    commit: null,
    // Without a PostHog key, analytics is off.
    posthog: null,
    // Without an Expo access token, push is off.
    push: null,
  });
});

test("an Expo access token switches push on, and a malformed one is named and never quoted", () => {
  const token = "expo-token-for-a-test-0123456789";
  expect(readEnv({ ...complete, EXPO_ACCESS_TOKEN: token }).push).toEqual({ accessToken: token });
  // Empty is how a dashboard says unset: push stays off, and the API still starts.
  expect(readEnv({ ...complete, EXPO_ACCESS_TOKEN: "" }).push).toBeNull();
  const short = "too-short-secret";
  let message = "";
  try {
    readEnv({ ...complete, EXPO_ACCESS_TOKEN: short });
  } catch (thrown) {
    message = (thrown as Error).message;
  }
  expect(message).toBe("The API cannot start. EXPO_ACCESS_TOKEN is malformed.");
  expect(message).not.toContain(short);
});

test("a PostHog key switches analytics on, with prompts and answers off unless asked for", () => {
  expect(readEnv({ ...complete, PONZU_POSTHOG_KEY: "phc_dev123" }).posthog).toEqual({
    key: "phc_dev123",
    host: "https://us.i.posthog.com",
    aiContent: false,
  });
  expect(
    readEnv({
      ...complete,
      PONZU_POSTHOG_KEY: "phc_dev123",
      PONZU_POSTHOG_HOST: "https://eu.i.posthog.com/",
      PONZU_POSTHOG_AI_CONTENT: "1",
    }).posthog,
  ).toEqual({ key: "phc_dev123", host: "https://eu.i.posthog.com", aiContent: true });
  // A personal API key (`phx_…`) is a secret and is not what goes here.
  expect(() => readEnv({ ...complete, PONZU_POSTHOG_KEY: "phx_secret" })).toThrow(
    "PONZU_POSTHOG_KEY is malformed.",
  );
});

test("the optional ones are read when set", () => {
  const env = readEnv({
    ...complete,
    PONZU_VAULT_OLD_KEYS: "older,oldest",
    PONZU_MIN_CLIENT_VERSIONS: "macos=2.1.0",
    VERCEL_GIT_COMMIT_SHA: "abc1234",
    VERCEL_TOKEN: "vercel-token",
    VERCEL_TEAM_ID: "team_example",
    VERCEL_PROJECT_ID: "prj_example",
    PONZU_API_URL: "https://ponzu-dev.example/",
    PONZU_SANDBOX_IDLE_SECONDS: "60",
    PONZU_SANDBOX_MAX_PER_WORKSPACE: "20",
    PONZU_SANDBOX_MAX_PER_OWNER: "4",
  });
  expect(env.sandbox).toEqual({
    image: current.image,
    apiUrl: "https://ponzu-dev.example",
    idleSeconds: 60,
    limits: { perWorkspace: 20, perOwner: 4 },
    scope: sandboxScope(complete.DATABASE_URL),
    vercel: { token: "vercel-token", teamId: "team_example", projectId: "prj_example" },
  });
  expect(env.vault.oldKeys).toEqual(["older", "oldest"]);
  expect(env.minimumClientVersions).toEqual({ macos: "2.1.0" });
  expect(env.commit).toBe("abc1234");
});

test("the Vercel triple is all or nothing, and never a token on Vercel itself", () => {
  const triple = { VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team_x", VERCEL_PROJECT_ID: "prj_x" };
  expect(() => readEnv({ ...complete, VERCEL_TOKEN: "t" })).toThrow(
    "VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are all set or none of them.",
  );
  expect(() => readEnv({ ...complete, ...triple, VERCEL_TEAM_ID: "" })).toThrow(EnvError);
  expect(() => readEnv({ ...complete, ...triple, VERCEL: "1" })).toThrow(
    "VERCEL_TOKEN is set on Vercel",
  );
  // A deployment's own ids, without a token: OIDC.
  const deployed = readEnv({
    ...complete,
    VERCEL: "1",
    VERCEL_TEAM_ID: "team_x",
    VERCEL_PROJECT_ID: "prj_x",
  });
  expect(deployed.sandbox.vercel).toBeNull();
});

test("a sandbox's scope is the database's, through whichever of its hosts", () => {
  const pooled = "postgres://user:hunter2@ep-example-pooler.us-east-1.aws.neon.tech/neondb";
  const direct = "postgres://other:secret@ep-example.us-east-1.aws.neon.tech/neondb";
  expect(sandboxScope(pooled)).toMatch(/^[0-9a-f]{12}$/);
  expect(sandboxScope(direct)).toBe(sandboxScope(pooled));
  expect(sandboxScope("postgres://user:pw@ep-other.us-east-1.aws.neon.tech/neondb")).not.toBe(
    sandboxScope(pooled),
  );
  expect(sandboxScope(pooled.replace("/neondb", "/otherdb"))).not.toBe(sandboxScope(pooled));
});

test("everything missing is named at once, and an empty value counts as missing", () => {
  const { DATABASE_URL: _url, CRON_SECRET: _cron, ...rest } = complete;
  const error = (() => {
    try {
      readEnv({ ...rest, WORKOS_API_KEY: "" });
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(EnvError);
  expect((error as Error).message).toBe(
    "The API cannot start. DATABASE_URL is not set. WORKOS_API_KEY is not set. CRON_SECRET is not set.",
  );
});

test("a malformed value is named and never quoted", () => {
  const read = (overrides: Record<string, string>) => {
    try {
      readEnv({ ...complete, ...overrides });
      return "read";
    } catch (thrown) {
      return (thrown as Error).message;
    }
  };
  const url = read({ DATABASE_URL: "not a url with hunter2 in it" });
  expect(url).toBe("The API cannot start. DATABASE_URL is malformed.");
  expect(read({ GITHUB_APP_PRIVATE_KEY: "/path/to/key.pem" })).toContain(
    "GITHUB_APP_PRIVATE_KEY is malformed.",
  );
  expect(read({ PONZU_MIN_CLIENT_VERSIONS: "macos>=2" })).toContain(
    "PONZU_MIN_CLIENT_VERSIONS is malformed.",
  );
  // Anything that is not an Anthropic API key.
  expect(read({ PONZU_ANTHROPIC_API_KEY: "ghs_not-an-anthropic-key" })).toBe(
    "The API cannot start. PONZU_ANTHROPIC_API_KEY is malformed.",
  );
  expect(read({ PONZU_ANTHROPIC_API_KEY: "" })).toBe(
    "The API cannot start. PONZU_ANTHROPIC_API_KEY is not set.",
  );
});

test(".env.example lists exactly the variables the API reads, with no values", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)];
  expect(listed.map(([, , value]) => value).filter(Boolean)).toEqual([]);

  // Reading an environment with only one name set says which others it wanted.
  const names = listed.map(([, name]) => name!);
  const required = names.filter((name) => name in complete);
  expect(required.sort()).toEqual(Object.keys(complete).sort());
  expect(names.filter((name) => !(name in complete)).sort()).toEqual([
    "EXPO_ACCESS_TOKEN",
    "PONZU_API_URL",
    "PONZU_MIN_CLIENT_VERSIONS",
    "PONZU_POSTHOG_AI_CONTENT",
    "PONZU_POSTHOG_HOST",
    "PONZU_POSTHOG_KEY",
    "PONZU_SANDBOX_IDLE_SECONDS",
    "PONZU_SANDBOX_MAX_PER_OWNER",
    "PONZU_SANDBOX_MAX_PER_WORKSPACE",
    "PONZU_VAULT_OLD_KEYS",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
    "VERCEL_TOKEN",
  ]);
});
