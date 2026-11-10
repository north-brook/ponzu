import { type Doc, emptyDoc, type SyncTransport } from "@ponzu/core";
import { Sequencer } from "@ponzu/core/testing";
import { AGENT, memoryTransport } from "@ponzu/tools/testing";
import { ApiError, type RunnerApi, type Uploaded, type UploadFile } from "./api.ts";
import type {
  AnswerEvent,
  ClaimResponse,
  EventBody,
  GitCredentialRequest,
  GitCredentialResponse,
  Person,
  Priority,
  QuestionRequest,
  QuestionResponse,
  RunnerEvent,
  RunnerSession,
  StateRequest,
  StateResponse,
  ThreadResponse,
  ThreadWrite,
  TurnUsage,
} from "./protocol.ts";

/** How long a claimed event stays with its claimer before a claim hands it out again. */
const RETAKE_MS = 60_000;

export const ADA: Person = { id: "usr_ada", name: "Ada", login: "ada" };

export function testSession(over: Partial<RunnerSession> = {}): RunnerSession {
  return {
    design: { id: "des_test", name: "Fern" },
    repo: null,
    branch: null,
    claudeSessionId: null,
    model: null,
    effort: null,
    author: { name: "Ada", email: "1+ada@users.noreply.github.com" },
    committer: { name: "ponzu[bot]", email: "2+ponzu[bot]@users.noreply.github.com" },
    assetBase: "https://assets.ponzu.test/key",
    link: "https://ponzu.test/d/des_test",
    theme: null,
    openQuestions: [],
    seq: 0,
    ...over,
  };
}

interface HeldEvent {
  event: RunnerEvent;
  claimedAt?: number;
  deliveredAt?: number;
}

/** A thread item as the API holds it. */
export type StoredItem = ThreadWrite & { seq: number };

/**
 * The API's side of the runner protocol in memory, behaving as docs/cloud.md says the real one
 * does: claims hand an event out until it is acknowledged, thread items are written by id and
 * only while they stream, questions are raised by id. The document is a `Sequencer`, so a real
 * `Replica` syncs against it.
 */
export class FakeRunnerApi implements RunnerApi {
  readonly doc: Sequencer;
  readonly sync: SyncTransport;
  sessionInfo: RunnerSession;

  readonly events: HeldEvent[] = [];
  readonly thread = new Map<string, StoredItem>();
  /** Every thread write, as sent. */
  readonly threadWrites: ThreadWrite[][] = [];
  readonly states: StateRequest[] = [];
  readonly questions = new Map<string, QuestionRequest & { status: QuestionResponse["status"] }>();
  readonly uploads: (UploadFile & { seq?: number })[] = [];
  readonly usage = new Map<string, TurnUsage>();
  readonly erased: GitCredentialRequest[] = [];
  /** While true, every call fails as if the API could not be reached. */
  down = false;
  /** Every call, by method name, in order. */
  readonly calls: string[] = [];

  private seq = 0;
  private itemSeq = 0;

  constructor(opts: { session?: Partial<RunnerSession>; doc?: Doc } = {}) {
    this.doc = new Sequencer(opts.doc ?? emptyDoc("Fern"));
    const transport = memoryTransport(this.doc, AGENT);
    // The document routes are calls like any other: counted, and down with the rest.
    this.sync = {
      commit: (ops) => this.enter("commit").then(() => transport.commit(ops)),
      fetchOps: (after) => this.enter("fetchOps").then(() => transport.fetchOps(after)),
      fetchDoc: () => this.enter("fetchDoc").then(() => transport.fetchDoc()),
    };
    this.sessionInfo = testSession(opts.session);
  }

  /** Add something to the design's feed, as the API does when it happens. */
  push(body: EventBody, opts: { priority?: Priority; from?: Person | null } = {}): RunnerEvent {
    const event = {
      id: `evt_${String(++this.seq).padStart(4, "0")}`,
      seq: this.seq,
      at: new Date().toISOString(),
      priority: opts.priority ?? "now",
      from: opts.from === undefined ? ADA : opts.from,
      ...body,
    } as RunnerEvent;
    this.events.push({ event });
    return event;
  }

