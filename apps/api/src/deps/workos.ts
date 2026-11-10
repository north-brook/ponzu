import type { Clock } from "@ponzu/sandbox";
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from "jose";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";

/*
 * WorkOS (AuthKit), on plain fetch: the handful of calls the API makes, shaped the way the
 * API uses them. The API key goes out as the client secret or the bearer and nowhere else.
 */

export interface WorkosUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** The GitHub user token WorkOS hands back with a GitHub sign-in. */
export interface WorkosOauthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token runs out, or null if it does not. */
  expiresAt: Date | null;
}

export interface WorkosSession {
  user: WorkosUser;
  /** A five-minute JWT the client sends on every request. */
  accessToken: string;
  /** What the client trades with WorkOS for the next access token. */
  refreshToken: string;
  /** Null when WorkOS did not return GitHub's tokens, or the sign-in was not through GitHub. */
  githubTokens: WorkosOauthTokens | null;
}

export type AuthenticateResult =
  | { kind: "session"; session: WorkosSession }
  /** WorkOS will not finish until the email is verified. The two ids finish it server-side. */
  | {
      kind: "email_verification_required";
      pendingAuthenticationToken: string;
      emailVerificationId: string;
    }
  | { kind: "invalid_code" }
  | { kind: "invalid_code_verifier" }
  /** WorkOS wants a step Ponzu does not offer. `reason` is WorkOS's own code, for the logs. */
  | { kind: "not_supported"; reason: string };

/** Who is signing in, as WorkOS wants it for its own risk checks. */
export interface CallerInfo {
  ipAddress?: string;
  userAgent?: string;
}

export interface Workos {
  /** The issuer of every access token (`iss`), and the `client_id` claim each must carry. */
  readonly issuer: string;
  readonly clientId: string;
  /** The keys access tokens are signed with, fetched once and kept. */
  readonly jwks: JWTVerifyGetKey;
  /** The server half of sign-in. The verifier is checked even though the API key is sent. */
  authenticateWithCode(
    input: { code: string; codeVerifier: string } & CallerInfo,
  ): Promise<AuthenticateResult>;
  /** The code WorkOS would have emailed for a pending verification. */
  getEmailVerificationCode(emailVerificationId: string): Promise<string>;
  authenticateWithEmailVerification(
    input: { code: string; pendingAuthenticationToken: string } & CallerInfo,
  ): Promise<AuthenticateResult>;
  /** Ends a session: its refresh token stops working. Revoking one already ended is not an error. */
  revokeSession(sessionId: string): Promise<void>;
}

const BASE_URL = "https://api.workos.com";
const TIMEOUT_MS = 10_000;

