import { deleteGithubUserToken, endUserSessions, getUserByGithubId } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import { githubUserToken } from "./user-token.ts";

/**
 * GitHub says a person revoked the App's authorization: the GitHub token Ponzu holds for them
 * is dead, and Ponzu can no longer act for them or check what they may reach. So their token
 * is forgotten and every session of theirs ends, and their next request is told to sign in
 * again (`session_unknown`), which is also how they authorize the App again.
 *
 * The webhook may be late: they may have signed in again since, with a token that works. So
 * GitHub is asked first, with the token held now, and only a token it refuses is forgotten.
 */
export async function forgetRevokedAuthorization(
  deps: Pick<Deps, "db" | "clock" | "vault" | "github" | "log">,
  githubUserId: number,
): Promise<void> {
  const { db, github, log } = deps;
  const user = await getUserByGithubId(db, githubUserId);
  if (!user) return;
  try {
    await github.getUser(await githubUserToken(deps, user.id));
    log.info("github_authorization_still_good", { userId: user.id });
    return;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "github_reauth_required")) throw error;
  }
  await deleteGithubUserToken(db, user.id);
  const sessionsEnded = await endUserSessions(db, user.id);
  log.info("github_authorization_revoked", { userId: user.id, sessionsEnded });
}
