import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import current from "@ponzu/runner/image/current.json" with { type: "json" };
import {
  DEFAULT_API_URL,
  ENVIRONMENTS,
  EnvError,
  emailEnvProblems,
  environmentPair,
  FORBIDDEN_ENV,
  OPTIONAL_ENV,
  REQUIRED_ENV,
  readEnv,
  SYSTEM_ENV,
  sandboxScope,
  vercelEnvironmentFor,
} from "./env.ts";
import { FEATURES_OFF } from "./features.ts";
import { createLogger, type LogLine } from "./http/log.ts";

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
      // Off Vercel and unset, runners call dev: a local API runs on dev's database.
      apiUrl: "https://api-dev.ponzu.design",
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
    // Off Vercel, unset says local.
    environment: "local",
    commit: null,
    // Without a PostHog key, analytics is off.
    posthog: null,
    // Without PostHog's personal key, deleting an account leaves PostHog alone.
    posthogAdmin: null,
    // Without an Expo access token, push is off.
    push: null,
    // Without a Resend key, email is off; nothing else about email is set.
    mail: null,
    email: { replyTo: null, allow: null, paused: new Set() },
    // Every feature switch is off when nothing sets it.
    features: FEATURES_OFF,
    // Not on Vercel, so rate limits could not be asked even with PONZU_RATE_LIMITS=vercel.
    onVercel: false,
  });
});

/** What a Vercel deployment adds to `complete`: where it is, and where its runners reach it. */
const deployed = {
  VERCEL: "1",
  PONZU_ENVIRONMENT: "dev",
  PONZU_API_URL: "https://api-dev.ponzu.design",
};

test("rate limits are off by default, on Vercel too, and only `vercel` switches them on", () => {
  const onVercel = readEnv({ ...complete, ...deployed });
  expect(onVercel.onVercel).toBe(true);
  expect(onVercel.features.rateLimits).toBe("off");
  expect(readEnv({ ...complete, PONZU_RATE_LIMITS: "" }).features.rateLimits).toBe("off");
  const on = readEnv({ ...complete, ...deployed, PONZU_RATE_LIMITS: "vercel" });
  expect(on.features.rateLimits).toBe("vercel");
  expect(on.onVercel).toBe(true);
  expect(() => readEnv({ ...complete, PONZU_RATE_LIMITS: "on" })).toThrow(
    "PONZU_RATE_LIMITS is malformed.",
  );
});

test("every feature switch is off by default, and an empty value is unset", () => {
  expect(FEATURES_OFF).toEqual({
    billing: "off",
    push: false,
    email: false,
    repoBases: false,
    mergeQueue: false,
    rateLimits: "off",
    maintenance: "off",
  });
  const empty = Object.fromEntries(
    [
      "PONZU_BILLING",
      "EXPO_ACCESS_TOKEN",
      "RESEND_API_KEY",
      "PONZU_REPO_BASES",
      "PONZU_MERGE_QUEUE",
      "PONZU_RATE_LIMITS",
      "PONZU_MAINTENANCE",
    ].map((name) => [name, ""]),
  );
  expect(readEnv({ ...complete, ...empty }).features).toEqual(FEATURES_OFF);
  // "0" says off as plainly as leaving it out.
  expect(readEnv({ ...complete, PONZU_REPO_BASES: "0", PONZU_MERGE_QUEUE: "0" }).features).toEqual(
    FEATURES_OFF,
  );
});

