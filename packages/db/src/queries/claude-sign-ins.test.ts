import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { getAuthState } from "./auth-states.ts";
import { openClaudeSignIn, setClaudeSignInSandbox } from "./claude-sign-ins.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000);
const open = (userId: string, minutes: number) =>
  openClaudeSignIn(db, {
    userId,
    now: at(minutes),
    expiresAt: at(minutes + 10),
    perHour: 3,
  });

test("a new sign-in replaces the open one, and hands back its sandbox", async () => {
  const user = await seedUser(db);
  const first = await open(user.id, 0);
  expect(first).toEqual({ id: expect.stringMatching(/^auth_/), replaced: [] });
  expect(await setClaudeSignInSandbox(db, { id: first!.id, sandboxId: "bx_1" })).toBe(true);

  const second = await open(user.id, 1);
  expect(second!.replaced).toEqual(["bx_1"]);
  const replaced = await getAuthState(db, {
    id: first!.id,
    kind: "claude_sign_in",
    userId: user.id,
  });
  expect(replaced!.consumedAt).toEqual(at(1));
  // The replaced one takes no sandbox now: the caller destroys the one it made.
  expect(await setClaudeSignInSandbox(db, { id: first!.id, sandboxId: "bx_2" })).toBe(false);
});

test("however many are started at once, one stays open", async () => {
  const user = await seedUser(db);
  await Promise.all([open(user.id, 0), open(user.id, 0), open(user.id, 0)]);
  const { rows } = (await db.execute(
    `select count(*)::int as open from auth_states
      where user_id = '${user.id}' and kind = 'claude_sign_in' and consumed_at is null`,
  )) as unknown as { rows: { open: number }[] };
  expect(rows).toEqual([{ open: 1 }]);
});

test("only so many start in an hour, open or not", async () => {
  const user = await seedUser(db);
  for (const minute of [0, 1, 2]) expect(await open(user.id, minute)).not.toBeNull();
  expect(await open(user.id, 3)).toBeNull();
  // An hour after the first, there is room for one more.
  expect(await open(user.id, 60.5)).not.toBeNull();
  expect(await open(user.id, 60.6)).toBeNull();
});
