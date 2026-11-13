import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXPECTED_MIGRATIONS } from "@ponzu/db";
import current from "@ponzu/runner/image/current.json" with { type: "json" };
import {
  createTestApp,
  TEST_BUNDLE,
  TEST_CRON_SECRET,
  TEST_IMAGE,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ commit: "abc1234", environment: "dev" });
});
afterAll(() => t.close());

/** The journal's entries, read from disk here so the test does not trust the export it checks. */
const journalEntries = (
  JSON.parse(
    readFileSync(
      new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: unknown[] }
).entries.length;

test("anyone can ask, and hears what is deployed, where, and that the database is current", async () => {
  const response = await t.app.request("/v1/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    version: "0.0.0-test",
    commit: "abc1234",
    environment: "dev",
    image: TEST_IMAGE,
    runnerBundle: TEST_BUNDLE.sha256.slice(0, 12),
    migrations: { applied: journalEntries, expected: journalEntries },
    database: true,
    // The minute has never run on this database.
    cron: { lastRanAt: null },
  });
});

test("it says when the minute last ran, without making a stale minute degraded", async () => {
  const minute = () =>
    t.app.request("/v1/cron/minute", { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } });
  expect((await minute()).status).toBe(200);
  const ranAt = new Date(t.clock.now()).toISOString();

  const body = await (await t.app.request("/v1/health")).json();
  expect(body).toMatchObject({ status: "ok", cron: { lastRanAt: ranAt } });

  // An hour without a run: still ok here. Whether that is an outage is the uptime check's call.
  t.clock.advance(3_600_000);
  const later = await t.app.request("/v1/health");
  expect(later.status).toBe(200);
  expect(await later.json()).toMatchObject({ status: "ok", cron: { lastRanAt: ranAt } });
});

test("expected is the journal's entry count, built in", () => {
  expect(EXPECTED_MIGRATIONS).toBe(journalEntries);
  expect(EXPECTED_MIGRATIONS).toBeGreaterThan(0);
});

test("an app that is told nothing says it is local", async () => {
  const local = await createTestApp();
  const body = (await (await local.app.request("/v1/health")).json()) as { environment: string };
  expect(body.environment).toBe("local");
  await local.close();
});

test("the image is the one this build ships, from current.json", async () => {
  const shipped = await createTestApp({ sandbox: { image: current.image } });
  const body = (await (await shipped.app.request("/v1/health")).json()) as { image: string };
  expect(body.image).toBe(current.image);
  expect(body.image).toMatch(/^ponzu-runner@sha256:[0-9a-f]{64}$/);
  await shipped.close();
});

test("a database one migration short is degraded at 200, and says by how much", async () => {
  const behind = await createTestApp();
  await behind.deps.db.execute(
    "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
  );

  const response = await behind.app.request("/v1/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "degraded",
    database: true,
    migrations: { applied: EXPECTED_MIGRATIONS - 1, expected: EXPECTED_MIGRATIONS },
  });
  await behind.close();
});

test("a database ahead of this build is degraded too", async () => {
  const ahead = await createTestApp();
  await ahead.deps.db.execute(
    "insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-branch', 0)",
  );

  const body = await (await ahead.app.request("/v1/health")).json();

  expect(body).toMatchObject({
    status: "degraded",
    migrations: { applied: EXPECTED_MIGRATIONS + 1, expected: EXPECTED_MIGRATIONS },
  });
  await ahead.close();
});

test("a database that was never migrated is reached but degraded, with nothing applied known", async () => {
  const bare = await createTestApp();
  await bare.deps.db.execute("drop schema drizzle cascade");

  const response = await bare.app.request("/v1/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "degraded",
    database: true,
    migrations: { applied: null, expected: EXPECTED_MIGRATIONS },
  });
  await bare.close();
});

test("a database that does not answer is a 503 that still says what is deployed", async () => {
  const down = await createTestApp({ environment: "production" });
  await down.close();

  const response = await down.app.request("/v1/health");

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: "degraded",
    environment: "production",
    migrations: { applied: null, expected: EXPECTED_MIGRATIONS },
    database: false,
  });
});

test("a runner bundle that cannot be read is null, not a failure", async () => {
  const unbuilt = await createTestApp();
  unbuilt.deps.runnerBundle = () => {
    throw new Error("No runner bundle");
  };

  const response = await unbuilt.app.request("/v1/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", runnerBundle: null });
  await unbuilt.close();
});

test("the answer holds no value from the environment's secrets", async () => {
  const text = await (await t.app.request("/v1/health")).text();
  for (const secret of [t.deps.config.cronSecret, t.deps.config.githubApp.webhookSecret]) {
    expect(text).not.toContain(secret);
  }
});

test("a database that hangs is given three seconds", async () => {
  const slow = await createTestApp();
  let asked = 0;
  slow.deps.db = new Proxy(slow.deps.db, {
    get: (db, key) =>
      key === "execute"
        ? () => {
            asked += 1;
            return new Promise(() => {});
          }
        : Reflect.get(db, key),
  });

  const pending = slow.app.request("/v1/health");
  // Both statements are waiting (the ping and the count) before the clock moves.
  const giveUpAt = Date.now() + 5_000;
  while (asked < 2 && Date.now() < giveUpAt) await new Promise((r) => setImmediate(r));
  expect(asked).toBe(2);
  slow.clock.advance(3_000);

  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ migrations: { applied: null } });
  await slow.close();
});