  /** A person answers a question: the row closes and an `answer` event joins the feed. */
  answer(answer: AnswerEvent): RunnerEvent {
    const question = this.questions.get(answer.questionId);
    if (question?.status !== "open") throw new Error(`${answer.questionId} is not open`);
    question.status = "answered";
    return this.push({ kind: "answer", payload: answer });
  }

  /** Ids of the events the runner has acknowledged. */
  get delivered(): string[] {
    return this.events.filter((e) => e.deliveredAt !== undefined).map((e) => e.event.id);
  }

  /** The thread in order. */
  items(): StoredItem[] {
    return [...this.thread.values()].sort((a, b) => a.seq - b.seq);
  }

  get lastState(): StateRequest | undefined {
    return this.states.at(-1);
  }

  async session(): Promise<RunnerSession> {
    await this.enter("session");
    return structuredClone({ ...this.sessionInfo, seq: this.doc.seq });
  }

  async claim(opts: { restart?: boolean } = {}): Promise<ClaimResponse> {
    await this.enter("claim");
    const now = Date.now();
    const waiting = this.events.filter(
      (e) =>
        e.deliveredAt === undefined &&
        (opts.restart || e.claimedAt === undefined || now - e.claimedAt > RETAKE_MS),
    );
    for (const e of waiting) e.claimedAt = now;
    return { events: waiting.map((e) => structuredClone(e.event)), seq: this.doc.seq };
  }

  async ack(ids: string[]): Promise<void> {
    await this.enter("ack");
    for (const e of this.events) if (ids.includes(e.event.id)) e.deliveredAt ??= Date.now();
  }

  async writeThread(items: ThreadWrite[]): Promise<ThreadResponse> {
    await this.enter("writeThread");
    this.threadWrites.push(structuredClone(items));
    return {
      items: items.map((item) => {
        const stored = this.thread.get(item.id);
        if (!stored) {
          const added = { ...structuredClone(item), seq: ++this.itemSeq };
          this.thread.set(item.id, added);
          return { id: item.id, seq: added.seq, streaming: added.streaming };
        }
        if (stored.streaming) {
          stored.payload = structuredClone(item.payload);
          stored.streaming = item.streaming;
        }
        return { id: item.id, seq: stored.seq, streaming: stored.streaming };
      }),
    };
  }

  async putState(state: StateRequest): Promise<StateResponse> {
    await this.enter("putState");
    this.states.push(structuredClone(state));
    return { seq: this.doc.seq };
  }

  async ask(question: QuestionRequest): Promise<void> {
    await this.enter("ask");
    if (!this.questions.has(question.id))
      this.questions.set(question.id, { ...structuredClone(question), status: "open" });
  }

  async withdraw(ids: string[]): Promise<void> {
    await this.enter("withdraw");
    for (const id of ids) {
      const question = this.questions.get(id);
      if (question?.status === "open") question.status = "cancelled";
    }
  }

  async upload(files: UploadFile[], opts: { seq?: number } = {}): Promise<Uploaded[]> {
    await this.enter("upload");
    const base = this.sessionInfo.assetBase;
    return files.map((file) => {
      this.uploads.push({ ...file, ...(opts.seq === undefined ? {} : { seq: opts.seq }) });
      const asset = file.purpose === "asset";
      const url = `${base}/${asset ? "" : `${file.purpose}s/`}${file.name}`;
      return { name: file.name, ref: asset ? `assets/${file.name}` : null, url };
    });
  }

  async gitCredential(ask: GitCredentialRequest): Promise<GitCredentialResponse> {
    await this.enter("gitCredential");
    const { repo } = this.sessionInfo;
    if (!repo) throw new ApiError(404, "not_found", "This design has no repository.");
    if (ask.host !== "github.com" || ask.path !== `${repo.owner}/${repo.name}.git`)
      throw new ApiError(403, "forbidden", "That is not this design's repository.");
    return {
      username: "x-access-token",
      password: "ghs_fake",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  async eraseGitCredential(ask: GitCredentialRequest): Promise<void> {
    await this.enter("eraseGitCredential");
    this.erased.push(ask);
  }

  async recordUsage(turns: TurnUsage[]): Promise<void> {
    await this.enter("recordUsage");
    for (const turn of turns) this.usage.set(turn.id, structuredClone(turn));
  }

  private async enter(method: string): Promise<void> {
    this.calls.push(method);
    if (this.down) throw new TypeError("fetch failed");
  }
}
