export type SandboxErrorCode =
  /** The sandbox, snapshot or file does not exist. */
  | "not_found"
  /** Too many starts or requests for now. `retryAfterSeconds` says when to try again. */
  | "rate_limited"
  /** The account cannot start another sandbox until one stops or its plan grows. Waiting a few seconds does not help. */
  | "start_cap_reached"
  /** The sandbox slept so long that its disk was deleted. It can only be recreated. */
  | "snapshot_expired"
  /** The sandbox must be awake for this and is not. The request did nothing. Wake it, then try again. */
  | "not_running"
  /**
   * Something already under way holds the sandbox for a moment: a stop still finishing, a start
   * or a create someone else began. The request did nothing. Send it again after
   * `retryAfterSeconds`.
   */
  | "busy"
  /** The request contradicts the state the sandbox or snapshot is in. Sending it again will not help until that changes. */
  | "conflict"
  /** The provider failed, timed out or could not be reached. Whether the request took effect is unknown. */
  | "unavailable"
  /** The provider refused the request as sent. Sending it again will not help. */
  | "rejected";

/** Every failure a provider reports. Branch on `code`; `message` is for logs. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** Seconds to wait before trying again. Always set on `rate_limited` and `busy`; elsewhere only when the provider says. */
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
