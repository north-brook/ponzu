import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { githubUserTokens } from "../schema/index.ts";
import { run } from "./run.ts";

export type GithubUserToken = typeof githubUserTokens.$inferSelect;

/** A GitHub user token as it is stored: both halves already encrypted by the API. */
export interface StoredGithubUserToken {
  encryptedAccessToken: string;
  /** Null for a token that does not expire. */
  accessTokenExpiresAt: Date | null;
  encryptedRefreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/**
 * Keep the token a sign-in came back with, in place of whatever the person had. It also ends
 * any refresh in progress: the pair being refreshed is no longer the one stored.
 */
export async function saveGithubUserToken(
  db: Db,
  { userId, ...token }: StoredGithubUserToken & { userId: string },
): Promise<void> {
  await run(
    db
      .insert(githubUserTokens)
      .values({ userId, ...token })
      .onConflictDoUpdate({
        target: githubUserTokens.userId,
        set: { ...token, refreshClaimedUntil: null },
      }),
  );
}

/** Forget a person's GitHub token, once GitHub has stopped honoring it. */
export async function deleteGithubUserToken(db: Db, userId: string): Promise<void> {
  await run(db.delete(githubUserTokens).where(eq(githubUserTokens.userId, userId)));
}

export async function getGithubUserToken(db: Db, userId: string): Promise<GithubUserToken | null> {
  const [row] = await run(
    db.select().from(githubUserTokens).where(eq(githubUserTokens.userId, userId)),
  );
  return row ?? null;
}

/**
 * Take the right to refresh a person's token, until `until`. Answers the stored token if this
 * caller now holds the claim, and null if the token is not due (it expires after `staleAt`),
 * someone else holds a claim that has not run out at `now`, or there is no token.
 *
 * The times are the caller's, not the database's, so every instance of the API has to agree
 * on them to within the length of a claim; a claim outlasts any one refresh several times over.
 */
export async function claimGithubTokenRefresh(
  db: Db,
  { userId, now, staleAt, until }: { userId: string; now: Date; staleAt: Date; until: Date },
): Promise<GithubUserToken | null> {
  const [row] = await run(
    db
      .update(githubUserTokens)
      .set({ refreshClaimedUntil: until })
      .where(
        and(
          eq(githubUserTokens.userId, userId),
          lte(githubUserTokens.accessTokenExpiresAt, staleAt),
          or(
            isNull(githubUserTokens.refreshClaimedUntil),
            lte(githubUserTokens.refreshClaimedUntil, now),
          ),
        ),
      )
      .returning(),
  );
  return row ?? null;
}

/**
 * Store the pair GitHub gave in exchange for `replaces`, and end the claim. It answers false
 * and writes nothing if the stored refresh token is no longer `replaces`: the person signed in
 * again meanwhile, and that newer pair stays.
 */
export async function rotateGithubUserToken(
  db: Db,
  { userId, replaces, ...token }: StoredGithubUserToken & { userId: string; replaces: string },
): Promise<boolean> {
  const rotated = await run(
    db
      .update(githubUserTokens)
      .set({ ...token, refreshClaimedUntil: null })
      .where(
        and(
          eq(githubUserTokens.userId, userId),
          eq(githubUserTokens.encryptedRefreshToken, replaces),
        ),
      )
      .returning({ userId: githubUserTokens.userId }),
  );
  return rotated.length > 0;
}

/** Give up a claim taken with `claimGithubTokenRefresh`, if it is still this caller's. */
export async function releaseGithubTokenRefresh(
  db: Db,
  { userId, until }: { userId: string; until: Date },
): Promise<void> {
  await run(
    db
      .update(githubUserTokens)
      .set({ refreshClaimedUntil: null })
      .where(
        and(eq(githubUserTokens.userId, userId), eq(githubUserTokens.refreshClaimedUntil, until)),
      ),
  );
}
