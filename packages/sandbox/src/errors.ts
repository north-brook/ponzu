export type SandboxErrorCode =
  /** A 429 still thrown after the SDK's own Retry-After sleep. `retryAfterSeconds` is the response's header. */
  | "rate_limited"
  /**
   * From `up()` only: the image is not ready yet, or the name is held by a create or delete still
   * finishing. Nothing was started. Try again shortly.
   */
  | "busy"
  /**
   * A call pinned to a session that is not the current one or is not running. Nothing was done
   * and nothing resumed. A session never runs again, so retrying the same `At` cannot help.
   */
  | "not_running"
  /** The network failed, or Vercel answered 5xx after the SDK's retries. Whether the call took effect is unknown. */
  | "unavailable"
  /** Any other 4xx: Vercel refused the request as sent. Sending it again will not help. */
  | "rejected";

/** Every failure the sandbox module reports. Branch on `code`; `message` is for logs. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** Seconds to wait before trying again, when Vercel or the module says. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: SandboxErrorCode,
    message: string,
    options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SandboxError";
    this.code = code;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
