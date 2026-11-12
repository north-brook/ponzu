import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createDb, EXPECTED_MIGRATIONS, SEALED_COLUMNS } from "@ponzu/db";
import { selfcheckStep } from "../cron/steps/selfcheck.ts";
import type { Deps } from "../deps/index.ts";
import {
  createTestApp,
  MemoryStorage,
  TEST_CRON_SECRET,
  TEST_SCOPE,
  TEST_VAULT_KEY,
  type TestApp,
} from "../testing/index.ts";
import { createVault, generateVaultKey } from "../vault/vault.ts";
import { APP_EVENTS, APP_PERMISSIONS } from "./github-app.ts";
import {
  CHECK_BUDGET_MS,
  runSelfcheck,
  SELFCHECK_IDS,
  SelfcheckFailed,
  type SelfcheckId,
  type SelfcheckResult,
} from "./selfcheck.ts";

let t: TestApp;

/** Plain SQL on a test app's in-process Postgres (PGlite), for what no query function does. */
async function query<T>(app: TestApp, text: string): Promise<T[]> {
  const client = (app.db as unknown as { $client: { query(text: string): Promise<{ rows: T[] }> } })
    .$client;
  return (await client.query(text)).rows;
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** Every answer and log line a test made, to search for secrets at the end. */
const said: string[] = [];

/** Puts the fakes back as `createTestApp` made them. */
afterEach(() => {
  t.realtime.failing = false;
  t.storage.headFails = null;
  t.anthropic.ownKeyAccepted = true;
  t.anthropic.failing = false;
  t.github.clearFailures();
  t.github.app.slug = "ponzu-test";
  t.github.app.permissions = { ...APP_PERMISSIONS };
  t.github.app.events = [...APP_EVENTS];
  t.github.app.hook = {
    url: "https://api.test/v1/github/webhook",
    content_type: "json",
    insecure_ssl: "0",
  };
  said.push(JSON.stringify(t.logs), JSON.stringify(t.analytics.exceptions));
});

const selfcheck = (authorization?: string) =>
  t.app.request("/v1/cron/selfcheck", { headers: authorization ? { authorization } : {} });

/** The selfcheck through its route, as `scripts/prod/check.ts` asks it. */
async function checked(): Promise<SelfcheckResult[]> {
  const response = await selfcheck(`Bearer ${TEST_CRON_SECRET}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  said.push(text);
  return (JSON.parse(text) as { checks: SelfcheckResult[] }).checks;
}

/** Only the checks that failed, by id. */
const failures = (results: SelfcheckResult[]) =>
  Object.fromEntries(
    results.filter((result) => !result.ok).map(({ id, ...rest }) => [id, rest]),
  ) as Partial<Record<SelfcheckId, Omit<SelfcheckResult, "id">>>;

/** The selfcheck straight from the module, on deps a test has changed. */
async function checkedWith(deps: Deps): Promise<SelfcheckResult[]> {
  const results = await runSelfcheck(deps);
  said.push(JSON.stringify(results));
  return results;
}

test("only the scheduler's secret runs it", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${TEST_CRON_SECRET}x`]) {
    const response = await selfcheck(authorization);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  }
});

test("with everything healthy, every check is ok, in the order the ids are listed", async () => {
  const results = await checked();
  expect(results.map((result) => result.id)).toEqual([...SELFCHECK_IDS]);
  expect(failures(results)).toEqual({});
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  // The informational ones say how things stand.
  expect(byId.storage_private).toEqual({ id: "storage_private", ok: true, detail: "same_bucket" });
  expect(byId.posthog).toEqual({ id: "posthog", ok: true, detail: "not_configured" });
  expect(byId.vault_old_keys).toEqual({ id: "vault_old_keys", ok: true, detail: "ok", count: 0 });
});

test("PostHog is reported as configured when it is", async () => {
  const deps: Deps = {
    ...t.deps,
    config: {
      ...t.deps.config,
      posthog: { key: "phc_test", host: "https://posthog.test", aiContent: false },
    },
  };
  const [result] = await runSelfcheck(deps, ["posthog"]);
  expect(result).toEqual({ id: "posthog", ok: true, detail: "configured" });
});

