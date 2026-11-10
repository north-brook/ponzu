import type { Clock } from "@ponzu/sandbox";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { Fetch } from "../deps/fetch.ts";

/*
 * WorkOS, in memory, at the HTTP boundary: the API's real WorkOS client talks to `fetch` here
 * and cannot tell. It issues real RS256 access tokens from a key made for the test run and
 * serves the matching JWKS, so token verification is the code that runs in production.
 *
 * It behaves as the live service was seen to: a code works once, a wrong verifier is refused
 * without spending the code, a code it never issued is refused as a wrong verifier, an
 * unverified email stops the exchange with 403 and the two ids that finish it, and GitHub's
 * tokens come back as `oauth_tokens` with `expires_at` in milliseconds and the provider
 * spelled "GitHubOauth". The verification leg was run against WorkOS staging with a password
 * user: the pending verification names its `user_id` and `code`, the email-verification grant
 * answers with a session that keeps the first leg's `authentication_method`, and deleting a
 * user answers 200, then 404.
 *
 * Two things it does have not been seen live, because they take a GitHub account whose address
 * WorkOS has not verified: that the second leg carries `oauth_tokens`, and that WorkOS stops
 * for verification before attaching a new identity to a user it has (`attachesIdentity`).
 */

export interface FakeWorkosUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** The GitHub tokens a sign-in carries back, as the fake GitHub issued them. */
export interface FakeOauthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface PendingSignIn {
  userId: string;
  /** Null to act out WorkOS not returning GitHub's tokens. */
  oauthTokens: FakeOauthTokens | null;
  authenticationMethod: string;
}

/** What the browser half of a sign-in ended with. */
export interface Authorization {
  codeVerifier: string;
  oauthTokens: FakeOauthTokens | null;
  /** How the person signed in at WorkOS. GitHub unless told otherwise. */
  authenticationMethod?: string;
  /**
   * The sign-in arrived with an identity the user does not have yet, under the user's
   * address: WorkOS stops for email verification before attaching it, though the user's own
   * address is already verified. (From WorkOS's documentation; not seen on the live service.)
   */
  attachesIdentity?: boolean;
}

export interface AccessTokenOverrides {
  issuer?: string;
  clientId?: string;
  /** Seconds from now. Negative for a token that has already run out. Null for no `exp` at all. */
  expiresIn?: number | null;
  /** Seconds from now that it says it was issued: positive for a clock ahead of the API's. */
  issuedIn?: number;
  /** `other-key`: a key WorkOS does not publish, under the published key's id. */
  signedWith?: "workos-key" | "other-key" | "shared-secret";
}

const KEY_ID = "sso_oidc_key_pair_test";
const ACCESS_TOKEN_SECONDS = 300;

// Making an RSA key takes a moment, so every fake in a test run shares these two.
const keys = Promise.all([
  generateKeyPair("RS256", { extractable: true }),
  generateKeyPair("RS256", { extractable: true }),
]);

export class FakeWorkos {
  readonly clientId = "client_test";
  readonly apiKey = "sk_test_fakeworkosapikey";
  readonly issuer = `https://api.workos.com/user_management/${this.clientId}`;

  /** Session id to whether it is still live. */
  readonly sessions = new Map<string, { userId: string; revoked: boolean }>();
  /** What the last authenticate call said about the caller. */
  lastCaller: { ipAddress: unknown; userAgent: unknown } | null = null;

