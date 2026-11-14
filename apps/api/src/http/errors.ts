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
  /** Sign-in: an account on this WorkOS user was just deleted and is still being forgotten. */
  | "account_being_deleted"
  /** GitHub no longer accepts what Ponzu holds for this person. Sign in again. */
  | "github_reauth_required"
  /** A canvas's ops: the log no longer keeps the ops after the seq asked for. Fetch the whole document. */
  | "ops_pruned"
  /** A canvas changed too often while this request tried to commit to it. Nothing was committed; try again. */
  | "canvas_busy"
  /** Undo: nothing of the caller's or the agent's is left that can be taken back. */
  | "nothing_to_undo"
  /** Redo: the caller has no undo left to take back. */
  | "nothing_to_redo"
  /** WorkOS, GitHub or another service the API depends on failed or could not be reached. */
  | "upstream_unavailable"
  /** The API's own database did not answer in time. Nothing is known to have changed; try again. */
  | "database_unavailable"
  /** A part of the API that is not built yet. */
  | "not_implemented"
  /** A webhook delivery that is not signed with the secret its sender shares with Ponzu. */
  | "signature_invalid"
  /** A workspace always has an admin: this would leave it with none. Make someone else one first. */
  | "last_admin"
  /** GitHub says this person owns the workspace's account, so they are always an admin. */
  | "owner_is_admin"
  /**
   * A runner call without the canvas's current lease (`X-Ponzu-Runner`): a newer runner has
   * started for the canvas. The runner stops for good.
   */
  | "superseded"
  /**
   * An answer to a question that is no longer open: someone answered first, or the run moved
   * on. `details.answeredBy` names who answered it, when someone did.
   */
  | "question_closed"
  /** An upload larger than its kind of file may be. `details.maxBytes` says how large it may be. */
  | "file_too_large"
  /** An upload of a kind of file this place does not take, or whose name and type disagree. */
  | "unsupported_file_type"
  /** Anthropic does not take this API key. */
  | "claude_key_invalid"
  /**
   * The model, or that effort for it, is not one the person's Claude account offers now. Read
   * `/v1/claude/defaults` again for what it does.
   */
  | "model_not_offered"
  /**
   * A Claude sign-in's code that is not whole, or that claude.ai turned away (wrong, from an
   * earlier sign-in, or past its time there). Open sign-in again for a new one.
   */
  | "claude_code_invalid"
  /** A Claude sign-in that waited longer than ten minutes for its code. Open sign-in again. */
  | "claude_sign_in_expired"
  /** A Claude sign-in whose one code was already sent, or that was given up. Open sign-in again. */
  | "claude_sign_in_used"
  /** A pull request needs a repo, and this canvas is Scratch. */
  | "no_repository"
  /** Nothing has been pushed to the canvas's branch yet, so GitHub does not have it. */
  | "branch_not_pushed"
  /** The canvas's branch has no commits that the branch it merges into lacks. */
  | "no_changes"
  /** The canvas has no open pull request to do this to. */
  | "no_pull_request"
  /** The canvas's pull request is merged or closed. */
  | "pull_request_closed"
  /** A close named a pull request that is no longer the canvas's newest. Look again first. */
  | "pull_request_changed"
  /** The pull request is a draft: mark it ready first. */
  | "pull_request_draft"
  /** The branch conflicts with the branch it merges into. */
  | "merge_conflicts"
  /** GitHub is still working out whether the pull request can merge. Try again in a moment. */
  | "mergeability_unknown"
  /** The branch moved since it was looked at. Look at it again first. */
  | "head_moved"
  /** The repo's rules want an approving review first. */
  | "review_required"
  /** A reviewer asked for changes. */
  | "changes_requested"
  /** A check the repo's rules require has failed. */
  | "checks_failing"
  /** Checks the repo's rules require have not finished. Auto-merge merges once they pass. */
  | "checks_pending"
  /** The repo's rules want the branch up to date with the one it merges into: update it. */
  | "branch_behind"
  /** The repo's rules do not allow this merge, for a reason GitHub does not spell out. */
  | "branch_protected"
  /** The branch already has everything the branch it merges into has. */
  | "branch_up_to_date"
  /** The repo does not allow auto-merge: a setting of the repo on GitHub. */
  | "auto_merge_not_allowed"
  /** Nothing is left to wait for, so there is nothing for auto-merge to do: merge it. */
  | "already_mergeable"
  /** GitHub refused, for a reason Ponzu cannot name. */
  | "github_refused"
  /**
   * It would change a file under `.github/workflows/`, and Ponzu's GitHub App has no `workflows`
   * permission: it is done on GitHub instead.
   */
  | "workflow_permission"
  /**
   * The repo merges through a merge queue, and Ponzu does not add to one yet (PONZU_MERGE_QUEUE
   * is off): it is added to the queue on GitHub.
   */
  | "merge_queue"
  /** GitHub's merge queue turned the pull request down. */
  | "merge_queue_unmergeable"
  /**
   * The agent asked to merge, mark ready or turn on auto-merge in a turn no person in Ponzu began,
   * or after words from GitHub (a check, a review) went into its session: only a person's turn may.
   */
  | "turn_not_from_person"
  /** The agent did this to its pull request as often as an hour allows. A person can still. */
  | "agent_limit"
  /** A push token another device of the person's already has. */
  | "push_token_taken"
  /**
   * A secret's name that would replace or steer what Ponzu puts in a sandbox (its own
   * variables, the Claude credential, the proxy, the loader). Pick another name.
   */
  | "secret_name_reserved"
  /** The repo already has a secret of that name: replace its value instead. */
  | "secret_exists"
  /** The repo's secrets are as many, or as large, as a sandbox's environment takes. */
  | "secrets_full"
  /** A monthly cap below what the period has already billed. `details.lowestUsd` says the least. */
  | "cap_too_low"
  /**
   * Deleting the account would leave a team with nobody to run it: the person is its only
   * admin and others are in it. `details.workspaces` names them. Make someone else an admin.
   */
  | "sole_admin"
  /** The confirmation typed to delete the account is not the person's GitHub login. */
  | "confirmation_mismatch"
  /**
   * A take-over of a canvas whose owner is in its workspace: only one whose owner left, or
   * deleted their account, can be taken over. The owner came back, or a teammate took it first.
   */
  | "not_ownerless"
  /** The caller has no Claude that could run the canvas: none connected, or its sign-in ran out. */
  | "claude_not_connected"
  /**
   * Ponzu is read-only while it updates (`PONZU_MAINTENANCE=read_only`): nothing was written.
   * Reads still work; send it again in a few minutes.
   */
  | "maintenance"
  /**
   * The workspace is at a billing limit (PONZU_BILLING on): its free credits are used up with no
   * card, it reached its monthly cap, or a payment has failed for a week. Nothing was written.
   * `details` has `reason`, `workspaceId`, `workspaceName`, `canManage`, `capUsd`, `billedCents`,
   * `periodEnd` and `invoiceUrl`; the message is the sentence to show.
   */
  | "billing_required"
  /**
   * Billing is not on here (PONZU_BILLING is not `on`): there is no card to add and no portal
   * to open. Nothing was written and Stripe was not asked.
   */
  | "billing_not_set_up"
  /** The workspace has no Stripe customer yet, so there is no portal: add a card first. */
  | "no_card"
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
    readonly service: "workos" | "github" | "storage" | "model" | "anthropic" | "sandbox",
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UpstreamError";
    if (options.status !== undefined) this.status = options.status;
  }
}

const SERVICE_NAME = {
  workos: "the sign-in service",
  github: "GitHub",
  storage: "its file storage",
  model: "the model it asks",
  anthropic: "Anthropic",
  // Only a Claude sign-in waits on a sandbox in a person's request.
  sandbox: "Claude",
} as const;

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
