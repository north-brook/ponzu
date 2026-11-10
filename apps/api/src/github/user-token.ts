import {
  claimGithubTokenRefresh,
  type GithubUserToken,
  getGithubUserToken,
  releaseGithubTokenRefresh,
  rotateGithubUserToken,
  saveGithubUserToken,
} from "@ponzu/db";
import type { GithubTokenPair } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError, UpstreamError } from "../http/errors.ts";
import type { Binding } from "../vault/vault.ts";

/*
 * A person's GitHub user token: stored at sign-in, handed to the code that asks GitHub what
 * they can reach, and refreshed here when it is about to run out.
 *
 * The access token lasts eight hours and its refresh token works exactly once, with no grace
 * period: GitHub answers a refresh with a new pair and the old pair is dead. Two function
 * instances that both sent the same refresh token would leave one of them holding nothing,
 * so the refresh is claimed in the token's row first and whoever does not get the claim waits
 * for the one who did.
 */

/** Refresh a token this close to running out, so the caller has time to use what it gets. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long one caller may hold the refresh. GitHub is given ten seconds to answer. */
const CLAIM_MS = 30_000;
/** How long to wait for someone else's refresh before giving up. */
const WAIT_MS = 15_000;
const WAIT_STEP_MS = 250;
/** The waits between tries at storing a rotated pair: five tries over about eight seconds. */
const STORE_RETRY_MS = [500, 1_000, 2_000, 4_000];
/** When to look for a newer pair after GitHub refuses a refresh token: now, and twice more. */
const NEWER_PAIR_WAITS_MS = [0, 400, 800];

type UserTokenDeps = Pick<Deps, "db" | "clock" | "vault" | "github" | "log">;

const binding = (column: "access_token" | "refresh_token", userId: string): Binding => ({
  column: `github_user_tokens.${column}`,
  row: userId,
});