export function createWorkos({
  apiKey,
  clientId,
  fetch,
  clock,
}: {
  apiKey: string;
  clientId: string;
  fetch: Fetch;
  clock: Clock;
}): Workos {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          // The authenticate endpoint takes the key in its body instead.
          ...(path === "/user_management/authenticate"
            ? {}
            : { authorization: `Bearer ${apiKey}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamError("workos", `${method} ${path} did not answer`, { cause });
    }
  }

  async function authenticate(grant: Record<string, unknown>): Promise<AuthenticateResult> {
    const path = "/user_management/authenticate";
    const response = await call("POST", path, {
      client_id: clientId,
      client_secret: apiKey,
      ...grant,
    });
    const body = await readJson(response);
    if (response.ok) return { kind: "session", session: toSession(body) };

    // WorkOS names a failure in `code` or in `error`, depending on which family it is.
    const code = text(body.code) ?? text(body.error) ?? "";
    if (code === "email_verification_required") {
      const pendingAuthenticationToken = text(body.pending_authentication_token);
      const emailVerificationId = text(body.email_verification_id);
      if (pendingAuthenticationToken && emailVerificationId) {
        return {
          kind: "email_verification_required",
          pendingAuthenticationToken,
          emailVerificationId,
        };
      }
    }
    if (code === "invalid_grant") {
      // Only WorkOS's sentence tells the two apart, and it says "Invalid code verifier." of a
      // code it does not know as well as of a wrong verifier. A used code it names as used.
      return /code verifier/i.test(text(body.error_description) ?? "")
        ? { kind: "invalid_code_verifier" }
        : { kind: "invalid_code" };
    }
    if (response.status >= 400 && response.status < 500 && PENDING_STEPS.has(code)) {
      return { kind: "not_supported", reason: code };
    }
    throw new UpstreamError("workos", `POST ${path} answered ${response.status} ${safeCode(code)}`);
  }

  return {
    issuer: `${BASE_URL}/user_management/${clientId}`,
    clientId,
    jwks: createRemoteJWKSet(new URL(`${BASE_URL}/sso/jwks/${clientId}`), {
      [customFetch]: fetch,
      timeoutDuration: TIMEOUT_MS,
    }),

    authenticateWithCode: ({ code, codeVerifier, ipAddress, userAgent }) =>
      authenticate({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        ip_address: ipAddress,
        user_agent: userAgent,
      }),

    async getEmailVerificationCode(emailVerificationId) {
      const path = `/user_management/email_verification/${encodeURIComponent(emailVerificationId)}`;
      const response = await call("GET", path);
      const code = response.ok ? text((await readJson(response)).code) : undefined;
      if (!code) {
        throw new UpstreamError("workos", `GET email_verification answered ${response.status}`);
      }
      return code;
    },

    authenticateWithEmailVerification: ({
      code,
      pendingAuthenticationToken,
      ipAddress,
      userAgent,
    }) =>
      authenticate({
        grant_type: "urn:workos:oauth:grant-type:email-verification:code",
        code,
        pending_authentication_token: pendingAuthenticationToken,
        ip_address: ipAddress,
        user_agent: userAgent,
      }),

    async revokeSession(sessionId) {
      const path = "/user_management/sessions/revoke";
      const response = await call("POST", path, { session_id: sessionId });
      // Gone already is what was wanted.
      if (!response.ok && response.status !== 404) {
        throw new UpstreamError("workos", `POST ${path} answered ${response.status}`);
      }
    },
  };
}

/** The steps WorkOS can ask for in place of a session that Ponzu's sign-in has no screen for. */
const PENDING_STEPS = new Set([
  "email_verification_required",
  "mfa_enrollment",
  "mfa_challenge",
  "organization_selection_required",
  "sso_required",
  "organization_authentication_methods_required",
  "radar_email_challenge",
  "radar_sms_challenge",
]);

function toSession(body: Record<string, unknown>): WorkosSession {
  const user = record(body.user);
  const id = text(user.id);
  const email = text(user.email);
  const accessToken = text(body.access_token);
  const refreshToken = text(body.refresh_token);
  if (!id || !email || !accessToken || !refreshToken) {
    throw new UpstreamError("workos", "authenticate answered 200 without a user or its tokens");
  }
  return {
    user: { id, email, emailVerified: user.email_verified === true },
    accessToken,
    refreshToken,
    githubTokens: toGithubTokens(body.oauth_tokens),
  };
}

function toGithubTokens(value: unknown): WorkosOauthTokens | null {
  const tokens = record(value);
  const accessToken = text(tokens.access_token);
  // Seen spelled "GitHubOauth" here and "GitHubOAuth" in the authorize URL.
  if (!accessToken || text(tokens.provider)?.toLowerCase() !== "githuboauth") return null;
  return {
    accessToken,
    refreshToken: text(tokens.refresh_token) ?? null,
    expiresAt: toDate(tokens.expires_at),
  };
}

/**
 * WorkOS documents `expires_at` in seconds and sends it in milliseconds. Take either: no
 * token expires before 1973, which is what a seconds value read as milliseconds would say.
 */
function toDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value < 100_000_000_000 ? value * 1000 : value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** An upstream error code is an identifier. Anything else stays out of our logs. */
function safeCode(code: string): string {
  return /^[a-z_]{1,64}$/.test(code) ? code : "";
}
