import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ commit: "abc1234" });
});
afterAll(() => t.close());

test("anyone can ask, and hears the version, the commit and that the database answers", async () => {
  const response = await t.app.request("/v1/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    version: "0.0.0-test",
    commit: "abc1234",
    database: true,
  });
});

test("a database that does not answer is a 503 that still says what is deployed", async () => {
  const down = await createTestApp();
  await down.close();

  const response = await down.app.request("/v1/health");

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: "degraded", database: false });
});

test("a database that hangs is given three seconds", async () => {
  const slow = await createTestApp();
  slow.deps.db = new Proxy(slow.deps.db, {
    get: (db, key) => (key === "execute" ? () => new Promise(() => {}) : Reflect.get(db, key)),
  });

  const pending = slow.app.request("/v1/health");
  await Bun.sleep(5);
  slow.clock.advance(3_000);

  expect((await pending).status).toBe(503);
  await slow.close();
});
