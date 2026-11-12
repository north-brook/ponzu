import type { ErrorBody, ErrorCode } from "@ponzu/api/types";

/**
 * The codes an `ApiError` can carry: the API's own (`ErrorCode`, stable, never renamed), and
 * `network`, for a request that got no answer at all.
 */
export type ClientErrorCode = ErrorCode | "network";

/**
 * Every failure the API client throws. `code` is what to branch on; `message` is a plain
 * sentence that can be shown to people.
 */
export class ApiError extends Error {
  constructor(
    /** The HTTP status, or 0 when nothing answered. */
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Nothing answered, or the API said it could not do it right now: worth another try. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** The `ApiError` an answer that is not 2xx stands for. */
export async function errorOf(response: Response): Promise<ApiError> {
  let body: Partial<ErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<ErrorBody>;
  } catch {
    // Not our JSON: a proxy's page, an empty 502.
  }
  const error = body?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiError(response.status, error.code, error.message, error.details);
  }
  return new ApiError(
    response.status,
    response.status >= 500 ? "internal" : "invalid_request",
    `Ponzu answered ${response.status}.`,
  );
}

/** Whatever `fetch` threw, as the `network` error it means. */
export function networkError(cause: unknown): ApiError {
  const error = new ApiError(0, "network", "Ponzu could not be reached. Check your connection.");
  (error as { cause?: unknown }).cause = cause;
  return error;
}
