import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import {
  claimGithubTokenRefresh,
  getGithubUserToken,
  releaseGithubTokenRefresh,
  rotateGithubUserToken,
  saveGithubUserToken,
} from "./github-tokens.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

/** A person whose access token runs out an hour after `at(0)`. */
async function seedToken() {
  const user = await seedUser(db);
  await saveGithubUserToken(db, {
    userId: user.id,
    encryptedAccessToken: "access-1",
    accessTokenExpiresAt: at(3600),
    encryptedRefreshToken: "refresh-1",
    refreshTokenExpiresAt: null,
  });
  return user.id;
}

/** A claim made at `now` by a caller who refreshes anything expiring within five minutes. */
const claim = (userId: string, now: number) =>
  claimGithubTokenRefresh(db, {
    userId,
    now: at(now),
    staleAt: at(now + 300),
    until: at(now + 30),
  });

test("a sign-in stores the token, and the next one replaces it", async () => {
  const userId = await seedToken();
  expect(await getGithubUserToken(db, userId)).toMatchObject({
    encryptedAccessToken: "access-1",
    accessTokenExpiresAt: at(3600),
    encryptedRefreshToken: "refresh-1",
    refreshClaimedUntil: null,
  });

  await saveGithubUserToken(db, {
    userId,
    encryptedAccessToken: "access-2",
    accessTokenExpiresAt: null,
    encryptedRefreshToken: null,
    refreshTokenExpiresAt: null,
  });

  expect(await getGithubUserToken(db, userId)).toMatchObject({
    encryptedAccessToken: "access-2",
    accessTokenExpiresAt: null,
    encryptedRefreshToken: null,
  });
  expect(await getGithubUserToken(db, "usr_nobody")).toBeNull();
});

test("a token that is not due cannot be claimed", async () => {
  const userId = await seedToken();
  expect(await claim(userId, 0)).toBeNull();
  expect(await claim("usr_nobody", 3600)).toBeNull();
});

test("one caller holds the claim until it runs out or is released", async () => {
  const userId = await seedToken();

  const first = await claim(userId, 3400);
  expect(first).toMatchObject({
    encryptedRefreshToken: "refresh-1",
    refreshClaimedUntil: at(3430),
  });
  expect(await claim(userId, 3401)).toBeNull();

  // The holder died: its claim runs out and the next caller takes over.
  expect(await claim(userId, 3430)).toMatchObject({ refreshClaimedUntil: at(3460) });

  // Releasing a claim that has since passed to someone else leaves theirs alone.
  await releaseGithubTokenRefresh(db, { userId, until: at(3430) });
  expect(await claim(userId, 3431)).toBeNull();
  await releaseGithubTokenRefresh(db, { userId, until: at(3460) });
  expect(await claim(userId, 3431)).not.toBeNull();
});

test("rotating stores the new pair, ends the claim, and makes the token not due", async () => {
  const userId = await seedToken();
  await claim(userId, 3400);

  const rotated = await rotateGithubUserToken(db, {
    userId,
    replaces: "refresh-1",
    encryptedAccessToken: "access-2",
    accessTokenExpiresAt: at(3400 + 28800),
    encryptedRefreshToken: "refresh-2",
    refreshTokenExpiresAt: at(15897600),
  });

  expect(rotated).toBe(true);
  expect(await getGithubUserToken(db, userId)).toMatchObject({
    encryptedAccessToken: "access-2",
    encryptedRefreshToken: "refresh-2",
    refreshTokenExpiresAt: at(15897600),
    refreshClaimedUntil: null,
  });
  expect(await claim(userId, 3401)).toBeNull();
});

test("a rotation loses to a sign-in that replaced the pair meanwhile", async () => {
  const userId = await seedToken();
  await claim(userId, 3400);
  await saveGithubUserToken(db, {
    userId,
    encryptedAccessToken: "access-signed-in",
    accessTokenExpiresAt: at(3400 + 28800),
    encryptedRefreshToken: "refresh-signed-in",
    refreshTokenExpiresAt: null,
  });

  const rotated = await rotateGithubUserToken(db, {
    userId,
    replaces: "refresh-1",
    encryptedAccessToken: "access-2",
    accessTokenExpiresAt: at(3400 + 28800),
    encryptedRefreshToken: "refresh-2",
    refreshTokenExpiresAt: null,
  });

  expect(rotated).toBe(false);
  expect(await getGithubUserToken(db, userId)).toMatchObject({
    encryptedAccessToken: "access-signed-in",
    encryptedRefreshToken: "refresh-signed-in",
    refreshClaimedUntil: null,
  });
});
