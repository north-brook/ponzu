import type { SyncTransport } from "@ponzu/core";
import type {
  AgentPullRequestAction,
  AgentPullRequestAnswer,
  AgentPullRequestRequest,
  ClaimRequest,
  ClaimResponse,
  GitCredentialRequest,
  GitCredentialResponse,
  GitReport,
  ModelsReport,
  ModelsResponse,
  PullRequestStanding,
  PullRequestSummaryResponse,
  QuestionRequest,
  RestoredReport,
  RunnerSession,
  SavedPoint,
  SecretResponse,
  SessionRequest,
  StateRequest,
  StateResponse,
  ThreadResponse,
  ThreadWrite,
  TurnUsage,
  UploadPurpose,
} from "./protocol.ts";
import { ApiError } from "./request.ts";

export { ApiError };

/** Bytes to upload, and what they are for. */
export interface UploadFile {
  purpose: UploadPurpose;
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Uploaded {
  name: string;
  /** An asset's `assets/<name>`; null otherwise. */
  ref: string | null;
  url: string;
}

/**
 * The runner's whole view of the API, for its one canvas (docs/cloud.md, "The runner
 * protocol"). `HttpRunnerApi` speaks it over HTTP; `FakeRunnerApi.client()` keeps it in memory.
 *
 * `session()` comes first: it makes this process the canvas's runner, and every later call
 * carries the lease it returns. Every method rejects with an `ApiError` when the API answered
 * with an error, and with anything else when it could not be reached. Retrying is the caller's
 * choice: each call says whether sending it again is safe.
 */
export interface RunnerApi {
  /** The document's own routes, for the canvas's `Replica`. */
  readonly sync: SyncTransport;
  /**
   * Takes the lease from whichever process held it, naming this boot of the machine when it
   * can. Safe to repeat: the last one wins.
   */
  session(request?: SessionRequest): Promise<RunnerSession>;
  /**
   * An event is handed to this process once, and again only to a later one. Safe to repeat
   * with the same claim id: it hands out again what it handed out.
   */
  claim(request: ClaimRequest): Promise<ClaimResponse>;
  /** Safe to repeat. */
  ack(ids: string[], claudeSessionId: string | null): Promise<void>;
  /** Safe to repeat: items are written by their ids. */
  writeThread(items: ThreadWrite[]): Promise<ThreadResponse>;
  /** Safe to repeat: the last one sent wins. */
  putState(state: StateRequest): Promise<StateResponse>;
  /** Safe to repeat: questions are raised by their ids. */
  ask(question: QuestionRequest): Promise<void>;
  /** Safe to repeat. */
  withdraw(ids: string[]): Promise<void>;
  /**
   * The value given for a `secret` question this runner raised: once, soon after the answer.
   * Not safe to repeat: a second call is refused (404), and the next start's environment has it.
   */
  secret(questionId: string): Promise<SecretResponse>;
  /** Puts the bytes where the API says and confirms them. Safe to repeat. */
  upload(files: UploadFile[], opts?: { seq?: number }): Promise<Uploaded[]>;
  /** A short-lived token for the canvas's own repository. Safe to repeat. */
  gitCredential(ask: GitCredentialRequest): Promise<GitCredentialResponse>;
  /** GitHub refused the token git was given: mint a new one next time. */
  eraseGitCredential(ask: GitCredentialRequest): Promise<void>;
  /** What the runner saw of git and GitHub, for the API's log. Only logged. */
  reportGit(report: GitReport): Promise<void>;
  /** Safe to repeat: turns are recorded by their ids. */
  recordUsage(turns: TurnUsage[]): Promise<void>;
  /**
   * What Claude Code offers the account this runner runs as. Answers whether the API kept it.
   * Safe to repeat: the last one sent wins.
   */
  reportModels(report: ModelsReport): Promise<ModelsResponse>;
  /**
   * Uploads a checkpoint's archives and records it. Answers the checkpoint the API has now,
   * which is this one or a newer one. Safe to repeat: an older or equal turn changes nothing.
   */
  saveCheckpoint(point: Checkpoint): Promise<SavedPoint>;
  /** The canvas's last checkpoint and its archives, read back and checked. */
  restore(): Promise<Restored>;
  /** The disk was behind the last checkpoint and the runner restored from it. Safe to repeat. */
  reportRestored(report: RestoredReport): Promise<void>;
  /**
   * The agent's words on what its branch changes, for the pull request's description. Answers
   * the number of the open pull request they were written into, or null with why they were only
   * kept (none is open: the API keeps them for the one that opens next), and the canvas's pull
   * request as the app shows it. Safe to repeat: the last one sent wins.
   */
  pullRequestSummary(summary: string): Promise<PullRequestSummaryResponse>;
  /**
   * Where the canvas's pull request stands, read from GitHub now, and who the API acts as for the
   * agent in the turn `turn` began. Safe to repeat.
   */
  readPullRequest(turn: string | null): Promise<PullRequestStanding>;
  /**
   * Has the API do `action` to the canvas's pull request for the agent, as the person the turn
   * is for (docs/cloud.md, "The agent's pull request"). Rejects with what the API refused it
   * with. Safe to repeat: what is done already is answered with `did` false.
   */
  actOnPullRequest(
    action: AgentPullRequestAction,
    request: AgentPullRequestRequest,
  ): Promise<AgentPullRequestAnswer>;
}

/** A checkpoint to save: its turn marker and what is kept with it. */
export interface Checkpoint {
  turn: number;
  claudeSessionId: string | null;
  wipCommit: string | null;
  /** The transcript's archive, and a Scratch canvas's files' (gzipped tar). */
  session: Uint8Array | null;
  workspace: Uint8Array | null;
  /** Keep what the last checkpoint stored in place of an archive this one does not carry. */
  keep?: { session?: boolean; workspace?: boolean };
  /**
   * The newest event the session held when its archive was taken (`heldThrough`), read once the
   * archives are uploaded and just before the checkpoint is recorded: an event that went into
   * the session while they were on their way lowers it. Undefined: the runner cannot say.
   */
  heldThrough?: () => number | undefined;
}

/** The last checkpoint, with its archives' bytes. */
export interface Restored {
  saved: SavedPoint | null;
  session: Uint8Array | null;
  workspace: Uint8Array | null;
}

/** Whether a failed call is worth making again: the API was out of reach, or said to wait. */
export function retryable(err: unknown): boolean {
  return !(err instanceof ApiError) || err.transient;
}

/**
 * Whether the API has said this process must stop for good: its token is revoked or expired
 * (the canvas was deleted or settled), or a newer runner of the canvas took the lease.
 */
export function fatal(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 401 || (err.status === 409 && err.code === "superseded"))
  );
}