// One broken thing at a time: exactly its check fails, with the word for how.
const broken: [string, () => void, Partial<Record<SelfcheckId, Omit<SelfcheckResult, "id">>>][] = [
  [
    "a Realtime secret that cannot seal",
    () => {
      t.realtime.failing = true;
    },
    { realtime: { ok: false, detail: "failed" } },
  ],
  [
    "an R2 token the assets bucket refuses",
    () => {
      t.storage.headFails = 403;
    },
    { storage_assets: { ok: false, detail: "refused" } },
  ],
  [
    "R2 not answering",
    () => {
      t.storage.headFails = 0;
    },
    { storage_assets: { ok: false, detail: "unreachable" } },
  ],
  [
    "a WorkOS key WorkOS refuses",
    () => t.workos.failNext("/user_management/users", 401),
    { workos: { ok: false, detail: "refused" } },
  ],
  [
    "WorkOS failing",
    () => t.workos.failNext("/user_management/users", 500),
    { workos: { ok: false, detail: "failed" } },
  ],
  [
    "an App under another slug",
    () => {
      t.github.app.slug = "someone-else";
    },
    { github_app: { ok: false, detail: "wrong_slug" } },
  ],
  [
    "an App without members: read, and with contents only at read",
    () => {
      const { members: _, ...rest } = APP_PERMISSIONS;
      t.github.app.permissions = { ...rest, contents: "read" };
    },
    { github_app: { ok: false, detail: "missing_permissions", missing: ["contents", "members"] } },
  ],
  [
    "an App not subscribed to push",
    () => {
      t.github.app.events = APP_EVENTS.filter((event) => event !== "push");
    },
    { github_app: { ok: false, detail: "missing_events", missing: ["push"] } },
  ],
  [
    "GitHub refusing the App's JWT",
    () => t.github.failNext("/app", 401),
    { github_app: { ok: false, detail: "refused" } },
  ],
  [
    "a webhook pointed at another deployment",
    () => {
      t.github.app.hook.url = "https://api.elsewhere/v1/github/webhook";
    },
    { github_webhook: { ok: false, detail: "wrong_url" } },
  ],
  [
    "a webhook sending form data",
    () => {
      t.github.app.hook.content_type = "form";
    },
    { github_webhook: { ok: false, detail: "wrong_content_type" } },
  ],
  [
    "a webhook that does not check TLS",
    () => {
      t.github.app.hook.insecure_ssl = "1";
    },
    { github_webhook: { ok: false, detail: "insecure_ssl" } },
  ],
  [
    "GitHub failing the hook config",
    () => t.github.failNext("/app/hook/config", 502),
    { github_webhook: { ok: false, detail: "failed" } },
  ],
  [
    "Ponzu's Anthropic key revoked",
    () => {
      t.anthropic.ownKeyAccepted = false;
    },
    { anthropic: { ok: false, detail: "refused" } },
  ],
  [
    "Anthropic not answering",
    () => {
      t.anthropic.failing = true;
    },
    { anthropic: { ok: false, detail: "unreachable" } },
  ],
  [
    "Vercel's sandboxes unavailable",
    () => t.sandboxes.failNext("list", `pz-${TEST_SCOPE}-`, "unavailable"),
    { sandboxes: { ok: false, detail: "unreachable" } },
  ],
  [
    "Vercel refusing the sandbox list",
    () => t.sandboxes.failNext("list", `pz-${TEST_SCOPE}-`, "rejected"),
    { sandboxes: { ok: false, detail: "failed" } },
  ],
];

for (const [what, breakIt, expected] of broken) {
  test(`with ${what}, only that check fails`, async () => {
    breakIt();
    expect(failures(await checked())).toEqual(expected);
  });
}

test("a private bucket the token cannot read fails storage_private alone", async () => {
  const archives = new MemoryStorage(t.clock);
  archives.headFails = 403;
  expect(failures(await checkedWith({ ...t.deps, archives }))).toEqual({
    storage_private: { ok: false, detail: "refused" },
  });
  // And a readable one is checked, not taken for the assets bucket.
  const [readable] = await runSelfcheck({ ...t.deps, archives: new MemoryStorage(t.clock) }, [
    "storage_private",
  ]);
  expect(readable).toEqual({ id: "storage_private", ok: true, detail: "ok" });
});

test("a database that cannot be reached fails every check that reads it", async () => {
  // A deadline already spent fails each statement before anything is sent: no network.
  const db = createDb("postgres://user:password@database.invalid/ponzu", {
    deadline: () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")),
  });
  expect(failures(await checkedWith({ ...t.deps, db }))).toEqual({
    database: { ok: false, detail: "unreachable" },
    migrations: { ok: false, detail: "unreachable" },
    vault_old_keys: { ok: false, detail: "unreachable" },
  });
});

