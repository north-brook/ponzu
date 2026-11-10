import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { consumeAuthState, createAuthState } from "./auth-states.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const now = new Date("2026-11-10T12:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

test("a state is taken once, by whoever comes back first", async () => {
  const user = await seedUser(db);
  const state = await createAuthState(db, {
    kind: "github_install",
    userId: user.id,
    payload: { client: "mac" },
    expiresAt: later(15),
  });
  expect(state.id).toMatch(/^auth_/);

  const taken = await consumeAuthState(db, { id: state.id, kind: "github_install", now: later(1) });

  expect(taken).toMatchObject({
    userId: user.id,
    payload: { client: "mac" },
    consumedAt: later(1),
  });
  expect(await consumeAuthState(db, { id: state.id, kind: "github_install", now })).toBeNull();
});

test("a state that ran out, or of another kind, is nothing", async () => {
  const user = await seedUser(db);
  const state = await createAuthState(db, {
    kind: "github_install",
    userId: user.id,
    payload: {},
    expiresAt: later(15),
  });

  expect(await consumeAuthState(db, { id: state.id, kind: "claude_sign_in", now })).toBeNull();
  expect(await consumeAuthState(db, { id: state.id, kind: "github_install", now: later(15) })).toBe(
    null,
  );
  expect(await consumeAuthState(db, { id: "auth_nothing", kind: "github_install", now })).toBe(
    null,
  );
});
