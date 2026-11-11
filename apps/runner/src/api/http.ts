import { createHash } from "node:crypto";
import { CommitRefusedError, type SyncTransport } from "@ponzu/core";
import type { Checkpoint, Restored, RunnerApi, Uploaded, UploadFile } from "./api.ts";
import {
  type AckRequest,
  ARCHIVE_TYPE,
  type CheckpointRequest,
  type CheckpointResponse,
  type ClaimRequest,
  type ClaimResponse,
  type CompleteResponse,
  type GitCredentialRequest,
  type GitCredentialResponse,
  type PullRequestSummaryRequest,
  type PullRequestSummaryResponse,
  type QuestionRequest,
  type RestoredReport,
  type RestoreResponse,
  type RunnerSession,
  type SavedArchive,
  type SavedPoint,
  SESSION_ARCHIVE,
  type StateRequest,
  type StateResponse,
  type ThreadResponse,
  type ThreadWrite,
  type TurnUsage,
  type UploadPurpose,
  type UploadResponse,
  WORKSPACE_ARCHIVE,
} from "./protocol.ts";
import { ApiError, type Endpoint, request, TIMEOUT_MS } from "./request.ts";

/**
 * `RunnerApi` over HTTP: the runner token as the bearer on every call, JSON both ways, and
 * after the session the lease it handed out.
 */
export class HttpRunnerApi implements RunnerApi {
  readonly sync: SyncTransport;
  private readonly endpoint: Endpoint & { designId: string };

  constructor(endpoint: Endpoint & { designId: string }) {
    this.endpoint = { ...endpoint, runnerId: null };
    this.sync = this.transport();
  }

  async session(): Promise<RunnerSession> {
    const session = await this.call<RunnerSession>("POST", "/v1/runner/session", {});
    this.endpoint.runnerId = session.runnerId;
    return session;
  }

  claim(request: ClaimRequest): Promise<ClaimResponse> {
    return this.call("POST", "/v1/runner/events/claim", request);
  }

  async ack(ids: string[], claudeSessionId: string | null): Promise<void> {
    await this.call("POST", "/v1/runner/events/ack", { ids, claudeSessionId } satisfies AckRequest);
  }

  writeThread(items: ThreadWrite[]): Promise<ThreadResponse> {
    return this.call("POST", "/v1/runner/thread", { items });
  }

  putState(state: StateRequest): Promise<StateResponse> {
    return this.call("PUT", "/v1/runner/state", state);
  }

  async ask(question: QuestionRequest): Promise<void> {
    await this.call("POST", "/v1/runner/questions", question);
  }

  async withdraw(ids: string[]): Promise<void> {
    await this.call("POST", "/v1/runner/questions/withdraw", { ids });
  }

  async upload(files: UploadFile[], opts: { seq?: number } = {}): Promise<Uploaded[]> {
    const ids = await this.place(files);
    const done = await this.call<CompleteResponse>("POST", "/v1/runner/uploads/complete", {
      ids,
      ...(opts.seq === undefined ? {} : { seq: opts.seq }),
    });
    return done.files.map((f, i) => ({ name: files[i]!.name, ref: f.ref, url: f.url }));
  }

  /** Asks for addresses and puts the bytes there. Answers the upload ids. */
  private async place(files: UploadFile[]): Promise<string[]> {
    const placed = await this.call<UploadResponse>("POST", "/v1/runner/uploads", {
      files: files.map((f) => ({
        purpose: f.purpose,
        name: f.name,
        contentType: f.contentType,
        size: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      })),
    });
    await Promise.all(
      placed.files.map(async ({ put }, i) => {
        const response = await (this.endpoint.fetch ?? fetch)(put.url, {
          method: "PUT",
          headers: put.headers,
          body: files[i]!.bytes as Uint8Array<ArrayBuffer>,
          signal: AbortSignal.timeout(TIMEOUT_MS * 4),
        });
        if (!response.ok) throw new Error(`The upload was refused (${response.status}).`);
      }),
    );
    return placed.files.map((f) => f.id);
  }

  gitCredential(ask: GitCredentialRequest): Promise<GitCredentialResponse> {
    return this.call("POST", "/v1/runner/git-credential", ask);
  }

  async eraseGitCredential(ask: GitCredentialRequest): Promise<void> {
    await this.call("POST", "/v1/runner/git-credential/erase", ask);
  }

  async recordUsage(turns: TurnUsage[]): Promise<void> {
    await this.call("POST", "/v1/runner/usage", { turns });
  }

  async saveCheckpoint(point: Checkpoint): Promise<SavedPoint> {
    const archives: [UploadPurpose, string, Uint8Array][] = [];
    if (point.session) archives.push(["session", SESSION_ARCHIVE, point.session]);
    if (point.workspace) archives.push(["workspace", WORKSPACE_ARCHIVE, point.workspace]);
    const ids: Record<string, string> = {};
    if (archives.length > 0) {
      const placed = await this.place(
        archives.map(([purpose, name, bytes]) => ({
          purpose,
          name,
          contentType: ARCHIVE_TYPE,
          bytes,
        })),
      );
      archives.forEach(([purpose], i) => {
        ids[purpose] = placed[i]!;
      });
    }
    const { saved } = await this.call<CheckpointResponse>("POST", "/v1/runner/checkpoint", {
      turn: point.turn,
      claudeSessionId: point.claudeSessionId,
      wipCommit: point.wipCommit,
      session: ids.session ?? null,
      workspace: ids.workspace ?? null,
      ...(point.keep ? { keep: point.keep } : {}),
    } satisfies CheckpointRequest);
    return saved;
  }

  async restore(): Promise<Restored> {
    const answer = await this.call<RestoreResponse>("POST", "/v1/runner/restore", {});
    const read = async (archive: SavedArchive | null) => {
      if (!archive) return null;
      const response = await (this.endpoint.fetch ?? fetch)(archive.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS * 4),
      });
      if (!response.ok)
        throw new Error(`The saved archive could not be read (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== archive.size || sha256 !== archive.sha256)
        throw new Error("The saved archive came back different from what was stored.");
      return bytes;
    };
    const [session, workspace] = await Promise.all([read(answer.session), read(answer.workspace)]);
    return { saved: answer.saved, session, workspace };
  }

  async reportRestored(report: RestoredReport): Promise<void> {
    await this.call("POST", "/v1/runner/restored", report);
  }

  async pullRequestSummary(summary: string): Promise<number | null> {
    const answer = await this.call<PullRequestSummaryResponse>(
      "POST",
      "/v1/runner/pull-request-summary",
      { summary } satisfies PullRequestSummaryRequest,
    );
    return answer.pullRequest;
  }

  /** The existing document routes, as core's `Replica` asks for them. */
  private transport(): SyncTransport {
    const design = `/v1/designs/${encodeURIComponent(this.endpoint.designId)}`;
    return {
      commit: async (ops) => {
        try {
          return await this.call("POST", `${design}/ops`, { ops });
        } catch (err) {
          // Malformed or too large: the same post will never be taken.
          if (err instanceof ApiError && (err.status === 400 || err.status === 413))
            throw new CommitRefusedError(err.message);
          throw err;
        }
      },
      fetchOps: async (after) => {
        try {
          return await this.call("GET", `${design}/ops?after=${after}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 410) return "gone";
          throw err;
        }
      },
      fetchDoc: () => this.call("GET", `${design}/doc`),
    };
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(this.endpoint, method, path, body);
  }
}
