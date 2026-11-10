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
    },
    cronSecret: complete.CRON_SECRET,
    boatApiKey: "boat-key",
    vault: { key: "vault-key", oldKeys: [] },
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
    "PONZU_MIN_CLIENT_VERSIONS",
    "PONZU_VAULT_OLD_KEYS",
  ]);
});
