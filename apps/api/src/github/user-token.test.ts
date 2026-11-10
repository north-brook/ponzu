import { afterAll, beforeAll, expect, test } from "bun:test";
import { claimGithubTokenRefresh, getGithubUserToken, saveGithubUserToken } from "@ponzu/db";
import { ApiError, UpstreamError } from "../http/errors.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";
import { githubUserToken, storeGithubUserToken } from "./user-token.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const HOURS = 3600_000;
let people = 0;
/** Someone new, signed in now: their GitHub token runs out in eight hours. */
const someone = () => t.signInAs({ login: `person${String.fromCharCode(97 + people++)}` });

const stored = async (person: SignedInPerson) => (await getGithubUserToken(t.db, person.userId))!;
const openRefreshToken = async (person: SignedInPerson) =>
  t.deps.vault.open((await stored(person)).encryptedRefreshToken!, {
    column: "github_user_tokens.refresh_token",
    row: person.userId,
  });

/** Holds GitHub's answer to the next refresh until `release` is called. */
function holdRefresh() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.github.duringRefresh = () => held;
  return () => {
    t.github.duringRefresh = null;
    release();
  };
}

/** Lets everything already in flight run until it is waiting on the clock or on GitHub. */
const settle = () => Bun.sleep(20);

/**
 * The app's dependencies as a separate function instance has them, sharing only the database
 * and GitHub. Waiting takes real time here and no test time: the test clock's own `sleep` jumps
 * ahead, which would run a waiting caller out of patience before the caller it waits for has
 * had a turn.
 */
const instance = (): TestApp["deps"] => ({
  ...t.deps,
  clock: {
    now: () => t.clock.now(),
    timeout: (ms) => t.clock.timeout(ms),
    sleep: () => Bun.sleep(1),
  },
});

test("a token with time left is handed over as it is, without a word to GitHub", async () => {
  const person = await someone();
  const attempts = t.github.refreshAttempts;

  const token = await githubUserToken(t.deps, person.userId);

  expect(token).toStartWith("ghu_");
  expect(t.github.accepts(token)).toBe(true);
  t.clock.advance(7 * HOURS + 54 * 60_000);
  expect(await githubUserToken(t.deps, person.userId)).toBe(token);
  expect(t.github.refreshAttempts).toBe(attempts);
});

test("a token within five minutes of running out is refreshed, and the rotated pair is stored", async () => {
  const person = await someone();
  const old = await githubUserToken(t.deps, person.userId);
  const oldRefresh = await openRefreshToken(person);
  t.clock.advance(7 * HOURS + 56 * 60_000);

  const fresh = await githubUserToken(t.deps, person.userId);

  expect(fresh).not.toBe(old);
  expect(t.github.accepts(fresh)).toBe(true);
  const row = await stored(person);
  expect(row.accessTokenExpiresAt!.getTime()).toBe(t.clock.now() + 8 * HOURS);
  expect(row.refreshTokenExpiresAt!.getTime()).toBe(t.clock.now() + 15_897_600_000);
  expect(row.refreshClaimedUntil).toBeNull();
  expect(await openRefreshToken(person)).not.toBe(oldRefresh);
  // And the next caller gets the stored one.
  expect(await githubUserToken(t.deps, person.userId)).toBe(fresh);
});

test("two callers at once make one refresh, and both get the new token", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  const attempts = t.github.refreshAttempts;
  const release = holdRefresh();

  const callers = [
    githubUserToken(instance(), person.userId),
    githubUserToken(instance(), person.userId),
  ];
  // One is now waiting on GitHub and the other on the first.
  await settle();
  expect(t.github.refreshAttempts).toBe(attempts + 1);
  release();
  const [first, second] = await Promise.all(callers);

  expect(first).toBe(second);
  expect(t.github.accepts(first!)).toBe(true);
  expect(t.github.refreshAttempts).toBe(attempts + 1);
  expect((await stored(person)).refreshClaimedUntil).toBeNull();
});

test("many callers at once still make one refresh", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  const attempts = t.github.refreshAttempts;
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => githubUserToken(instance(), person.userId)),
  );

  expect(new Set(tokens).size).toBe(1);
  expect(t.github.refreshAttempts).toBe(attempts + 1);
});

