import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EnvError, readEnv } from "./env.ts";

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
  BOAT_API_KEY: "boat-key",
  PONZU_VAULT_KEY: "vault-key",
  NEON_REALTIME_URL: "https://ep-example.rt.c-1.us-east-1.aws.neon.tech/",
  NEON_REALTIME_SECRET: "nrt_live_1example",
  PONZU_ASSETS_URL: "https://assets.example/",
  GITHUB_APP_BOT_USER_ID: "354938669",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "r2-key-id",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_BUCKET: "ponzu-test",
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
    boatApiKey: "boat-key",
    // Unset, a wake says the snapshot is missing; the API itself starts.
    sandbox: { snapshot: null, apiUrl: "https://api.ponzu.design", idleSeconds: 300 },
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
    minimumClientVersions: {},
    commit: null,
  });
});

test("the optional ones are read when set", () => {
  const env = readEnv({
    ...complete,
    PONZU_VAULT_OLD_KEYS: "older,oldest",
    PONZU_MIN_CLIENT_VERSIONS: "macos=2.1.0",
    VERCEL_GIT_COMMIT_SHA: "abc1234",
    PONZU_SANDBOX_SNAPSHOT: "ponzu-runner-0123456789ab",
    PONZU_API_URL: "https://ponzu-dev.example/",
    PONZU_SANDBOX_IDLE_SECONDS: "60",
  });
  expect(env.sandbox).toEqual({
    snapshot: "ponzu-runner-0123456789ab",
    apiUrl: "https://ponzu-dev.example",
    idleSeconds: 60,
  });
  expect(env.vault.oldKeys).toEqual(["older", "oldest"]);
  expect(env.minimumClientVersions).toEqual({ macos: "2.1.0" });
  expect(env.commit).toBe("abc1234");
});

test("everything missing is named at once, and an empty value counts as missing", () => {
  const { DATABASE_URL: _url, BOAT_API_KEY: _boat, ...rest } = complete;
  const error = (() => {
    try {
      readEnv({ ...rest, WORKOS_API_KEY: "" });
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(EnvError);
  expect((error as Error).message).toBe(
    "The API cannot start. DATABASE_URL is not set. WORKOS_API_KEY is not set. BOAT_API_KEY is not set.",
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
    "PONZU_API_URL",
    "PONZU_MIN_CLIENT_VERSIONS",
    "PONZU_SANDBOX_IDLE_SECONDS",
    "PONZU_SANDBOX_SNAPSHOT",
    "PONZU_VAULT_OLD_KEYS",
  ]);
});
