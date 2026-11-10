import type { SyncTransport } from "@ponzu/core";
import type {
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
 * protocol"). `HttpRunnerApi` speaks it over HTTP; `FakeRunnerApi` keeps it in memory.
 *
 * Every method rejects with an `ApiError` when the API answered with an error, and with
 * anything else when it could not be reached. Retrying is the caller's choice: each call says
 * whether sending it again is safe.
 */
export interface RunnerApi {
  /** The document's own routes, for the design's `Replica`. */
  readonly sync: SyncTransport;
  /** Read-only. */
  session(): Promise<RunnerSession>;
  /** Safe to repeat: an event is handed out until it is acknowledged. */
  claim(opts?: { restart?: boolean }): Promise<ClaimResponse>;
  /** Safe to repeat. */
  ack(ids: string[]): Promise<void>;
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
}

/** Whether a failed call is worth making again: the API was out of reach, or said to wait. */
export function retryable(err: unknown): boolean {
  return !(err instanceof ApiError) || err.transient;
}