test("each switch is read from its own variable", () => {
  const on = (vars: Record<string, string>) => readEnv({ ...complete, ...vars }).features;
  expect(on({ PONZU_BILLING: "observe" })).toEqual({ ...FEATURES_OFF, billing: "observe" });
  expect(on({ PONZU_BILLING: "on" })).toEqual({ ...FEATURES_OFF, billing: "on" });
  expect(on({ EXPO_ACCESS_TOKEN: "expo-token-for-a-test-0123456789" })).toEqual({
    ...FEATURES_OFF,
    push: true,
  });
  expect(on({ RESEND_API_KEY: "re_test_example" })).toEqual({ ...FEATURES_OFF, email: true });
  expect(on({ PONZU_REPO_BASES: "1" })).toEqual({ ...FEATURES_OFF, repoBases: true });
  expect(on({ PONZU_MERGE_QUEUE: "1" })).toEqual({ ...FEATURES_OFF, mergeQueue: true });
  expect(on({ PONZU_RATE_LIMITS: "vercel" })).toEqual({ ...FEATURES_OFF, rateLimits: "vercel" });
  expect(on({ PONZU_MAINTENANCE: "wakes_paused" })).toEqual({
    ...FEATURES_OFF,
    maintenance: "wakes_paused",
  });
  expect(on({ PONZU_MAINTENANCE: "read_only" })).toEqual({
    ...FEATURES_OFF,
    maintenance: "read_only",
  });
});

