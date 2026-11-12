/**
 * Thrown by a job's handler whose work cannot go on yet and should be tried again after `ms`,
 * sooner or later than the usual wait: a provider that says when to come back. It counts as an
 * attempt, and is logged as a wait rather than a failure (`runJob`).
 */
export class RetryLater extends Error {
  constructor(
    readonly ms: number,
    message: string,
  ) {
    super(message);
    this.name = "RetryLater";
  }
}
