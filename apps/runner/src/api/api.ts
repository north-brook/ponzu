import type { SyncTransport } from "@ponzu/core";
import type {
  ClaimRequest,
  ClaimResponse,
  GitCredentialRequest,
  GitCredentialResponse,
  QuestionRequest,
  RunnerSession,
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
 * The runner's whole view of the API, for its one design (docs/cloud.md, "The runner
 * protocol"). `HttpRunnerApi` speaks it over HTTP; `FakeRunnerApi.client()` keeps it in memory.
 *
 * `session()` comes first: it makes this process the design's runner, and every later call
 * carries the lease it returns. Every method rejects with an `ApiError` when the API answered
 * with an error, and with anything else when it could not be reached. Retrying is the caller's
 * choice: each call says whether sending it again is safe.
 */
export interface RunnerApi {
  /** The document's own routes, for the design's `Replica`. */
  readonly sync: SyncTransport;
  /** Takes the lease from whichever process held it. Safe to repeat: the last one wins. */
  session(): Promise<RunnerSession>;
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
  /** Puts the bytes where the API says and confirms them. Safe to repeat. */
  upload(files: UploadFile[], opts?: { seq?: number }): Promise<Uploaded[]>;
  /** A short-lived token for the design's own repository. Safe to repeat. */
  gitCredential(ask: GitCredentialRequest): Promise<GitCredentialResponse>;
  /** GitHub refused the token git was given: mint a new one next time. */
  eraseGitCredential(ask: GitCredentialRequest): Promise<void>;
  /** Safe to repeat: turns are recorded by their ids. */
  recordUsage(turns: TurnUsage[]): Promise<void>;
  /**
   * The agent's words on what its branch changes, for the pull request's description. Answers
   * the number of the open pull request they were written into, or null while none is open (the
   * API keeps them for the one that opens). Safe to repeat: the last one sent wins.
   */
  pullRequestSummary(summary: string): Promise<number | null>;
}

/** Whether a failed call is worth making again: the API was out of reach, or said to wait. */
export function retryable(err: unknown): boolean {
  return !(err instanceof ApiError) || err.transient;
}

/**
 * Whether the API has said this process must stop for good: its token is revoked or expired
 * (the design was deleted or settled), or a newer runner of the design took the lease.
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
    upload: watch(api.upload.bind(api)),
    gitCredential: watch(api.gitCredential.bind(api)),
    eraseGitCredential: watch(api.eraseGitCredential.bind(api)),
    recordUsage: watch(api.recordUsage.bind(api)),
    pullRequestSummary: watch(api.pullRequestSummary.bind(api)),
  };
}