test("a switch set to something it does not know stops the API, named and never quoted", () => {
  for (const [name, value] of [
    ["PONZU_BILLING", "yes"],
    ["PONZU_REPO_BASES", "true"],
    ["PONZU_MERGE_QUEUE", "on"],
    ["PONZU_RATE_LIMITS", "cloudflare"],
    ["PONZU_MAINTENANCE", "paused"],
  ] as const) {
    expect(() => readEnv({ ...complete, [name]: value })).toThrow(
      `The API cannot start. ${name} is malformed.`,
    );
  }
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

test("a Resend key switches email on, from Ponzu unless PONZU_EMAIL_FROM says otherwise", () => {
  expect(readEnv(complete).mail).toBeNull();
  expect(readEnv({ ...complete, RESEND_API_KEY: "" }).mail).toBeNull();
  expect(readEnv({ ...complete, RESEND_API_KEY: "re_test_example" }).mail).toEqual({
    apiKey: "re_test_example",
    from: "Ponzu <ping@mail.ponzu.design>",
  });
  expect(
    readEnv({
      ...complete,
      RESEND_API_KEY: "re_test_example",
      PONZU_EMAIL_FROM: "Ponzu Dev <ping@dev.ponzu.design>",
    }).mail,
  ).toEqual({ apiKey: "re_test_example", from: "Ponzu Dev <ping@dev.ponzu.design>" });
  // A bare address, a second line or a second address is refused, named and never quoted.
  for (const from of [
    "ping@ponzu.design",
    "Ponzu <ping@ponzu.design>\nBcc: someone@example.com",
    "Ponzu <a@b.c>, Other <d@e.f>",
  ]) {
    expect(() => readEnv({ ...complete, PONZU_EMAIL_FROM: from })).toThrow(
      "The API cannot start. PONZU_EMAIL_FROM is malformed.",
    );
  }
});

test("email's Reply-To, allowlist and paused kinds are read, and anything else is refused", () => {
  const email = readEnv({
    ...complete,
    PONZU_EMAIL_REPLY_TO: "hello@ponzu.design",
    PONZU_EMAIL_ALLOW: " Maya@Example.com, @northbrook.dev ",
    PONZU_EMAIL_PAUSED: "digest,billing, team",
  }).email;
  expect(email.replyTo).toBe("hello@ponzu.design");
  expect(email.allow).toEqual({
    addresses: new Set(["maya@example.com"]),
    domains: new Set(["northbrook.dev"]),
  });
  expect(email.paused).toEqual(new Set(["digest", "billing", "team"]));
  expect(
    readEnv({ ...complete, PONZU_EMAIL_REPLY_TO: "Ponzu <hello@ponzu.design>" }).email,
  ).toMatchObject({ replyTo: "Ponzu <hello@ponzu.design>" });
  // An empty allowlist is set, and holds everything: nobody is named.
  expect(readEnv({ ...complete, PONZU_EMAIL_ALLOW: "," }).email.allow).toEqual({
    addresses: new Set(),
    domains: new Set(),
  });
  // A notice cannot be paused, and a name that is not a kind is a typo, not a no-op.
  for (const [name, value] of [
    ["PONZU_EMAIL_PAUSED", "notice"],
    ["PONZU_EMAIL_PAUSED", "digest,recaps"],
    ["PONZU_EMAIL_ALLOW", "maya"],
    ["PONZU_EMAIL_ALLOW", "maya@example.com; sam@example.com"],
    ["PONZU_EMAIL_REPLY_TO", "a@b.c, d@e.f"],
    ["PONZU_EMAIL_REPLY_TO", "hello@ponzu.design\nBcc: x@y.z"],
  ] as const) {
    expect(() => readEnv({ ...complete, [name]: value })).toThrow(
      `The API cannot start. ${name} is malformed.`,
    );
  }
});

test("production reports an allowlist, and billing paused while billing is on, without refusing", () => {
  const production = { PONZU_ENVIRONMENT: "production" as const, PONZU_BILLING: "off" as const };
  expect(emailEnvProblems(production)).toEqual([]);
  expect(emailEnvProblems({ ...production, PONZU_EMAIL_ALLOW: "a@b.c" })).toEqual([
    "PONZU_EMAIL_ALLOW is set on production, where it is ignored: remove it.",
  ]);
  // Paused while billing is off or observing is how production starts (founder step 10).
  expect(
    emailEnvProblems({ ...production, PONZU_EMAIL_PAUSED: "digest,billing,team,recap" }),
  ).toEqual([]);
  expect(
    emailEnvProblems({ ...production, PONZU_BILLING: "on", PONZU_EMAIL_PAUSED: "team,billing" }),
  ).toEqual([
    "PONZU_EMAIL_PAUSED holds billing while PONZU_BILLING is on: admins would not be told that work stopped.",
  ]);
  expect(
    emailEnvProblems({ ...production, PONZU_BILLING: "on", PONZU_EMAIL_PAUSED: "team" }),
  ).toEqual([]);
  // Outside production neither is a mistake: dev needs its allowlist.
  expect(
    emailEnvProblems({
      PONZU_ENVIRONMENT: "dev",
      PONZU_BILLING: "on",
      PONZU_EMAIL_ALLOW: "a@b.c",
      PONZU_EMAIL_PAUSED: "billing",
    }),
  ).toEqual([]);

  // The API still starts, and says so in its boot log, naming variables and no value.
  const lines: LogLine[] = [];
  const env = readEnv(
    {
      ...complete,
      VERCEL: "1",
      PONZU_ENVIRONMENT: "production",
      PONZU_API_URL: "https://api.ponzu.design",
      PONZU_BILLING: "on",
      PONZU_EMAIL_PAUSED: "billing",
      PONZU_EMAIL_ALLOW: "secret-address@example.com",
    },
    { log: createLogger((line) => lines.push(line)) },
  );
  expect(env.environment).toBe("production");
  const problems = lines.filter((line) => line.event === "email_env_problem");
  expect(problems).toHaveLength(2);
  expect(problems.every((line) => line.level === "error")).toBe(true);
  expect(JSON.stringify(lines)).not.toContain("secret-address");
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
  expect(() => readEnv({ ...complete, ...deployed, ...triple })).toThrow(
    "VERCEL_TOKEN is set on Vercel",
  );
  // A deployment's own ids, without a token: OIDC.
  const onVercel = readEnv({
    ...complete,
    ...deployed,
    VERCEL_TEAM_ID: "team_x",
    VERCEL_PROJECT_ID: "prj_x",
  });
  expect(onVercel.sandbox.vercel).toBeNull();
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

test("the scope is byte for byte what production's live sandboxes were named with", () => {
  // Production's sandboxes are live and named pz-<scope>-…; a different value for the same
  // database orphans every one of them. These values are what main's sandboxScope gave
  // (915dab2a, the first 12 hex of sha256(host without -pooler + path)), computed with that
  // code, not with this one. Whatever environment reads the URL, the scope is the same.
  const fixed = [
    ["postgres://user:hunter2@ep-example-pooler.us-east-1.aws.neon.tech/neondb", "d4ba16981c10"],
    ["postgres://other:secret@ep-example.us-east-1.aws.neon.tech/neondb", "d4ba16981c10"],
    ["postgres://user:pw@ep-example-dev-pooler.us-east-1.aws.neon.tech/neondb", "f333cdb04c0a"],
  ] as const;
  for (const [url, scope] of fixed) {
    expect(sandboxScope(url)).toBe(scope);
    for (const environment of ["production", "dev", "preview"]) {
      const env = readEnv({
        ...complete,
        ...deployed,
        DATABASE_URL: url,
        PONZU_ENVIRONMENT: environment,
        VERCEL_TARGET_ENV: environment,
      });
      expect(env.sandbox.scope).toBe(scope);
    }
    expect(readEnv({ ...complete, DATABASE_URL: url }).sandbox.scope).toBe(scope);
  }
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

test("PostHog's personal key and project id switch forgetting on together, never quoted", () => {
  const key = "phx_a-personal-key-for-a-test-0123";
  const both = { PONZU_POSTHOG_PERSONAL_API_KEY: key, PONZU_POSTHOG_PROJECT_ID: "4242" };
  expect(readEnv({ ...complete, ...both }).posthogAdmin).toEqual({
    personalApiKey: key,
    projectId: "4242",
    host: "https://us.posthog.com",
  });
  const eu = readEnv({ ...complete, ...both, PONZU_POSTHOG_API_HOST: "https://eu.posthog.com/" });
  expect(eu.posthogAdmin?.host).toBe("https://eu.posthog.com");
  // Empty is unset: forgetting stays off, and the API still starts.
  const empty = { PONZU_POSTHOG_PERSONAL_API_KEY: "", PONZU_POSTHOG_PROJECT_ID: "" };
  expect(readEnv({ ...complete, ...empty }).posthogAdmin).toBeNull();

  const message = (vars: Record<string, string>) => {
    try {
      readEnv({ ...complete, ...vars });
    } catch (error) {
      return (error as Error).message;
    }
    return "started";
  };
  const half = message({ PONZU_POSTHOG_PERSONAL_API_KEY: key });
  expect(half).toBe(
    "The API cannot start. PONZU_POSTHOG_PERSONAL_API_KEY and PONZU_POSTHOG_PROJECT_ID are both set or neither.",
  );
  expect(message({ PONZU_POSTHOG_PROJECT_ID: "4242" })).toBe(half);
  expect(message({ ...both, PONZU_POSTHOG_PROJECT_ID: "x" })).toBe(
    "The API cannot start. PONZU_POSTHOG_PROJECT_ID is malformed.",
  );
  const short = message({ ...both, PONZU_POSTHOG_PERSONAL_API_KEY: "phx_short" });
  expect(short).toBe("The API cannot start. PONZU_POSTHOG_PERSONAL_API_KEY is malformed.");
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
    "PONZU_BILLING",
    "PONZU_EMAIL_ALLOW",
    "PONZU_EMAIL_FROM",
    "PONZU_EMAIL_PAUSED",
    "PONZU_EMAIL_REPLY_TO",
    "PONZU_ENVIRONMENT",
    "PONZU_MAINTENANCE",
    "PONZU_MERGE_QUEUE",
    "PONZU_MIN_CLIENT_VERSIONS",
    "PONZU_POSTHOG_AI_CONTENT",
    "PONZU_POSTHOG_API_HOST",
    "PONZU_POSTHOG_HOST",
    "PONZU_POSTHOG_KEY",
    "PONZU_POSTHOG_PERSONAL_API_KEY",
    "PONZU_POSTHOG_PROJECT_ID",
    "PONZU_RATE_LIMITS",
    "PONZU_REPO_BASES",
    "PONZU_SANDBOX_IDLE_SECONDS",
    "PONZU_SANDBOX_MAX_PER_OWNER",
    "PONZU_SANDBOX_MAX_PER_WORKSPACE",
    "PONZU_VAULT_OLD_KEYS",
    "RESEND_API_KEY",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
    "VERCEL_TOKEN",
  ]);
});

/** The message readEnv throws for `source`, or "read" when it starts. */
function problem(source: Record<string, string>): string {
  try {
    readEnv(source);
    return "read";
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(EnvError);
    return (thrown as Error).message;
  }
}

test("on Vercel, a deployment that does not say its environment never starts", () => {
  const { PONZU_ENVIRONMENT: _env, ...rest } = deployed;
  expect(problem({ ...complete, ...rest })).toBe(
    "The API cannot start. PONZU_ENVIRONMENT is not set.",
  );
  // Empty is how a dashboard says unset.
  expect(problem({ ...complete, ...deployed, PONZU_ENVIRONMENT: "" })).toBe(
    "The API cannot start. PONZU_ENVIRONMENT is not set.",
  );
});

test("on Vercel, a deployment that does not say where its runners reach it never starts", () => {
  const { PONZU_API_URL: _url, ...rest } = deployed;
  // Never production's address by default: a dev deployment's runners would call production.
  expect(problem({ ...complete, ...rest })).toBe("The API cannot start. PONZU_API_URL is not set.");
  expect(problem({ ...complete, ...deployed, PONZU_API_URL: "" })).toBe(
    "The API cannot start. PONZU_API_URL is not set.",
  );
  expect(problem({ ...complete, VERCEL: "1" })).toBe(
    "The API cannot start. PONZU_ENVIRONMENT is not set. PONZU_API_URL is not set.",
  );
});

test("on Vercel, the two are named together with everything else that is missing", () => {
  const { CRON_SECRET: _cron, ...rest } = complete;
  expect(problem({ ...rest, VERCEL: "1" })).toBe(
    "The API cannot start. CRON_SECRET is not set. PONZU_ENVIRONMENT is not set. PONZU_API_URL is not set.",
  );
});

test("a deployment that says both starts, and reports them", () => {
  const env = readEnv({ ...complete, ...deployed, PONZU_API_URL: "https://api-dev.ponzu.design/" });
  expect(env.environment).toBe("dev");
  expect(env.sandbox.apiUrl).toBe("https://api-dev.ponzu.design");
  expect([...ENVIRONMENTS]).toEqual(["production", "dev", "preview", "local"]);
  for (const name of ["production", "dev", "preview"] as const) {
    const on = { ...complete, ...deployed, PONZU_ENVIRONMENT: name, VERCEL_TARGET_ENV: name };
    expect(readEnv(on).environment).toBe(name);
  }
});

test("on Vercel, a deployment never calls itself local", () => {
  expect(problem({ ...complete, ...deployed, PONZU_ENVIRONMENT: "local" })).toBe(
    "The API cannot start. PONZU_ENVIRONMENT is local on Vercel, where it must be production, dev or preview.",
  );
  expect(readEnv({ ...complete, PONZU_ENVIRONMENT: "local" }).environment).toBe("local");
});

test("an environment it does not know is named and never quoted", () => {
  const message = problem({ ...complete, ...deployed, PONZU_ENVIRONMENT: "staging-hunter2" });
  expect(message).toBe("The API cannot start. PONZU_ENVIRONMENT is malformed.");
  expect(message).not.toContain("hunter2");
  expect(problem({ ...complete, PONZU_ENVIRONMENT: "Production" })).toBe(
    "The API cannot start. PONZU_ENVIRONMENT is malformed.",
  );
});

test("off Vercel, both may be left out: local, and the default address", () => {
  const env = readEnv(complete);
  expect(env.environment).toBe("local");
  expect(env.sandbox.apiUrl).toBe(DEFAULT_API_URL);
  // A script pointed at dev may still say so.
  expect(readEnv({ ...complete, PONZU_ENVIRONMENT: "dev" }).environment).toBe("dev");
});

test("the required, optional, system and forbidden names are exact and do not overlap", () => {
  expect([...REQUIRED_ENV].sort()).toEqual(
    [...Object.keys(complete), "PONZU_ENVIRONMENT", "PONZU_API_URL"].sort(),
  );
  expect([...OPTIONAL_ENV].sort()).toEqual([
    "EXPO_ACCESS_TOKEN",
    "PONZU_BILLING",
    "PONZU_EMAIL_ALLOW",
    "PONZU_EMAIL_FROM",
    "PONZU_EMAIL_PAUSED",
    "PONZU_EMAIL_REPLY_TO",
    "PONZU_MAINTENANCE",
    "PONZU_MERGE_QUEUE",
    "PONZU_MIN_CLIENT_VERSIONS",
    "PONZU_POSTHOG_AI_CONTENT",
    "PONZU_POSTHOG_API_HOST",
    "PONZU_POSTHOG_HOST",
    "PONZU_POSTHOG_KEY",
    "PONZU_POSTHOG_PERSONAL_API_KEY",
    "PONZU_POSTHOG_PROJECT_ID",
    "PONZU_RATE_LIMITS",
    "PONZU_REPO_BASES",
    "PONZU_SANDBOX_IDLE_SECONDS",
    "PONZU_SANDBOX_MAX_PER_OWNER",
    "PONZU_SANDBOX_MAX_PER_WORKSPACE",
    "PONZU_VAULT_OLD_KEYS",
    "R2_PRIVATE_BUCKET",
    "RESEND_API_KEY",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
  ]);
  expect([...SYSTEM_ENV]).toEqual(["VERCEL", "VERCEL_GIT_COMMIT_SHA", "VERCEL_TARGET_ENV"]);
  expect([...FORBIDDEN_ENV]).toEqual(["VERCEL_TOKEN", "BOAT_API_KEY", "PONZU_SANDBOX_SNAPSHOT"]);
  const all = [...REQUIRED_ENV, ...OPTIONAL_ENV, ...SYSTEM_ENV, ...FORBIDDEN_ENV];
  expect(new Set(all).size).toBe(all.length);
});

test("a deployment with exactly the required names starts", () => {
  const values: Record<string, string> = { ...complete, ...deployed };
  const onlyRequired = Object.fromEntries(
    [...REQUIRED_ENV, "VERCEL"].map((name) => [name, values[name]!]),
  );
  expect(problem(onlyRequired)).toBe("read");
});

// --- PONZU_ENVIRONMENT against VERCEL_TARGET_ENV -------------------------------------------------

/** readEnv on Vercel with this pair, and the one `environment_pair` line it logged. */
function boot(environment: string | undefined, target: string | undefined) {
  const lines: LogLine[] = [];
  const source: Record<string, string | undefined> = {
    ...complete,
    ...deployed,
    PONZU_ENVIRONMENT: environment,
    VERCEL_TARGET_ENV: target,
  };
  let outcome = "read";
  try {
    readEnv(source, { log: createLogger((line) => lines.push(line)) });
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(EnvError);
    outcome = (thrown as Error).message;
  }
  return { outcome, lines };
}

test("each environment belongs on the Vercel environment of its own name", () => {
  expect(vercelEnvironmentFor("production")).toBe("production");
  expect(vercelEnvironmentFor("preview")).toBe("preview");
  expect(vercelEnvironmentFor("dev")).toBe("dev");
});

test("on Vercel, every pair that agrees starts, and logs that it agrees", () => {
  for (const name of ["production", "preview", "dev"]) {
    const { outcome, lines } = boot(name, name);
    expect(outcome).toBe("read");
    expect(lines).toEqual([
      {
        level: "info",
        event: "environment_pair",
        environment: name,
        vercelEnvironment: name,
        onVercel: true,
        agrees: true,
      },
    ]);
  }
});

test("on Vercel, every pair that disagrees never starts, and logs both names", () => {
  const vercelNames = ["production", "preview", "dev", "development", "staging"];
  for (const environment of ["production", "preview", "dev"]) {
    for (const target of vercelNames.filter((name) => name !== environment)) {
      const { outcome, lines } = boot(environment, target);
      expect(outcome).toBe(
        `The API cannot start. PONZU_ENVIRONMENT is ${environment}, which belongs on Vercel's "${environment}" environment, but VERCEL_TARGET_ENV says this deployment runs in "${target}".`,
      );
      expect(lines).toEqual([
        {
          level: "error",
          event: "environment_pair",
          environment,
          vercelEnvironment: target,
          onVercel: true,
          agrees: false,
        },
      ]);
    }
  }
});

test("dev's values on the Production target never start, nor production's anywhere but there", () => {
  // The two mistakes one project makes possible: a dev deployment promoted or deployed --prod
  // with dev's values, and production's values (and so production's database) on dev.
  expect(boot("dev", "production").outcome).toContain("PONZU_ENVIRONMENT is dev");
  expect(boot("production", "dev").outcome).toContain("PONZU_ENVIRONMENT is production");
  expect(boot("production", "preview").outcome).toContain("PONZU_ENVIRONMENT is production");
});

test("every environment with the name unset starts, and the line says it was unset", () => {
  // Production too: no deployment has logged VERCEL_TARGET_ENV yet (E6), and refusing an unset
  // name would take production down on its next deploy if Vercel did not set it.
  expect(boot("production", "").outcome).toBe("read");
  for (const name of ["production", "dev", "preview"]) {
    const { outcome, lines } = boot(name, undefined);
    expect(outcome).toBe("read");
    expect(lines[0]).toMatchObject({
      level: "info",
      environment: name,
      vercelEnvironment: null,
      agrees: true,
    });
  }
});

test("a VERCEL_TARGET_ENV that is no environment's name is refused and never quoted", () => {
  const { outcome, lines } = boot("dev", "Dev hunter2");
  expect(outcome).toBe("The API cannot start. VERCEL_TARGET_ENV is malformed.");
  expect(JSON.stringify(lines)).not.toContain("hunter2");
  expect(lines[0]).toMatchObject({ vercelEnvironment: "malformed", agrees: false });
});

test("a malformed PONZU_ENVIRONMENT is logged as malformed, never quoted", () => {
  const { outcome, lines } = boot("staging-hunter2", "dev");
  expect(outcome).toBe("The API cannot start. PONZU_ENVIRONMENT is malformed.");
  expect(JSON.stringify(lines)).not.toContain("hunter2");
  expect(lines[0]).toMatchObject({ environment: "malformed", vercelEnvironment: "dev" });
});

test("off Vercel the pair is logged but never compared", () => {
  // `vercel env pull` can write VERCEL_TARGET_ENV into a laptop's file; it means nothing there.
  const lines: LogLine[] = [];
  const env = readEnv(
    { ...complete, PONZU_ENVIRONMENT: "dev", VERCEL_TARGET_ENV: "development" },
    { log: createLogger((line) => lines.push(line)) },
  );
  expect(env.environment).toBe("dev");
  expect(lines).toEqual([
    {
      level: "info",
      event: "environment_pair",
      environment: "dev",
      vercelEnvironment: "development",
      onVercel: false,
      agrees: true,
    },
  ]);
  expect(environmentPair({ PONZU_ENVIRONMENT: "production" }).problem).toBeNull();
});

test("without a logger readEnv logs nothing, and the boot passes one", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index).toContain("readEnv(process.env, { log: createLogger(consoleSink) })");
});