test("a caller waits only so long for someone else's refresh", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  const release = holdRefresh();
  const holder = githubUserToken(t.deps, person.userId);
  await settle();

  // The second caller's waiting moves the test clock, so its patience runs out at once. The
  // claim outlasts it (30 s against 15), so it never sends the refresh token itself.
  const attempts = t.github.refreshAttempts;
  await expect(githubUserToken(t.deps, person.userId)).rejects.toBeInstanceOf(UpstreamError);
  expect(t.github.refreshAttempts).toBe(attempts);

  release();
  expect(t.github.accepts(await holder)).toBe(true);
});

test("a holder that died is taken over once its claim runs out", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  // Someone claimed the refresh and was never heard from again.
  const now = t.clock.now();
  const abandoned = await claimGithubTokenRefresh(t.db, {
    userId: person.userId,
    now: new Date(now),
    staleAt: new Date(now),
    until: new Date(now + 30_000),
  });
  expect(abandoned).not.toBeNull();
  t.clock.advance(30_000);

  const token = await githubUserToken(t.deps, person.userId);

  expect(t.github.accepts(token)).toBe(true);
});

test("losing the race to a sign-in is not being cut off: the newer pair is used", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  let signedInAgain: string | undefined;
  // While this refresh is with GitHub, the person signs in on another device.
  t.github.duringRefresh = async () => {
    t.github.duringRefresh = null;
    const tokens = t.github.issueTokens(person.github.id);
    signedInAgain = tokens.accessToken;
    await storeGithubUserToken(t.deps, person.userId, {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(tokens.expiresAt),
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: null,
    });
  };

  const token = await githubUserToken(t.deps, person.userId);

  expect(token).toBe(signedInAgain!);
  // The refresh's own pair was not written over the sign-in's.
  const row = await stored(person);
  expect(
    await t.deps.vault.open(row.encryptedAccessToken, {
      column: "github_user_tokens.access_token",
      row: person.userId,
    }),
  ).toBe(signedInAgain!);
});

test("a refresh token GitHub has already spent, with a newer pair stored meanwhile, uses that pair", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  const spent = await openRefreshToken(person);
  // Another instance refreshed with the same token a moment ago and is about to store its pair.
  const theirs = await t.deps.github.refreshUserToken(spent);
  if (theirs.kind !== "refreshed") throw new Error("expected a refresh");
  t.github.duringRefresh = async () => {
    t.github.duringRefresh = null;
    await storeGithubUserToken(t.deps, person.userId, theirs.tokens);
  };

  const token = await githubUserToken(t.deps, person.userId);

  expect(token).toBe(theirs.tokens.accessToken);
});

test("a refusal heard while the first holder is still storing its pair waits for that pair", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  // A holder whose claim ran out has traded the refresh token and not yet stored what it got.
  const theirs = await t.deps.github.refreshUserToken(await openRefreshToken(person));
  if (theirs.kind !== "refreshed") throw new Error("expected a refresh");
  // It lands while this caller, refused by GitHub, is giving it a moment.
  const deps: TestApp["deps"] = {
    ...t.deps,
    clock: {
      now: () => t.clock.now(),
      timeout: (ms) => t.clock.timeout(ms),
      sleep: () => storeGithubUserToken(t.deps, person.userId, theirs.tokens),
    },
  };

  const token = await githubUserToken(deps, person.userId);

  expect(token).toBe(theirs.tokens.accessToken);
  expect((await stored(person)).refreshClaimedUntil).toBeNull();
});