test("migrations are behind when the database lacks one, and ahead when it has an extra", async () => {
  const own = await createTestApp();
  try {
    const [applied] = await query<{ n: number }>(
      own,
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    expect(applied!.n).toBe(EXPECTED_MIGRATIONS);

    await query(
      own,
      "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
    );
    expect(failures(await checkedWith(own.deps))).toEqual({
      migrations: { ok: false, detail: "behind" },
    });

    await query(
      own,
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('a', 1), ('b', 2)",
    );
    expect(failures(await checkedWith(own.deps))).toEqual({
      migrations: { ok: false, detail: "ahead" },
    });
  } finally {
    await own.close();
  }
});

test("values sealed under an old vault key are counted until they are sealed again", async () => {
  // A sign-in keeps the person's GitHub access and refresh tokens, sealed with the test key.
  await t.signInAs({ login: "rotation" });
  const rotated = createVault({ key: generateVaultKey(), oldKeys: [TEST_VAULT_KEY] });
  const [stale] = await runSelfcheck({ ...t.deps, vault: rotated }, ["vault_old_keys"]);
  expect(stale).toEqual({ id: "vault_old_keys", ok: false, detail: "old_keys", count: 2 });
  // Under the key that sealed them, nothing is stale.
  const [current] = await runSelfcheck(t.deps, ["vault_old_keys"]);
  expect(current).toEqual({ id: "vault_old_keys", ok: true, detail: "ok", count: 0 });
});

test("every sealed column in the schema is one the count reads", async () => {
  // Each column the vault writes is named `encrypted_*`; one added without a line in
  // SEALED_COLUMNS would go uncounted after a rotation.
  const rows = await query<{ name: string }>(
    t,
    `select table_name || '.' || column_name as name from information_schema.columns
      where table_schema = 'public' and column_name like 'encrypted%' order by 1`,
  );
  expect(rows.map((row) => row.name)).toEqual([...SEALED_COLUMNS].sort());
});

test("a check that does not answer within its budget times out, and the rest are not held", async () => {
  const held = t.github.holdNext("/app");
  const running = runSelfcheck(t.deps, ["github_app"]);
  await held.reached;
  t.clock.advance(CHECK_BUDGET_MS);
  expect(await running).toEqual([{ id: "github_app", ok: false, detail: "timed_out" }]);
  held.release();
});

test("the cron runs it at minute 7, and raises each failed check but the informational ones", async () => {
  expect(selfcheckStep.atMinute).toBe(7);
  t.analytics.exceptions.length = 0;
  t.realtime.failing = true;
  t.anthropic.ownKeyAccepted = false;
  const rotated = createVault({ key: generateVaultKey(), oldKeys: [TEST_VAULT_KEY] });
  const answer = await selfcheckStep.run({ ...t.deps, vault: rotated }, new Date(t.clock.now()));
  expect(answer).toEqual({ ok: SELFCHECK_IDS.length - 3, failed: 3 });
  const raised = t.analytics.exceptions.map(({ error, properties }) => ({
    // Error tracking is handed a scrubbed copy, so it is told apart by its words.
    error: String(error),
    check: properties.check,
  }));
  // vault_old_keys failed too, and is logged, but is a step left to do, not an alarm.
  expect(raised.sort((a, b) => String(a.check).localeCompare(String(b.check)))).toEqual([
    { error: String(new SelfcheckFailed("anthropic", "refused")), check: "anthropic" },
    { error: String(new SelfcheckFailed("realtime", "failed")), check: "realtime" },
  ]);
  const logged = t.logs
    .filter((line) => line.event === "selfcheck_failed")
    .map((line) => String(line.check))
    .sort();
  expect(logged).toEqual(expect.arrayContaining(["anthropic", "realtime", "vault_old_keys"]));
});

test("through the minute's cron, it runs once in the hour, at minute 7", async () => {
  const HOUR = 3_600_000;
  const now = t.clock.now();
  const target = now - (now % HOUR) + HOUR + 7 * 60_000;
  t.clock.advance(target - now);
  const ran = async () => {
    const response = await t.app.request("/v1/cron/minute", {
      headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    return ((await response.json()) as { steps: Record<string, unknown> }).steps.selfcheck;
  };
  expect(await ran()).toEqual({ ok: SELFCHECK_IDS.length, failed: 0 });
  // Once in its slot.
  expect(await ran()).toBeUndefined();
  t.clock.advance(60_000);
  expect(await ran()).toBeUndefined();
});

test("nothing it answers or logs carries a value from the environment, or what upstream said", async () => {
  // Upstream answers that carry a secret back, which a careless check would quote.
  const canary = TEST_CRON_SECRET;
  t.github.app.slug = canary;
  t.github.app.hook.url = `https://evil.example/${t.github.credentials.webhookSecret}`;
  t.github.app.events = [canary];
  t.github.app.permissions = { [canary]: "write" };
  const results = await checked();
  expect(failures(results)).toEqual({
    github_app: { ok: false, detail: "wrong_slug" },
    github_webhook: { ok: false, detail: "wrong_url" },
  });

  const secrets = [
    TEST_CRON_SECRET,
    TEST_VAULT_KEY,
    t.github.credentials.clientSecret,
    t.github.credentials.webhookSecret,
    // The PEM's body, one line of it, is as good as the whole key.
    t.github.credentials.privateKey.split("\n")[1]!,
    t.workos.apiKey,
  ];
  const everything = [...said, JSON.stringify(t.logs), JSON.stringify(t.analytics.exceptions)];
  for (const secret of secrets) {
    for (const text of everything) expect(text).not.toContain(secret);
  }
});
