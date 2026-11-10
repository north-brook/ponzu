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
 * WorkOS is not what decides who someone is. It will issue an access token to anyone who
 * signs in with it directly, without this code running, and it joins accounts by email
 * address. What Ponzu trusts is the check made here against GitHub, and `authenticateUser`
 * honors a token only for a session this function admitted.
 *
 * The delicate part is email verification. WorkOS stops a sign-in until the address is
 * verified and will not take GitHub's word for it, so the API finishes that step itself and
 * asks GitHub afterwards (GitHub's token only arrives with the finished sign-in). Finishing it
 * vouches for the address to WorkOS, so two rules bound what that can do:
 *
 * - The API never vouches on behalf of a WorkOS user who is already a Ponzu person. WorkOS
 *   asks for this step before it attaches a new identity to a user it has, and nothing says
 *   whose identity is asking until the step is done.
 * - When it has vouched and then does not let the person in, it takes that back by deleting
 *   the WorkOS user, so no address stays verified, and no identity attached, on its word alone.
 */

type SignInDeps = Pick<Deps, "db" | "clock" | "vault" | "workos" | "github">;

export interface SignedIn {
  user: User;
  accessToken: string;
  refreshToken: string;
}

const emailNotVerified = () =>
  new ApiError(
    403,
    "email_not_verified",
    "Verify your email address on GitHub, then sign in again.",
  );

export async function signIn(
  deps: SignInDeps,
  log: Logger,
  input: { code: string; codeVerifier: string } & CallerInfo,
): Promise<SignedIn> {
  const { db, workos } = deps;
  let session: WorkosSession | undefined;
  /** The WorkOS user whose address the API verified in this sign-in, if it did. */
  let vouchedFor: string | undefined;

  try {
    let result = await workos.authenticateWithCode(input);
    if (result.kind === "email_verification_required") {
      const verification = await workos.getEmailVerification(result.emailVerificationId);
      if (await getUserByWorkosId(db, verification.userId)) {
        // Answered exactly as an address GitHub has not verified is, so the answer does not
        // say whether the address has an account.
        log.warn("email_verification_refused", { workosUserId: verification.userId });
        throw emailNotVerified();
      }
      vouchedFor = verification.userId;
      result = await workos.authenticateWithEmailVerification({
        code: verification.code,
        pendingAuthenticationToken: result.pendingAuthenticationToken,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    }
    session = sessionFrom(result, log);
    const user = await admit(deps, log, session, vouchedFor !== undefined);
    return { user, accessToken: session.accessToken, refreshToken: session.refreshToken };
  } catch (error) {
    await withdraw(deps, log, { session, vouchedFor });
    throw error;
  }
}

/**
 * Undo what a sign-in that failed left at WorkOS. Whatever goes wrong here is logged and not
 * thrown: the sign-in has already failed for its own reason, and that is the one to report.
 */
async function withdraw(
  { db, workos }: SignInDeps,
  log: Logger,
  { session, vouchedFor }: { session?: WorkosSession; vouchedFor?: string },
): Promise<void> {
  if (session) {
    // WorkOS has made a session that nobody will be handed.
    try {
      await workos.revokeSession(session.id);
    } catch (error) {
      log.warn("session_revoke_failed", { error });
    }
  }
  if (vouchedFor) {
    try {
      // Unless someone was let in as this WorkOS user meanwhile: then it is theirs to keep.
      if (!(await getUserByWorkosId(db, vouchedFor))) await workos.deleteUser(vouchedFor);
    } catch (error) {
      // WorkOS still counts the address as verified. Admission is what keeps that harmless.
      log.error("email_verification_not_withdrawn", { workosUserId: vouchedFor, error });
    }
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
    case "not_supported":
      throw notSupported(log, result.kind === "not_supported" ? result.reason : result.kind);
  }
}

function notSupported(log: Logger, reason: string): ApiError {
  log.warn("sign_in_not_supported", { reason });
  return new ApiError(403, "sign_in_not_supported", "Ponzu cannot finish this sign-in.");
}

/** Decide whether this WorkOS session becomes a Ponzu one, and if so record who it is. */
async function admit(
  deps: SignInDeps,
  log: Logger,
  session: WorkosSession,
  vouched: boolean,
): Promise<User> {
  const { db, github } = deps;
  const tokens = session.githubTokens;
  if (!tokens) {
    // WorkOS offers other ways to sign in (a password, a magic link) and anyone can pick one.
    // That is the caller's doing, not a failure of ours.
    const method = session.authenticationMethod;
    if (method !== null && method.toLowerCase() !== "githuboauth") {
      throw notSupported(log, `authentication_method_${method.toLowerCase()}`);
    }
    // A GitHub sign-in without its token: the account could sign in and then reach nothing.
    throw new ApiError(
      502,
      "github_token_missing",
      "Ponzu did not receive your GitHub sign-in. Try again.",
    );
  }
  // Who this is comes from GitHub, asked with the token this sign-in produced.
  const profile = await github.getUser(tokens.accessToken);

  // GitHub has to say the address is verified unless this GitHub account was let in before as
  // this WorkOS user under this address. So it is asked whenever the API vouched for the
  // address itself, the first time a WorkOS user is let in, when their address has changed,
  // and when the GitHub account is not the one the WorkOS user belongs to. Someone let in
  // before passed this then, and is not locked out for tidying their GitHub emails since.
  const known = await getUserByWorkosId(db, session.user.id);
  const letInBefore =
    known?.githubUserId === profile.id && known.email === session.user.email && !vouched;
  if (!letInBefore) {
    const emails = await github.listEmails(tokens.accessToken);
    const address = session.user.email.toLowerCase();
    if (!emails.some((entry) => entry.verified && entry.email.toLowerCase() === address)) {
      throw emailNotVerified();
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
    // One WorkOS user is one GitHub account, and the database holds it to that. Reaching here
    // takes a second GitHub account that has verified the same address, so the answer tells
    // nobody anything about an address that is not theirs.
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