  readonly #clock: Clock;
  readonly #users = new Map<string, FakeWorkosUser>();
  readonly #codes = new Map<
    string,
    PendingSignIn & { challenge: string; attachesIdentity: boolean }
  >();
  readonly #spent = new Set<string>();
  readonly #pending = new Map<string, PendingSignIn & { emailVerificationId: string }>();
  readonly #verifications = new Map<string, { userId: string; code: string }>();
  readonly #failures: { path: string; status: number; body: unknown }[] = [];
  #next = 1;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  addUser({ email, emailVerified = true }: { email: string; emailVerified?: boolean }) {
    const user = { id: `user_${this.#id()}`, email, emailVerified };
    this.#users.set(user.id, user);
    return user;
  }

  user(id: string): FakeWorkosUser {
    const user = this.#users.get(id);
    if (!user) throw new Error(`The fake WorkOS has no user ${id}.`);
    return user;
  }

  /** Whether the user still exists: the API deletes one it vouched for and then turned away. */
  hasUser(id: string): boolean {
    return this.#users.has(id);
  }

  /**
   * What the browser half of a sign-in ends with: an authorization code for `userId`, tied to
   * the PKCE verifier the app began with.
   */
  async authorize(
    userId: string,
    {
      codeVerifier,
      oauthTokens,
      authenticationMethod = "GitHubOAuth",
      attachesIdentity = false,
    }: Authorization,
  ): Promise<string> {
    const code = `code_${this.#id()}`;
    this.#codes.set(code, {
      userId,
      oauthTokens,
      authenticationMethod,
      attachesIdentity,
      challenge: await sha256(codeVerifier),
    });
    return code;
  }

  /** Makes the next request to `path` fail as if WorkOS itself were broken. */
  failNext(path: string, status = 500, body: unknown = { message: "Internal Server Error" }) {
    this.#failures.push({ path, status, body });
  }

  /** A signed access token for a session, or one that is wrong in the way `overrides` says. */
  async signAccessToken(
    { userId, sessionId }: { userId: string; sessionId: string },
    overrides: AccessTokenOverrides = {},
  ): Promise<string> {
    const [published, other] = await keys;
    const now = Math.floor(this.#clock.now() / 1000);
    const jwt = new SignJWT({ sid: sessionId, client_id: overrides.clientId ?? this.clientId })
      .setIssuer(overrides.issuer ?? this.issuer)
      .setSubject(userId)
      .setJti(this.#id())
      .setIssuedAt(now + (overrides.issuedIn ?? 0));
    if (overrides.expiresIn !== null) {
      jwt.setExpirationTime(
        now + (overrides.issuedIn ?? 0) + (overrides.expiresIn ?? ACCESS_TOKEN_SECONDS),
      );
    }
    if (overrides.signedWith === "shared-secret") {
      // The classic confusion attack: HS256, keyed with something the attacker knows.
      const secret = new TextEncoder().encode(JSON.stringify(await exportJWK(published.publicKey)));
      return jwt.setProtectedHeader({ alg: "HS256", kid: KEY_ID }).sign(secret);
    }
    const key = overrides.signedWith === "other-key" ? other : published;
    return jwt.setProtectedHeader({ alg: "RS256", kid: KEY_ID }).sign(key.privateKey);
  }

  /** Serves api.workos.com. Pass it to `createWorkos` as its `fetch`. */
  readonly fetch: Fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const failure = this.#failures.findIndex((queued) => queued.path === pathname);
    if (failure >= 0) {
      const { status, body } = this.#failures.splice(failure, 1)[0]!;
      return Response.json(body, { status });
    }

    if (method === "GET" && pathname === `/sso/jwks/${this.clientId}`) {
      const jwk: JWK = await exportJWK((await keys)[0].publicKey);
      return Response.json({ keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] });
    }
    if (method === "POST" && pathname === "/user_management/authenticate") {
      return this.#authenticate(JSON.parse(String(init.body)));
    }

    // Everything else is the management API, which wants the key as a bearer.
    if (new Headers(init.headers).get("authorization") !== `Bearer ${this.apiKey}`) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const verification = /^\/user_management\/email_verification\/([^/]+)$/.exec(pathname);
    if (method === "GET" && verification) {
      const id = decodeURIComponent(verification[1]!);
      const found = this.#verifications.get(id);
      if (!found) return Response.json({ message: "Not Found" }, { status: 404 });
      const { email } = this.user(found.userId);
      return Response.json({
        object: "email_verification",
        id,
        user_id: found.userId,
        email,
        code: found.code,
      });
    }
    if (method === "POST" && pathname === "/user_management/sessions/revoke") {
      const session = this.sessions.get(JSON.parse(String(init.body)).session_id);
      if (!session) return Response.json({ message: "Not Found" }, { status: 404 });
      session.revoked = true;
      return Response.json({});
    }
    const user = /^\/user_management\/users\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && user) {
      const id = decodeURIComponent(user[1]!);
      if (!this.#users.delete(id)) return Response.json({ message: "Not Found" }, { status: 404 });
      // Its sessions go with it.
      for (const session of this.sessions.values()) {
        if (session.userId === id) session.revoked = true;
      }
      return Response.json({});
    }
    return Response.json(
      { message: `The fake WorkOS has no ${method} ${pathname}.` },
      { status: 404 },
    );
  };

  async #authenticate(body: Record<string, unknown>): Promise<Response> {
    if (body.client_id !== this.clientId || body.client_secret !== this.apiKey) {
      return oauthError(400, "invalid_client", "Invalid client secret.");
    }
    this.lastCaller = { ipAddress: body.ip_address, userAgent: body.user_agent };

    if (body.grant_type === "authorization_code") {
      const code = String(body.code);
      if (this.#spent.has(code)) {
        return oauthError(400, "invalid_grant", `The code '${code}' has already been exchanged.`);
      }
      const signIn = this.#codes.get(code);
      // A code WorkOS never issued gets the verifier's error too, as long as one was sent:
      // there is no challenge for it to match. Seen on the live service.
      if (!signIn && body.code_verifier === undefined) {
        return oauthError(400, "invalid_grant", `The code '${code}' has expired or is invalid.`);
      }
      if (!signIn || (await sha256(String(body.code_verifier ?? ""))) !== signIn.challenge) {
        // The code is not spent: the right verifier still works afterwards.
        return oauthError(400, "invalid_grant", "Invalid code verifier.");
      }
      this.#codes.delete(code);
      this.#spent.add(code);
      const user = this.user(signIn.userId);
      if (!user.emailVerified || signIn.attachesIdentity) {
        const pendingAuthenticationToken = `pending_${this.#id()}`;
        const emailVerificationId = `email_verification_${this.#id()}`;
        this.#pending.set(pendingAuthenticationToken, { ...signIn, emailVerificationId });
        this.#verifications.set(emailVerificationId, { userId: user.id, code: "482913" });
        return Response.json(
          {
            code: "email_verification_required",
            message: "Email ownership must be verified before authentication.",
            pending_authentication_token: pendingAuthenticationToken,
            email: user.email,
            email_verification_id: emailVerificationId,
          },
          { status: 403 },
        );
      }
      return this.#session(signIn);
    }

    if (body.grant_type === "urn:workos:oauth:grant-type:email-verification:code") {
      const pending = this.#pending.get(String(body.pending_authentication_token));
      const verification = pending && this.#verifications.get(pending.emailVerificationId);
      if (!pending || !verification || verification.code !== body.code) {
        return oauthError(400, "invalid_grant", "Invalid email verification code.");
      }
      this.#pending.delete(String(body.pending_authentication_token));
      this.#verifications.delete(pending.emailVerificationId);
      this.user(pending.userId).emailVerified = true;
      return this.#session(pending);
    }
    return oauthError(400, "unsupported_grant_type", "Unsupported grant type.");
  }

  async #session({ userId, oauthTokens, authenticationMethod }: PendingSignIn): Promise<Response> {
    const user = this.user(userId);
    const sessionId = `session_${this.#id()}`;
    this.sessions.set(sessionId, { userId, revoked: false });
    return Response.json({
      user: {
        object: "user",
        id: user.id,
        email: user.email,
        email_verified: user.emailVerified,
        first_name: null,
        last_name: null,
        profile_picture_url: null,
      },
      access_token: await this.signAccessToken({ userId, sessionId }),
      refresh_token: `refresh${this.#id()}`,
      authentication_method: authenticationMethod,
      ...(oauthTokens
        ? {
            oauth_tokens: {
              provider: "GitHubOauth",
              access_token: oauthTokens.accessToken,
              refresh_token: oauthTokens.refreshToken,
              expires_at: oauthTokens.expiresAt,
              scopes: [""],
            },
          }
        : {}),
    });
  }

  #id(): string {
    return String(this.#next++).padStart(6, "0");
  }
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("base64url");
}
