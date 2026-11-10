import { QueryError } from "@ponzu/db";
import { HTTPException } from "hono/http-exception";
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
  /**
   * The token is good but its session did not begin at `/v1/auth/exchange`, or was signed out.
   * Sign in again.
   */
  | "session_unknown"
  /** Signed in, but not allowed to do this. */
  | "forbidden"
  /** A route that does not say who may call it. A bug in the API, never the caller's. */
  | "access_undeclared"
  | "not_found"
  | "method_not_allowed"
  /** The request's body is larger than the route takes. */
  | "payload_too_large"
  /** Too many requests. Wait before sending more. */
  | "rate_limited"
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
  /** The API's own database did not answer in time. Nothing is known to have changed; try again. */
  | "database_unavailable"
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
 *
 * Left alone it becomes 502 `upstream_unavailable`. A caller for whom the service's answer
 * means something (GitHub's 404 for a repository the person cannot see, its 403 for one they
 * may not change) catches it, reads `status`, and throws the `ApiError` that says so.
 */
export class UpstreamError extends Error {
  /** The HTTP status the service answered with. Undefined when it did not answer at all. */
  readonly status?: number;

  constructor(
    readonly service: "workos" | "github",
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UpstreamError";
    if (options.status !== undefined) this.status = options.status;
  }
}

const SERVICE_NAME = { workos: "the sign-in service", github: "GitHub" } as const;

/** What Hono's own middleware (a body limit, a rate limiter) means by each status it refuses with. */
const REFUSALS: Record<number, [code: ErrorCode, message: string]> = {
  401: ["unauthenticated", "Sign in to do this."],
  403: ["forbidden", "You are not allowed to do this."],
  404: ["not_found", "There is nothing at this address."],
  405: ["method_not_allowed", "This address does not take that method."],
  413: ["payload_too_large", "The request is too large."],
  429: ["rate_limited", "Too many requests. Try again in a moment."],
};

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
  if (error instanceof QueryError && error.unavailable) {
    return new ApiError(
      503,
      "database_unavailable",
      "Ponzu could not reach its database. Try again in a moment.",
      { cause: error },
    );
  }
  // Thrown by Hono or one of its middlewares. Its own message and response are not ours to
  // pass on; the status is, when it blames the request.
  if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
    const [code, message] = REFUSALS[error.status] ?? [
      "invalid_request",
      "The request could not be read.",
    ];
    return new ApiError(error.status, code, message, { cause: error });
  }
  return new ApiError(500, "internal", "Something went wrong on our side.", { cause: error });
}
