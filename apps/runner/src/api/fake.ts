import { type Doc, emptyDoc, type SyncTransport } from "@ponzu/core";
import { Sequencer } from "@ponzu/core/testing";
import { AGENT, memoryTransport } from "@ponzu/tools/testing";
import {
  ApiError,
  type Checkpoint,
  type Restored,
  type RunnerApi,
  type Uploaded,
  type UploadFile,
} from "./api.ts";
import {
  type AgentPullRequestAction,
  type AgentPullRequestAnswer,
  type AgentPullRequestRequest,
  type AnswerEvent,
  CLAIM_LIMIT,
  type ClaimRequest,
  type ClaimResponse,
  type EventBody,
  type GitCredentialRequest,
  type GitCredentialResponse,
  type GitReport,
  type ModelsReport,
  type ModelsResponse,
  type Notice,
  type Person,
  type Priority,
  type PullRequestStanding,
  type PullRequestState,
  type PullRequestSummaryResponse,
  type QuestionRequest,
  type QuestionResponse,
  type RestoredReport,
  type RunnerEvent,
  type RunnerNotice,
  type RunnerSession,
  type SavedPoint,
  type StateRequest,
  type StateResponse,
  type ThreadItem,
  type ThreadResponse,
  type ThreadWrite,
  type TurnUsage,
} from "./protocol.ts";

export const ADA: Person = { id: "usr_ada", name: "Ada", login: "ada" };

const RUNNER_NOTICES = new Set<string>([
  "waking",
  "resumed",
  "started",
  "question",
  "stopped",
  "error",
] satisfies RunnerNotice["type"][]);

export function testSession(over: Partial<RunnerSession> = {}): RunnerSession {
  return {
    runnerId: "rnr_test",
    canvas: { id: "cnv_test", name: "Fern" },
    repo: null,
    branch: null,
    claudeSessionId: null,
    model: null,
    effort: null,
    author: { name: "Ada", email: "1+ada@users.noreply.github.com" },
    committer: { name: "ponzu[bot]", email: "2+ponzu[bot]@users.noreply.github.com" },
    assetBase: "https://assets.ponzu.test/key",
    link: "https://ponzu.test/d/cnv_test",
    theme: null,
    openQuestions: [],
    seq: 0,
    saved: null,
    ...over,
  };
}

interface HeldEvent {
  event: RunnerEvent;
  /** The runner process it was last handed to, and the claim that did. */
  claimedBy?: string;
  claimId?: string;
  deliveredAt?: number;
}

/** A thread item as the API holds it. */
export type StoredItem = ThreadItem;

/** The calls a runner makes, by name, which a test can make fail. */
export type Call = keyof Omit<RunnerApi, "sync"> | "commit" | "fetchOps" | "fetchDoc";

/**
 * The API's side of the runner protocol in memory, behaving as docs/cloud.md says the real one
 * does: the last runner to start holds the lease and any other is refused, claims hand each
 * event to a runner once until it is acknowledged, thread items are written by id and only
 * while they stream, questions are raised by id. The document is a `Sequencer`, so a real
 * `Replica` syncs against it. A runner talks to it through `client()`, or over HTTP through
 * `fakeApiHandler`.
 */
export class FakeRunnerApi {
  readonly doc: Sequencer;
  sessionInfo: Omit<RunnerSession, "runnerId" | "seq">;