/** The database, except that the statements `fails` picks (counting updates from 1) never arrive. */
function withFailingUpdates(fails: (update: number) => boolean): TestApp["db"] {
  let updates = 0;
  return new Proxy(t.db, {
    get(db, property) {
      if (property === "update" && fails(++updates)) {
        return () => {
          throw new Error("fetch failed");
        };
      }
      const value = Reflect.get(db, property, db);
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
}

test("a rotated pair whose store fails once is stored on the next try", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  const attempts = t.github.refreshAttempts;
  // The first update is the claim. The second is the store, after GitHub has already ended
  // the old pair: the new one exists nowhere but in this call.
  const db = withFailingUpdates((update) => update === 2);

  const token = await githubUserToken({ ...t.deps, db }, person.userId);

  expect(t.github.accepts(token)).toBe(true);
  expect(t.github.refreshAttempts).toBe(attempts + 1);
  const row = await stored(person);
  expect(row.refreshClaimedUntil).toBeNull();
  expect(
    await t.deps.vault.open(row.encryptedAccessToken, {
      column: "github_user_tokens.access_token",
      row: person.userId,
    }),
  ).toBe(token);
  // The person is not stranded: the stored refresh token is the live one.
  t.clock.advance(8 * HOURS);
  expect(t.github.accepts(await githubUserToken(t.deps, person.userId))).toBe(true);
  expect(t.logs.findLast((line) => line.event === "github_token_store_retry")).toMatchObject({
    level: "warn",
    userId: person.userId,
    attempt: 1,
  });
});

test("a rotated pair that cannot be stored at all is reported, with whose it was", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  // The claim, then five tries at the store. The release that follows gets through.
  const db = withFailingUpdates((update) => update >= 2 && update <= 6);

  await expect(githubUserToken({ ...t.deps, db }, person.userId)).rejects.toThrow("fetch failed");

  expect(t.logs.findLast((line) => line.event === "github_token_rotation_lost")).toMatchObject({
    level: "error",
    userId: person.userId,
  });
  // The claim is given up, so the next caller learns at once that only signing in again helps.
  expect((await stored(person)).refreshClaimedUntil).toBeNull();
  await expect(githubUserToken(t.deps, person.userId)).rejects.toMatchObject({
    code: "github_reauth_required",
  });
});

test("a refresh token GitHub refuses, with nothing newer stored: github_reauth_required", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  t.github.revokeTokens(person.github.id);

  const error = await githubUserToken(t.deps, person.userId).catch((thrown) => thrown);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 401, code: "github_reauth_required" });
  // The claim is given up, so the next attempt does not wait on it; signing in again mends it.
  expect((await stored(person)).refreshClaimedUntil).toBeNull();
  const again = await t.signInAs({ login: person.github.login });
  expect(t.github.accepts(await githubUserToken(t.deps, again.userId))).toBe(true);
});

test("GitHub not answering leaves the refresh token unspent for the next caller", async () => {
  const person = await someone();
  t.clock.advance(8 * HOURS);
  t.github.failNext("/login/oauth/access_token", 503);

  await expect(githubUserToken(t.deps, person.userId)).rejects.toBeInstanceOf(UpstreamError);

  expect((await stored(person)).refreshClaimedUntil).toBeNull();
  expect(t.github.accepts(await githubUserToken(t.deps, person.userId))).toBe(true);
});

test("someone with no stored token, or an expired one that cannot be refreshed: github_reauth_required", async () => {
  await expect(githubUserToken(t.deps, "usr_nobody")).rejects.toMatchObject({
    code: "github_reauth_required",
  });

  const person = await someone();
  await saveGithubUserToken(t.db, {
    userId: person.userId,
    encryptedAccessToken: (await stored(person)).encryptedAccessToken,
    accessTokenExpiresAt: new Date(t.clock.now() - 1),
    encryptedRefreshToken: null,
    refreshTokenExpiresAt: null,
  });
  await expect(githubUserToken(t.deps, person.userId)).rejects.toMatchObject({
    code: "github_reauth_required",
  });
});

test("a token that never expires is never refreshed", async () => {
  const person = await someone();
  const tokens = t.github.issueTokens(person.github.id);
  await storeGithubUserToken(t.deps, person.userId, {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  });
  t.clock.advance(1000 * HOURS);

  expect(await githubUserToken(t.deps, person.userId)).toBe(tokens.accessToken);
});

test("one person's stored token does not open as another's", async () => {
  const [maya, ines] = [await someone(), await someone()];
  const mayas = await stored(maya);
  await saveGithubUserToken(t.db, { ...mayas, userId: ines.userId });

  await expect(githubUserToken(t.deps, ines.userId)).rejects.toThrow(
    /altered or belongs elsewhere/,
  );
});