/** The pair a sign-in or a refresh produced, encrypted and bound to the person. */
async function seal({ vault }: Pick<Deps, "vault">, userId: string, tokens: GithubTokenPair) {
  return {
    userId,
    encryptedAccessToken: await vault.seal(tokens.accessToken, binding("access_token", userId)),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    encryptedRefreshToken:
      tokens.refreshToken === null
        ? null
        : await vault.seal(tokens.refreshToken, binding("refresh_token", userId)),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

/** Keep the GitHub tokens a sign-in came back with, in place of any the person had. */
export async function storeGithubUserToken(
  deps: Pick<Deps, "db" | "vault">,
  userId: string,
  tokens: GithubTokenPair,
): Promise<void> {
  await saveGithubUserToken(deps.db, await seal(deps, userId, tokens));
}

const reauthRequired = () =>
  new ApiError(401, "github_reauth_required", "Sign in again to reconnect GitHub.");

/**
 * A GitHub user token for `userId` that is good for at least five more minutes. Use it for
 * the calls at hand and ask again next time: never keep one.
 *
 * It throws `github_reauth_required` when there is no token to give and no way to get one
 * (the person never signed in here, or GitHub no longer takes their refresh token); the
 * client's answer to that is to sign in again.
 */
export async function githubUserToken(deps: UserTokenDeps, userId: string): Promise<string> {
  const { db, clock, vault } = deps;
  const deadline = clock.now() + WAIT_MS;

  for (;;) {
    const now = clock.now();
    const claim = {
      userId,
      now: new Date(now),
      staleAt: new Date(now + REFRESH_MARGIN_MS),
      until: new Date(now + CLAIM_MS),
    };
    const claimed = await claimGithubTokenRefresh(db, claim);
    if (claimed) return refresh(deps, claimed, claim.until);

    // No claim: the token is fresh, or someone else is refreshing it, or there is none.
    const stored = await getGithubUserToken(db, userId);
    if (!stored) throw reauthRequired();
    if (isFresh(stored, now)) {
      return vault.open(stored.encryptedAccessToken, binding("access_token", userId));
    }
    if (now >= deadline) {
      throw new UpstreamError("github", "gave up waiting for another refresh of the user token");
    }
    await clock.sleep(WAIT_STEP_MS);
  }
}

function isFresh(token: GithubUserToken, now: number): boolean {
  const expiresAt = token.accessTokenExpiresAt;
  return expiresAt === null || expiresAt.getTime() > now + REFRESH_MARGIN_MS;
}

/** With the claim held: trade the refresh token for a new pair and store it. */
async function refresh(deps: UserTokenDeps, held: GithubUserToken, until: Date): Promise<string> {
  const { db, vault, github } = deps;
  const { userId } = held;
  const replaces = held.encryptedRefreshToken;
  const release = () => releaseGithubTokenRefresh(db, { userId, until });

  if (replaces === null) {
    await release();
    throw reauthRequired();
  }
  let result: Awaited<ReturnType<typeof github.refreshUserToken>>;
  try {
    result = await github.refreshUserToken(
      await vault.open(replaces, binding("refresh_token", userId)),
    );
  } catch (error) {
    // GitHub did not answer, so the refresh token may still be good: let the next caller try.
    await release();
    throw error;
  }

  if (result.kind === "refreshed") {
    if (await storeRotated(deps, userId, result.tokens, replaces, release)) {
      return result.tokens.accessToken;
    }
    // The row no longer held the token that was traded: a sign-in stored a newer pair while
    // this ran (or an earlier attempt to store this one landed after all). What is stored now
    // is the pair to use.
    const stored = await getGithubUserToken(db, userId);
    if (!stored) throw reauthRequired();
    return vault.open(stored.encryptedAccessToken, binding("access_token", userId));
  }

  // GitHub refused the refresh token. That is how it answers a token it has already traded,
  // which happens when this caller took over a claim whose first holder was slow, not dead:
  // GitHub has given that holder the new pair and it is about to store it. So wait a moment
  // for a newer pair before deciding. Only if the row still holds the token GitHub refused is
  // the person really cut off.
  const newer = await newerPair(deps, held);
  await release();
  if (!newer) throw reauthRequired();
  return vault.open(newer.encryptedAccessToken, binding("access_token", userId));
}

/**
 * Store the pair GitHub just gave in exchange for `replaces`. GitHub ended the old pair as it
 * answered, so until this lands the pair exists nowhere else, and one failed statement would
 * cost the person their GitHub connection. It is tried again for as long as a claim lasts.
 * Answers false if the row no longer holds `replaces` (see `rotateGithubUserToken`).
 */
async function storeRotated(
  deps: UserTokenDeps,
  userId: string,
  tokens: GithubTokenPair,
  replaces: string,
  release: () => Promise<void>,
): Promise<boolean> {
  const { db, clock, log } = deps;
  try {
    // Sealed once: every attempt writes the same ciphertext, so one that landed without its
    // answer arriving is recognized by the next.
    const sealed = await seal(deps, userId, tokens);
    for (let attempt = 0; ; attempt++) {
      try {
        return await rotateGithubUserToken(db, { ...sealed, replaces });
      } catch (error) {
        const wait = STORE_RETRY_MS[attempt];
        if (wait === undefined) throw error;
        log.warn("github_token_store_retry", { userId, attempt: attempt + 1, error });
        await clock.sleep(wait);
      }
    }
  } catch (error) {
    // The pair is gone and the stored refresh token is dead: the person has to sign in again.
    log.error("github_token_rotation_lost", { userId, error });
    // So the next caller finds that out from GitHub now, not after waiting out this claim.
    await release().catch(() => {});
    throw error;
  }
}

/** The pair stored for a person since `held` was read, giving one on its way a moment to land. */
async function newerPair(
  { db, clock }: UserTokenDeps,
  held: GithubUserToken,
): Promise<GithubUserToken | null> {
  for (const wait of NEWER_PAIR_WAITS_MS) {
    if (wait > 0) await clock.sleep(wait);
    const stored = await getGithubUserToken(db, held.userId);
    if (!stored) return null;
    if (stored.encryptedRefreshToken !== held.encryptedRefreshToken) return stored;
  }
  return null;
}
