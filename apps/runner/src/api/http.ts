import { createHash } from "node:crypto";
import { CommitRefusedError, type SyncTransport } from "@ponzu/core";
import type { RunnerApi, Uploaded, UploadFile } from "./api.ts";
import type {
  ClaimResponse,
  CompleteResponse,
  GitCredentialRequest,
  GitCredentialResponse,
  QuestionRequest,
  RunnerSession,
  StateRequest,
  StateResponse,
  ThreadResponse,
  ThreadWrite,
  TurnUsage,
  UploadResponse,
} from "./protocol.ts";
import { ApiError, type Endpoint, request, TIMEOUT_MS } from "./request.ts";

/** `RunnerApi` over HTTP: the runner token as the bearer on every call, JSON both ways. */
export class HttpRunnerApi implements RunnerApi {
  readonly sync: SyncTransport;

  constructor(private readonly endpoint: Endpoint & { designId: string }) {
    this.sync = this.transport();
  }

  session(): Promise<RunnerSession> {
    return this.call("GET", "/v1/runner/session");
  }

  claim(opts: { restart?: boolean } = {}): Promise<ClaimResponse> {
    return this.call("POST", "/v1/runner/events/claim", opts.restart ? { restart: true } : {});
  }

  async ack(ids: string[]): Promise<void> {
    await this.call("POST", "/v1/runner/events/ack", { ids });
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
    const done = await this.call<CompleteResponse>("POST", "/v1/runner/uploads/complete", {
      ids: placed.files.map((f) => f.id),
      ...(opts.seq === undefined ? {} : { seq: opts.seq }),
    });
    return done.files.map((f, i) => ({ name: files[i]!.name, ref: f.ref, url: f.url }));
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