/** `api`, telling `onFatal` of the first answer that means the process must stop. */
export function watchFatal(api: RunnerApi, onFatal: (err: ApiError) => void): RunnerApi {
  let told = false;
  const watch =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A) =>
      call(...args).catch((err: unknown) => {
        if (fatal(err) && !told) {
          told = true;
          onFatal(err as ApiError);
        }
        throw err;
      });
  const { sync } = api;
  return {
    sync: {
      commit: watch(sync.commit.bind(sync)),
      fetchOps: watch(sync.fetchOps.bind(sync)),
      fetchDoc: watch(sync.fetchDoc.bind(sync)),
    },
    session: watch(api.session.bind(api)),
    claim: watch(api.claim.bind(api)),
    ack: watch(api.ack.bind(api)),
    writeThread: watch(api.writeThread.bind(api)),
    putState: watch(api.putState.bind(api)),
    ask: watch(api.ask.bind(api)),
    withdraw: watch(api.withdraw.bind(api)),
    secret: watch(api.secret.bind(api)),
    upload: watch(api.upload.bind(api)),
    gitCredential: watch(api.gitCredential.bind(api)),
    eraseGitCredential: watch(api.eraseGitCredential.bind(api)),
    reportGit: watch(api.reportGit.bind(api)),
    recordUsage: watch(api.recordUsage.bind(api)),
    reportModels: watch(api.reportModels.bind(api)),
    saveCheckpoint: watch(api.saveCheckpoint.bind(api)),
    restore: watch(api.restore.bind(api)),
    reportRestored: watch(api.reportRestored.bind(api)),
    pullRequestSummary: watch(api.pullRequestSummary.bind(api)),
    readPullRequest: watch(api.readPullRequest.bind(api)),
    actOnPullRequest: watch(api.actOnPullRequest.bind(api)),
  };
}
