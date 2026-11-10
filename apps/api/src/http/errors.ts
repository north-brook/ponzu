import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every code an error body can carry. Clients branch on these, so one is never renamed or
 * reused; a new failure a client must tell apart gets a new code here.
 */
export type ErrorCode =
  /** The request's body, query or headers are not what the route takes. `details.issues` says where. */
  | "invalid_request"
  /** No bearer token, or one that is not a token at all. */
  | "unauthenticated"
  /** The access token has run out. Refresh it and send the request again. */
  | "token_expired"
  /** The token is not one WorkOS issued for Ponzu, or not one a runner holds. Sign in again. */
  | "token_invalid"
  /** The token is good but nobody has signed in with it through `/v1/auth/exchange`. Sign in again. */
  | "user_not_found"
  /** Signed in, but not allowed to do this. */
  | "forbidden"
  /** A route that does not say who may call it. A bug in the API, never the caller's. */
  | "access_undeclared"
  | "not_found"
  | "method_not_allowed"
  /** This build of the app is older than the API accepts. `details.minimumVersion` says what is. */
  | "client_too_old"
  /** Sign-in: the authorization code was already used. Start the sign-in again. */
  | "invalid_code"
  /**
   * Sign-in: the PKCE verifier is not the one the sign-in began with, or WorkOS does not know
   * the code at all, which it reports the same way. Start the sign-in again.
   */
  | "invalid_code_verifier"
  /** Sign-in: GitHub does not say the person's email address is verified. */
  | "email_not_verified"
  /** Sign-in: WorkOS wants a step Ponzu does not offer (a second factor, an organization). */
  | "sign_in_not_supported"
  /** Sign-in: WorkOS did not hand back the person's GitHub token, so there is nothing to act with. */
  | "github_token_missing"
  /** Sign-in: this WorkOS user already belongs to a different GitHub account. */
  | "identity_conflict"
  /** GitHub no longer accepts what Ponzu holds for this person. Sign in again. */
  | "github_reauth_required"
  /** WorkOS, GitHub or another service the API depends on failed or could not be reached. */
  | "upstream_unavailable"
  /** A part of the API that is not built yet. */
  | "not_implemented"
  | "internal";

/**
 * A failure with an answer for the caller. Throw one anywhere below a route; the app turns it
 * into `{ error: { code, message, details? } }`. `message` is shown to people, so it is a plain
 * sentence and never carries a token, a stack or what another service said. `cause` is logged.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
  }

  get body(): ErrorBody {
    const { details } = this.options;
    return { error: { code: this.code, message: this.message, ...(details ? { details } : {}) } };
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/**
 * A service the API calls failed, timed out or answered with something it should not have.
 * `message` is for the logs and may quote the service's own error code, never its body.
 */
export class UpstreamError extends Error {
  constructor(
    readonly service: "workos" | "github",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

const SERVICE_NAME = { workos: "the sign-in service", github: "GitHub" } as const;

/** The error a caller is told about, whatever was thrown. Anything unexpected is `internal`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof UpstreamError) {
    return new ApiError(
      502,
      "upstream_unavailable",
      `Ponzu could not reach ${SERVICE_NAME[error.service]}. Try again in a moment.`,
      { cause: error },
    );
  }
  return new ApiError(500, "internal", "Something went wrong on our side.", { cause: error });
}
