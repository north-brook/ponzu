import { admitSession, getUserByWorkosId, QueryError, type User, upsertUser } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import type { AuthenticateResult, CallerInfo, WorkosSession } from "../deps/workos.ts";
import { storeGithubUserToken } from "../github/user-token.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../http/log.ts";

/*
 * The server half of sign-in. The app ran the authorization-code flow with PKCE in the system
 * browser and posts what came back; this trades it with WorkOS, decides whether the session
 * WorkOS made becomes a Ponzu one, and if so records the person, their GitHub token and the
 * session. See "Identity and access" in docs/cloud.md.
 *
 * Why the session is recorded: WorkOS will issue an access token to anyone who signs in with
 * it directly, without this code running, and the API finishes WorkOS's email verification on
 * the person's behalf, so WorkOS's own idea of who owns an address is weaker than it looks.
 * What Ponzu trusts is the check made here against GitHub. `access.user` honors a token only
 * for a session this function admitted.
 */

type SignInDeps = Pick<Deps, "db" | "clock" | "vault" | "workos" | "github">;

export interface SignedIn {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export async function signIn(
  deps: SignInDeps,
  log: Logger,
  input: { code: string; codeVerifier: string } & CallerInfo,
): Promise<SignedIn> {
  const { workos } = deps;
  const caller: CallerInfo = { ipAddress: input.ipAddress, userAgent: input.userAgent };

  let result = await workos.authenticateWithCode(input);
  let verifiedHere = false;
  if (result.kind === "email_verification_required") {
    // WorkOS wants the person to type a code it emailed. Nobody is asked to: the API reads the
    // code itself and finishes the sign-in, then asks GitHub (below) whether the address is
    // one it has verified, which is the check WorkOS will not take GitHub's word for.
    const code = await workos.getEmailVerificationCode(result.emailVerificationId);
    result = await workos.authenticateWithEmailVerification({
      code,
      pendingAuthenticationToken: result.pendingAuthenticationToken,
      ...caller,
    });
    verifiedHere = true;
  }
  const session = sessionFrom(result, log);

  try {
    const user = await admit(deps, session, verifiedHere);
    return { user, accessToken: session.accessToken, refreshToken: session.refreshToken };
  } catch (error) {
    // WorkOS has made a session that nobody will be handed. End it rather than leave it open.
    try {
      await workos.revokeSession(session.id);
    } catch (revokeError) {
      // The sign-in has already failed for its own reason; that is the one to report.
      log.warn("session_revoke_failed", { error: revokeError });
    }
    throw error;
  }
}

function sessionFrom(result: AuthenticateResult, log: Logger): WorkosSession {
  switch (result.kind) {
    case "session":
      return result.session;
    case "invalid_code":
      throw new ApiError(400, "invalid_code", "That sign-in was already used. Start again.");
    case "invalid_code_verifier":
      throw new ApiError(
        400,
        "invalid_code_verifier",
        "That sign-in has expired or did not start here. Start again.",
      );
    case "email_verification_required":
    case "not_supported": {
      const reason = result.kind === "not_supported" ? result.reason : result.kind;
      log.warn("sign_in_not_supported", { reason });
      throw new ApiError(403, "sign_in_not_supported", "Ponzu cannot finish this sign-in.");
    }
  }
}

/** Decide whether this WorkOS session becomes a Ponzu one, and if so record who it is. */
async function admit(
  deps: SignInDeps,
  session: WorkosSession,
  verifiedHere: boolean,
): Promise<User> {
  const { db, github } = deps;
  const tokens = session.githubTokens;
  if (!tokens) {
    // Without the GitHub token the account could sign in and then reach nothing.
    throw new ApiError(
      502,
      "github_token_missing",
      "Ponzu did not receive your GitHub sign-in. Try again.",
    );
  }
  // Who this is comes from GitHub, asked with the token this sign-in produced.
  const profile = await github.getUser(tokens.accessToken);

  // GitHub has to say the address is verified whenever the API verified it for WorkOS itself,
  // the first time a WorkOS user is let in, and when their address has changed. Someone let in
  // before under the same address passed this then, and is not locked out for tidying their
  // GitHub emails since.
  const known = await getUserByWorkosId(db, session.user.id);
  if (verifiedHere || known?.email !== session.user.email) {
    const emails = await github.listEmails(tokens.accessToken);
    const address = session.user.email.toLowerCase();
    if (!emails.some((entry) => entry.verified && entry.email.toLowerCase() === address)) {
      throw new ApiError(
        403,
        "email_not_verified",
        "Verify your email address on GitHub, then sign in again.",
      );
    }
  }

  let user: User;
  try {
    user = await upsertUser(db, {
      workosUserId: session.user.id,
      githubUserId: profile.id,
      githubLogin: profile.login,
      name: profile.name,
      email: session.user.email,
      avatarUrl: profile.avatarUrl,
    });
  } catch (cause) {
    // One WorkOS user is one GitHub account, and the database holds it to that. This is what
    // refuses a second GitHub account that WorkOS has attached to someone else's user.
    if (cause instanceof QueryError && cause.message.includes("users_workos_user_id_unique")) {
      throw new ApiError(
        409,
        "identity_conflict",
        "This sign-in belongs to a different GitHub account.",
        { cause },
      );
    }
    throw cause;
  }
  await storeGithubUserToken(deps, user.id, {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: null,
  });
  await admitSession(db, { id: session.id, userId: user.id });
  return user;
}