  readonly events: HeldEvent[] = [];
  /** The claim id of every claim that got in, in order. */
  readonly claimIds: string[] = [];
  readonly thread = new Map<string, StoredItem>();
  /** Every thread write, as sent. */
  readonly threadWrites: ThreadWrite[][] = [];
  readonly states: StateRequest[] = [];
  readonly questions = new Map<string, QuestionRequest & { status: QuestionResponse["status"] }>();
  readonly uploads: (UploadFile & { seq?: number })[] = [];
  readonly usage = new Map<string, TurnUsage>();
  readonly erased: GitCredentialRequest[] = [];
  /** What git's credential answers with: a stand-in, or a real token for a run against GitHub. */
  gitToken: { password: string; expiresAt: string } | null = null;
  /** While true, every call fails as if the API could not be reached. */
  down = false;
  /** While true, every call is refused as with a revoked runner token. */
  revoked = false;
  /** These calls fail with these errors (a `TypeError` is the API out of reach). */
  readonly failing = new Map<Call, Error>();
  /** The next of these calls does what it does, and its answer is lost on the way. (`claim`) */
  readonly lostAnswers = new Set<Call>();
  /** Every call, by method name, in order. */
  readonly calls: Call[] = [];
  /** The runner process that holds the lease. */
  runner: string | null = null;
  /** The canvas's last checkpoint, and its archives as they were uploaded. */
  saved: SavedPoint | null = null;
  archives: { session: Uint8Array | null; workspace: Uint8Array | null } = {
    session: null,
    workspace: null,
  };
  /** Every checkpoint sent, recorded or not. */
  readonly checkpoints: Omit<Checkpoint, "session" | "workspace">[] = [];
  /** What runners reported restoring. */
  readonly restored: RestoredReport[] = [];
  /** How long each call of a kind takes before the fake looks at it: a slow API. */
  readonly delays = new Map<Call, number>();

  private readonly transport: SyncTransport;
  private seq: number;
  private itemSeq = 0;
  private runners = 0;

  /**
   * `feedSeq` is where the feed's numbering goes on from, for a fake that outlives its process:
   * an event id the API used once is never another event's, and a runner that finds one in its
   * transcript takes the event as delivered.
   */
  constructor(opts: { session?: Partial<RunnerSession>; doc?: Doc; feedSeq?: number } = {}) {
    this.doc = new Sequencer(opts.doc ?? emptyDoc("Fern"));
    this.transport = memoryTransport(this.doc, AGENT);
    const { runnerId: _, seq: __, ...info } = testSession(opts.session);
    this.sessionInfo = info;
    this.seq = opts.feedSeq ?? 0;
  }

  /** The last event's seq in the canvas's feed. */
  get feedSeq(): number {
    return this.seq;
  }

  /** A runner's connection, as `HttpRunnerApi` is one over HTTP. */
  client(): RunnerApi {
    let runner = "";
    const as =
      <A extends unknown[], R>(call: (runner: string, ...args: A) => Promise<R>) =>
      (...args: A) =>
        call(runner, ...args);
    return {
      sync: {
        commit: as((r, ops) => this.commit(r, ops)),
        fetchOps: as((r, after: number) => this.fetchOps(r, after)),
        fetchDoc: as((r) => this.fetchDoc(r)),
      },
      session: async () => {
        const session = await this.session();
        runner = session.runnerId;
        return session;
      },
      claim: as((r, request: ClaimRequest) => this.claim(r, request)),
      ack: as((r, ids: string[], claudeSessionId: string | null) =>
        this.ack(r, ids, claudeSessionId),
      ),
      writeThread: as((r, items: ThreadWrite[]) => this.writeThread(r, items)),
      putState: as((r, state: StateRequest) => this.putState(r, state)),
      ask: as((r, question: QuestionRequest) => this.ask(r, question)),
      withdraw: as((r, ids: string[]) => this.withdraw(r, ids)),
      upload: as((r, files: UploadFile[], opts?: { seq?: number }) => this.upload(r, files, opts)),
      gitCredential: as((r, ask: GitCredentialRequest) => this.gitCredential(r, ask)),
      eraseGitCredential: as((r, ask: GitCredentialRequest) => this.eraseGitCredential(r, ask)),
      reportGit: as((r, report: GitReport) => this.reportGit(r, report)),
      recordUsage: as((r, turns: TurnUsage[]) => this.recordUsage(r, turns)),
      reportModels: as((r, report: ModelsReport) => this.reportModels(r, report)),
      saveCheckpoint: as((r, point: Checkpoint) => this.saveCheckpoint(r, point)),
      restore: as((r) => this.restore(r)),
      reportRestored: as((r, report: RestoredReport) => this.reportRestored(r, report)),
      pullRequestSummary: as((r, summary: string) => this.pullRequestSummary(r, summary)),
      readPullRequest: as((r, turn: string | null) => this.readPullRequest(r, turn)),
      actOnPullRequest: as((r, action: AgentPullRequestAction, request: AgentPullRequestRequest) =>
        this.actOnPullRequest(r, action, request),
      ),
    };
  }

  /** A connection that has taken the lease, as a runner's has once it starts. */
  async connect(): Promise<RunnerApi> {
    const client = this.client();
    await client.session();
    return client;
  }

  /** Add something to the canvas's feed, as the API does when it happens. */
  push(
    body: EventBody,
    opts: { priority?: Priority; from?: Person | null; posthogSessionId?: string | null } = {},
  ): RunnerEvent {
    const event = {
      id: `evt_${String(++this.seq).padStart(4, "0")}`,
      seq: this.seq,
      at: new Date().toISOString(),
      priority: opts.priority ?? "now",
      from: opts.from === undefined ? ADA : opts.from,
      ...(opts.posthogSessionId !== undefined ? { posthogSessionId: opts.posthogSessionId } : {}),
      ...body,
    } as RunnerEvent;
    this.events.push({ event });
    return event;
  }

  /** A person answers a question: the row closes and an `answer` event joins the feed. */
  answer(answer: Omit<AnswerEvent, "question">): RunnerEvent {
    const question = this.questions.get(answer.questionId);
    if (question?.status !== "open") throw new Error(`${answer.questionId} is not open`);
    question.status = "answered";
    const { id: _, status: __, ...asked } = question;
    return this.push({ kind: "answer", payload: { ...answer, question: asked } });
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

  /**
   * The canvas's branch as the API's row holds it (`canvas_runners.unpushed`, `push_error`):
   * what the runner last reported, until it reports again. Create PR clears its error
   * (`askRunnerToPush`), as `askToPush` does here.
   */
  branch: StateRequest["branch"] = undefined;

  /** Create PR with commits only the sandbox holds: the `push` event, and the old error forgotten. */
  askToPush() {
    if (this.branch) this.branch = { ...this.branch, error: null };
    return this.push({ kind: "push", payload: {} });
  }

  /* The routes, as the API answers them. `runner` is the caller's `X-Ponzu-Runner`. */

  async session(): Promise<RunnerSession> {
    await this.enter("session");
    this.runner = `rnr_${String(++this.runners).padStart(16, "0")}`;
    return structuredClone({
      ...this.sessionInfo,
      runnerId: this.runner,
      seq: this.doc.seq,
      saved: this.saved,
    });
  }

  async saveCheckpoint(runner: string, point: Checkpoint): Promise<SavedPoint> {
    await this.enter("saveCheckpoint", runner);
    const { session, workspace, ...marker } = point;
    this.checkpoints.push(structuredClone(marker));
    if (!this.saved || this.saved.turn < point.turn) {
      const before = this.saved;
      const keepSession = !session && !!point.keep?.session && !!before;
      const keepWork = !workspace && !!point.keep?.workspace && !!before;
      this.saved = {
        turn: point.turn,
        at: new Date().toISOString(),
        claudeSessionId: keepSession ? before!.claudeSessionId : point.claudeSessionId,
        wipCommit: keepWork ? before!.wipCommit : point.wipCommit,
        session: keepSession ? before!.session : session !== null,
        workspace: keepWork ? before!.workspace : workspace !== null,
      };
      this.archives = {
        session: keepSession ? this.archives.session : session && new Uint8Array(session),
        workspace: keepWork ? this.archives.workspace : workspace && new Uint8Array(workspace),
      };
    }
    return structuredClone(this.saved);
  }

  async restore(runner: string): Promise<Restored> {
    await this.enter("restore", runner);
    const copy = (bytes: Uint8Array | null) => bytes && new Uint8Array(bytes);
    return {
      saved: structuredClone(this.saved),
      session: copy(this.archives.session),
      workspace: copy(this.archives.workspace),
    };
  }

  async reportRestored(runner: string, report: RestoredReport): Promise<void> {
    await this.enter("reportRestored", runner);
    this.restored.push(structuredClone(report));
  }

  async claim(
    runner: string,
    { claimId, limit = CLAIM_LIMIT }: ClaimRequest,
  ): Promise<ClaimResponse> {
    await this.enter("claim", runner);
    this.claimIds.push(claimId);
    const pending = this.events.filter((e) => e.deliveredAt === undefined);
    const repeated = pending.filter((e) => e.claimedBy === runner && e.claimId === claimId);
    const waiting = (
      repeated.length > 0 ? repeated : pending.filter((e) => e.claimedBy !== runner)
    ).slice(0, Math.min(limit, CLAIM_LIMIT));
    for (const e of waiting) Object.assign(e, { claimedBy: runner, claimId });
    if (this.lostAnswers.delete("claim")) throw new TypeError("fetch failed");
    return {
      events: waiting.map((e) => structuredClone(e.event)),
      seq: this.doc.seq,
      ...(this.older ? {} : { pullRequest: this.pullRequest }),
    };
  }

  async ack(runner: string, ids: string[], claudeSessionId: string | null): Promise<void> {
    await this.enter("ack", runner);
    for (const e of this.events) {
      if (ids.includes(e.event.id) && e.claimedBy === runner) e.deliveredAt ??= Date.now();
    }
    if (claudeSessionId) this.sessionInfo.claudeSessionId = claudeSessionId;
  }

  async writeThread(runner: string, items: ThreadWrite[]): Promise<ThreadResponse> {
    await this.enter("writeThread", runner);
    this.threadWrites.push(structuredClone(items));
    // All or nothing: a write with one item the API refuses changes none.
    const payloads = items.map((item) => this.stored(item));
    return {
      items: items.map((item, i) => {
        const payload = payloads[i]!;
        const stored = this.thread.get(item.id);
        if (!stored) {
          const at = new Date().toISOString();
          const added = {
            ...structuredClone(item),
            payload,
            at,
            seq: ++this.itemSeq,
          } as StoredItem;
          this.thread.set(item.id, added);
          return { id: item.id, seq: added.seq, streaming: added.streaming };
        }
        if (stored.streaming) {
          stored.payload = payload as never;
          stored.streaming = item.streaming;
        }
        return { id: item.id, seq: stored.seq, streaming: stored.streaming };
      }),
    };
  }

  async putState(runner: string, state: StateRequest): Promise<StateResponse> {
    await this.enter("putState", runner);
    this.states.push(structuredClone(state));
    // As the API's row: kept until the next report of it.
    if (state.branch !== undefined) this.branch = structuredClone(state.branch);
    if (state.claudeSessionId) this.sessionInfo.claudeSessionId = state.claudeSessionId;
    return { seq: this.doc.seq };
  }

  async ask(runner: string, question: QuestionRequest): Promise<void> {
    await this.enter("ask", runner);
    if (!this.questions.has(question.id))
      this.questions.set(question.id, { ...structuredClone(question), status: "open" });
  }

  async withdraw(runner: string, ids: string[]): Promise<void> {
    await this.enter("withdraw", runner);
    for (const id of ids) {
      const question = this.questions.get(id);
      if (question?.status === "open") question.status = "cancelled";
    }
  }

  async upload(
    runner: string,
    files: UploadFile[],
    opts: { seq?: number } = {},
  ): Promise<Uploaded[]> {
    await this.enter("upload", runner);
    return files.map((file) => {
      this.uploads.push({ ...file, ...(opts.seq === undefined ? {} : { seq: opts.seq }) });
      return this.placed(file);
    });
  }

  /** Where an uploaded file is served from, and an asset's reference. */
  placed(file: { purpose: string; name: string }): Uploaded {
    const asset = file.purpose === "asset";
    const url = `${this.sessionInfo.assetBase}/${asset ? "" : `${file.purpose}s/`}${file.name}`;
    return { name: file.name, ref: asset ? `assets/${file.name}` : null, url };
  }

  async gitCredential(runner: string, ask: GitCredentialRequest): Promise<GitCredentialResponse> {
    await this.enter("gitCredential", runner);
    const { repo } = this.sessionInfo;
    if (!repo) throw new ApiError(404, "not_found", "This canvas has no repository.");
    if (ask.host !== "github.com" || ask.path !== `${repo.owner}/${repo.name}.git`)
      throw new ApiError(403, "forbidden", "That is not this canvas's repository.");
    return {
      username: "x-access-token",
      password: this.gitToken?.password ?? "ghs_fake",
      expiresAt: this.gitToken?.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  async eraseGitCredential(runner: string, ask: GitCredentialRequest): Promise<void> {
    await this.enter("eraseGitCredential", runner);
    this.erased.push(ask);
  }

  /** What the runner told the API's log of git and GitHub, in order. */
  readonly gitReports: GitReport[] = [];

  async reportGit(runner: string, report: GitReport): Promise<void> {
    await this.enter("reportGit", runner);
    this.gitReports.push(structuredClone(report));
  }

  async recordUsage(runner: string, turns: TurnUsage[]): Promise<void> {
    await this.enter("recordUsage", runner);
    for (const turn of turns) this.usage.set(turn.id, structuredClone(turn));
  }

  /** Every report of what Claude Code offers, in the order they came. */
  readonly modelReports: ModelsReport[] = [];
  /** While false, a report is not kept: the account has another credential now. */
  keepModels = true;

  /** As the API does: kept, the next session says it holds it, as reported now. */
  async reportModels(runner: string, report: ModelsReport): Promise<ModelsResponse> {
    await this.enter("reportModels", runner);
    this.modelReports.push(structuredClone(report));
    if (!this.keepModels) return { kept: false };
    this.sessionInfo.models = { ...structuredClone(report), at: new Date().toISOString() };
    return { kept: true };
  }

  /** The agent's pull request summaries, in the order they came. */
  readonly summaries: string[] = [];
  /** The canvas's pull request as the app shows it: what claims and summaries answer. None here. */
  pullRequest: PullRequestState | null = null;
  /** Answer as an API older than the pull request's state did: claims without `pullRequest`. */
  older = false;

  async pullRequestSummary(runner: string, summary: string): Promise<PullRequestSummaryResponse> {
    await this.enter("pullRequestSummary", runner);
    this.summaries.push(summary);
    const open = this.pullRequest;
    const written = open && (open.state === "open" || open.state === "draft");
    return written
      ? { pullRequest: open.number, open, kept: null }
      : { pullRequest: null, open, kept: "none_open" };
  }

  /** What the agent asked of its pull request, in order: each call's action, turn and commit. */
  readonly prCalls: ({ action: AgentPullRequestAction | "read" } & AgentPullRequestRequest)[] = [];
  /**
   * How the API refuses the agent's pull request calls: an error for an action, or null to do it.
   * By default every action is done, as for a person's turn.
   */
  refusePullRequest: (
    action: AgentPullRequestAction,
    request: AgentPullRequestRequest,
  ) => ApiError | null = () => null;
  /** Where the pull request stands beyond its number and state, as GitHub would say it. */
  prDetail: Partial<NonNullable<PullRequestStanding["pullRequest"]>> = {};
  /**
   * Whether the turn named is a person's, as the API decides it from the feed: a person's
   * message, answer or comment. A turn this fake's feed doesn't hold counts as one when named.
   */
  personTurn: (turn: string | null) => boolean = (turn) => {
    const event = this.events.find((held) => held.event.id === turn)?.event;
    if (!event) return turn !== null;
    return ["message", "answer", "comment"].includes(event.kind) && event.from !== null;
  };

  async readPullRequest(runner: string, turn: string | null): Promise<PullRequestStanding> {
    await this.enter("readPullRequest", runner);
    this.prCalls.push({ action: "read", turn });
    return this.standing(turn);
  }

  async actOnPullRequest(
    runner: string,
    action: AgentPullRequestAction,
    request: AgentPullRequestRequest,
  ): Promise<AgentPullRequestAnswer> {
    await this.enter("actOnPullRequest", runner);
    this.prCalls.push({ action, ...structuredClone(request) });
    const refused = this.refusePullRequest(action, request);
    if (refused) throw refused;
    // As the API holds to it: only a person's turn may land the pull request.
    if (["ready", "auto_merge", "merge"].includes(action) && !this.personTurn(request.turn)) {
      throw new ApiError(
        403,
        "turn_not_from_person",
        "No person in Ponzu began this turn. Only a person's own message, answer or comment in Ponzu can have Claude do this.",
      );
    }
    const pr = this.pullRequest;
    const open = pr?.state === "open" || pr?.state === "draft";
    let did = true;
    if (action === "open") {
      if (open) did = false;
      else this.pullRequest = { number: (pr?.number ?? 0) + 1, state: "draft" };
    } else if (action === "merge" && pr?.state === "merged") {
      // Merged already, as by someone else first: answered as it is, done by nobody now.
      did = false;
    } else if (!open) {
      throw new ApiError(409, "no_pull_request", "This canvas has no pull request yet.");
    } else if (action === "ready") {
      did = pr!.state === "draft";
      this.pullRequest = { ...pr!, state: "open" };
    } else if (action === "merge") {
      this.pullRequest = { ...pr!, state: "merged" };
    } else if (action === "auto_merge") {
      // As the API answers: nothing is left to wait for on one that can merge now.
      if (this.standing(request.turn).pullRequest?.mergeState === "clean") {
        throw new ApiError(
          409,
          "already_mergeable",
          "This pull request can merge now; there is nothing for auto-merge to wait for.",
        );
      }
      this.prDetail = { ...this.prDetail, autoMerge: { enabledBy: "ada" } };
    }
    return { did, pushing: false, ...this.standing(request.turn) };
  }

  private standing(turn: string | null): PullRequestStanding {
    const pr = this.pullRequest;
    const branch = this.sessionInfo.branch ?? "pz/branch";
    const personTurn = this.personTurn(turn);
    return {
      branch: { name: branch, base: "main", exists: true, aheadBy: 1, behindBy: 0 },
      pullRequest: pr && {
        number: pr.number,
        url: `https://github.com/north/fern/pull/${pr.number}`,
        title: this.sessionInfo.canvas.name,
        state: pr.state,
        headSha: "a".repeat(40),
        author: "ada",
        mergedBy: pr.state === "merged" ? "ada" : null,
        mergeable: true,
        mergeState: pr.state === "draft" ? "draft" : "clean",
        reviewDecision: null,
        autoMerge: null,
        checks: { state: "passing", complete: true, items: [] },
        reviews: [],
        unresolved: [],
        mergeHold: null,
        ...this.prDetail,
      },
      mergeMethod: "squash",
      autoMergeAllowed: true,
      nextAction: !pr ? "create_pr" : pr.state === "draft" ? "ready" : "merge",
      actingAs: { name: ADA.name, login: ADA.login! },
      personTurn,
      notPersonTurn: personTurn ? null : "No person in Ponzu began this turn.",
    };
  }

  async commit(runner: string, ops: Parameters<SyncTransport["commit"]>[0]) {
    await this.enter("commit", runner);
    return this.transport.commit(ops);
  }

  async fetchOps(runner: string, after: number) {
    await this.enter("fetchOps", runner);
    return this.transport.fetchOps(after);
  }

  async fetchDoc(runner: string) {
    await this.enter("fetchDoc", runner);
    return this.transport.fetchDoc();
  }

  /** What the thread keeps of a notice: the person behind a stop is the API's to say. */
  private stored(item: ThreadWrite): StoredItem["payload"] {
    if (item.kind !== "notice") return structuredClone(item.payload);
    const notice = item.payload;
    if (!RUNNER_NOTICES.has(notice.type))
      throw new ApiError(400, "invalid_request", `A runner does not write ${notice.type} notices.`);
    if (notice.type !== "stopped") return structuredClone(notice);
    const stop = this.events.find((e) => e.event.id === notice.eventId)?.event;
    if (stop?.kind !== "stop")
      throw new ApiError(400, "invalid_request", "That is not one of this canvas's stops.");
    return { type: "stopped", by: stop.from } satisfies Notice;
  }

  private async enter(call: Call, runner?: string): Promise<void> {
    this.calls.push(call);
    const delay = this.delays.get(call);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.down) throw new TypeError("fetch failed");
    if (this.revoked) throw new ApiError(401, "token_invalid", "This runner token is not valid.");
    const failure = this.failing.get(call);
    if (failure) throw failure;
    if (runner !== undefined && runner !== this.runner)
      throw new ApiError(409, "superseded", "A newer runner has started for this canvas.");
  }
}
