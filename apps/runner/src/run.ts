import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Actor, Replica } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import {
  type AgentStatus,
  CLOUD_INSTRUCTIONS,
  type CloudHost,
  type CloudWorkspace,
  cloudTools,
  createCloudWorkspace,
  runTool,
  type ToolCaller,
  type ToolDef,
} from "@ponzu/tools";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  AgentTool,
  Ask,
  Reply,
  SessionHistory,
  TurnError,
} from "./agent/agent.ts";
import { type RunnerApi, retryable } from "./api/api.ts";
import {
  type AgentState,
  HEARTBEAT_MS,
  type ModelUsage,
  type Notice,
  type Person,
  type QuestionBody,
  type RunnerEvent,
  type RunnerSession,
} from "./api/protocol.ts";
import { derivedId, eventUuid, randomId } from "./ids.ts";
import { Pacer } from "./pacer.ts";
import { Previews } from "./previews.ts";
import { eventText, noticeText } from "./prompt.ts";
import { StateReporter } from "./state.ts";
import { stepLabel } from "./steps.ts";
import { ThreadWriter } from "./thread.ts";
import { UsageMeter } from "./usage.ts";

export interface Timing {
  /** The backstop: claim this often even when nothing pokes. */
  claimEveryMs: number;
  heartbeatMs: number;
  /** The least time between two thread writes, two state reports, two acknowledgements. */
  threadGapMs: number;
  stateGapMs: number;
  ackGapMs: number;
  /** How long the end of a turn waits for the agent's edits to reach the API. */
  settleMs: number;
  /** How long each step of shutting down may take. */
  stopStepMs: number;
  /** How long the canvas must be still before its previews are drawn. */
  previewDelayMs: number;
  /** The wait before Claude Code is started again after it stopped by itself. */
  restartMs: number;
}

export const TIMING: Timing = {
  claimEveryMs: 60_000,
  heartbeatMs: HEARTBEAT_MS,
  threadGapMs: 300,
  stateGapMs: 500,
  ackGapMs: 250,
  settleMs: 10_000,
  stopStepMs: 2_500,
  previewDelayMs: 3_000,
  restartMs: 2_000,
};

/** How many times in a row Claude Code may stop by itself before the runner stops starting it. */
const MAX_RESTARTS = 3;

const EVENT_KINDS = new Set<string>([
  "message",
  "answer",
  "comment",
  "edit",
  "check",
  "review",
  "stop",
] satisfies RunnerEvent["kind"][]);

export interface RunnerOptions {
  api: RunnerApi;
  agent: Agent;
  /** Without one the tools say they cannot take screenshots, and no previews are drawn. */
  renderer?: Renderer;
  /** Gets the working directory ready and returns it (`checkout` from repo.ts). */
  prepare(session: RunnerSession): Promise<string>;
  /** Where the runner keeps what it needs across restarts. */
  stateDir: string;
  log(message: string): void;
  timing?: Partial<Timing>;
}

/** Who the replica edits as. The API takes the real actor from the runner token. */
const ACTOR: Actor = { kind: "agent", id: "agent_claude", name: "Claude" };
const CALLER: ToolCaller = {
  id: "claude",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};

/**
 * The one long-lived process in a design's sandbox (docs/cloud.md, "The runner"). It opens the
 * design as a `Replica`, runs one Claude session on it with the canvas tools, puts what
 * happens to the design into that session, and writes what the agent does to the thread and
 * the design's state.
 *
 * An event is acknowledged only once the Claude session holds it: its message's uuid came
 * back from Claude Code, or, for an answer, the question's tool result did. Anything claimed
 * and not yet held is claimed again by the next process, which first reads the session's
 * transcript and acknowledges, without delivering again, whatever it already holds.
 */
export class Runner {
  private readonly api: RunnerApi;
  private readonly timing: Timing;
  private readonly thread: ThreadWriter;
  private readonly state: StateReporter;
  private readonly acks: Pacer;
  private readonly usage: UsageMeter;

  private session!: RunnerSession;
  private cwd!: string;
  private replica!: Replica;
  private ws!: CloudWorkspace;
  private previews: Previews | null = null;
  private run: AgentRun | null = null;

  /** The Claude session, once Claude Code has said. */
  private sessionId: string | null = null;
  /** What the session held when this run of Claude Code started. */
  private history: SessionHistory | null = null;
  private historyQuestions = new Set<string>();
  private wakeItem = randomId("ti");
  private restarts = 0;
  private restarting: Promise<void> | null = null;

  /** Claimed and not yet acknowledged, by id. */
  private held = new Map<string, RunnerEvent>();
  private toAck = new Set<string>();
  /** Messages put into the run that Claude Code has not taken yet: uuid to the event, if any. */
  private sent = new Map<string, string | null>();
  /** Canvas edits waiting for the agent to next touch the canvas. */
  private later: Exclude<RunnerEvent, { kind: "stop" }>[] = [];
  /** Open questions: question id to the agent's ask id. */
  private asks = new Map<string, string>();
  /** Answers handed to the agent: ask id to the answer's event, until the tool result is in. */
  private answering = new Map<string, string>();

  /** Claude Code is in a turn: from what it took in until its result. */
  private inTurn = false;
  private stoppedBy: Person | null | undefined;
  private texts = new Map<string, string>();
  private work: { id: string; steps: number; label: string; artboards: Set<string> } | null = null;
  private status: AgentStatus = { artboards: [] };
  /** What the design's row says while the agent is not working, when something is wrong. */
  private problem: string | null = null;

  private claiming: Promise<void> | null = null;
  private claimAgain = false;
  private claimFailures = 0;
  private restarted = false;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  /** Calls made in the background, which shutting down waits for. */
  private calls = new Set<Promise<unknown>>();
  private stopping: Promise<void> | null = null;

  constructor(private readonly opts: RunnerOptions) {
    this.api = opts.api;
    this.timing = { ...TIMING, ...opts.timing };
    const onError = (what: string) => (err: unknown) => this.log(`${what} failed: ${said(err)}`);
    this.thread = new ThreadWriter(this.api, {
      gapMs: this.timing.threadGapMs,
      onError: onError("thread write"),
    });
    this.state = new StateReporter(this.api, {
      gapMs: this.timing.stateGapMs,
      heartbeatMs: this.timing.heartbeatMs,
      onSeq: (seq) => this.replica?.notify(seq),
      onError: onError("state report"),
    });
    this.acks = new Pacer(() => this.sendAcks(), this.timing.ackGapMs, onError("ack"));
    this.usage = new UsageMeter(join(opts.stateDir, "usage.json"));
  }

  /** Start: read the session, ready the checkout, open the design, start Claude, claim. */
  async start(): Promise<void> {
    this.session = await this.retry(() => this.api.session());
    this.notice(this.wakeItem, { type: "waking" }, true);
    this.state.set({ state: "working", status: "Waking up", claudeSessionId: null });
    this.state.start();
    if (this.session.openQuestions.length) {
      const stale = this.session.openQuestions;
      this.background(() => this.api.withdraw(stale));
    }

    this.cwd = await this.prepare();
    this.replica = await this.retry(() =>
      Replica.open({ transport: this.api.sync, schedule: timer, actor: ACTOR }),
    );
    // Stopped while the checkout or the design was on its way: there is nothing to start.
    if (this.stopping) return;
    this.replica.notify(this.session.seq);
    this.ws = createCloudWorkspace({
      id: this.session.design.id,
      replica: this.replica,
      renderer: this.opts.renderer,
      host: this.host(),
    });
    if (this.opts.renderer) {
      this.previews = new Previews({
        replica: this.replica,
        design: this.ws.design,
        renderer: this.opts.renderer,
        api: this.api,
        assetBase: this.session.assetBase,
        delayMs: this.timing.previewDelayMs,
        settleMs: this.timing.settleMs,
        log: (m) => this.log(m),
      });
      this.replica.onOp((_op, _actor, _doc, info) => {
        if (!info.echo) this.previews?.changed();
      });
    }

    await this.startAgent(this.session.claudeSessionId);
    this.refreshState();
    this.claim();
    this.claimTimer = setInterval(() => this.claim(), this.timing.claimEveryMs);
    this.claimTimer.unref?.();
  }

  /** Something may be waiting to be claimed. What arrives is never trusted: it only starts a claim. */
  poke(): void {
    this.claim();
  }

  /** What `/health` says. */
  health(): { ok: true; state: AgentState } {
    return { ok: true, state: this.state.current.state };
  }

  /**
   * Shut down in order, within a few seconds: stop the turn, let the agent's edits reach the
   * API, report the final state, close. Whatever was not acknowledged is claimed again next
   * time.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    const within = (p: Promise<unknown>) => bounded(p, this.timing.stopStepMs);
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.working && this.run) await within(this.run.interrupt());
    if (this.ws) await this.ws.design.settled(this.timing.stopStepMs);
    this.withdrawAsks("The sandbox is going to sleep.");
    this.closeStreams();
    this.inTurn = false;
    this.sent.clear();
    this.refreshState();
    await within(
      Promise.all([
        this.thread.flush(),
        this.acks.flush(),
        this.state.stop(),
        this.previews?.flush(),
        ...this.calls,
      ]),
    );
    if (this.run) await within(this.run.close());
    this.thread.close();
    this.acks.close();
    this.ws?.close();
    this.replica?.close();
    await within(this.opts.renderer?.close() ?? Promise.resolve());
  }

  /* ---------------------------------------------------------------- */
  /* Starting                                                          */
  /* ---------------------------------------------------------------- */

  private async prepare(): Promise<string> {
    try {
      return await this.opts.prepare(this.session);
    } catch (err) {
      // The canvas still works without the code, so the run goes on in Scratch's place.
      const message = said(err);
      this.log(message);
      this.notice(randomId("ti"), { type: "error", code: "clone_failed", message });
      this.problem = "Couldn't get the repository";
      return this.opts.prepare({ ...this.session, repo: null, branch: null });
    }
  }

  private async startAgent(resume: string | null): Promise<void> {
    this.history = resume ? await this.opts.agent.history(resume) : null;
    this.historyQuestions = new Set(
      [...(this.history?.toolResults ?? [])].map((id) => derivedId("q", id)),
    );
    // Said once, when the runner starts: Claude Code itself says nothing until its first turn.
    this.notice(this.wakeItem, { type: this.history ? "resumed" : "started" });
    const run = this.opts.agent.start({
      cwd: this.cwd,
      // A session whose transcript is gone (the sandbox was rebuilt) cannot be resumed.
      resume: this.history ? resume : null,
      model: this.session.model,
      effort: this.session.effort,
      instructions: this.instructions(),
      tools: cloudTools.map((def) => this.tool(def)),
    });
    this.run = run;
    void this.consume(run);
  }

  /** What Claude is told about this sandbox, after Ponzu's own instructions. */
  private instructions(): string {
    const { design, repo, branch, link } = this.session;
    const where =
      repo && branch && this.cwd.endsWith(repo.name)
        ? `The repository ${repo.owner}/${repo.name} is checked out at ${this.cwd}, on the design's branch ${branch}. Commit as you go and push the branch (git push sets its upstream itself). Ponzu opens and merges the pull request: there is no GitHub API token here, so don't try to open one yourself.`
        : `This design has no repository: ${this.cwd} is an empty folder for your own files.`;
    return `${CLOUD_INSTRUCTIONS}\n\nThis sandbox's design is "${design.name}" (${link}). ${where}`;
  }

  private tool(def: ToolDef<any>): AgentTool {
    const ctx = { ws: this.ws, caller: CALLER };
    return {
      name: def.name,
      description: def.description,
      input: def.input,
      readOnly: def.readOnly,
      destructive: def.destructive,
      run: async (args) => {
        const result = await runTool(def, args, ctx);
        // The agent is at the canvas: what people did to it is next for it to read.
        this.deliverLater();
        return result;
      },
    };
  }

  private host(): CloudHost {
    return {
      status: (status) => {
        this.status = status;
        if (this.work) {
          for (const id of status.artboards) this.work.artboards.add(id);
          this.writeWork(true);
        }
        this.refreshState();
      },
      // The API has nowhere to keep a request's intent yet.
      intent: () => {},
      storeAsset: async (asset) => {
        const [stored] = await this.api.upload([
          { purpose: "asset", name: asset.name, contentType: asset.mime, bytes: asset.bytes },
        ]);
        return stored!.ref!;
      },
      assetBase: () => this.session.assetBase,
      publish: async (file) => {
        const [stored] = await this.api.upload([
          { purpose: "export", name: file.name, contentType: file.mime, bytes: file.bytes },
        ]);
        return stored!.url;
      },
      link: () => this.session.link,
      theme: () => this.session.theme ?? undefined,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Events in                                                         */
  /* ---------------------------------------------------------------- */

  private claim(): void {
    if (this.stopping) return;
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = (async () => {
      do {
        this.claimAgain = false;
        try {
          const { events, seq } = await this.api.claim(this.restarted ? {} : { restart: true });
          this.restarted = true;
          this.claimFailures = 0;
          this.replica.notify(seq);
          for (const event of events) this.take(event);
        } catch (err) {
          this.log(`claim failed: ${said(err)}`);
          const wait = Math.min(1_000 * 2 ** this.claimFailures++, this.timing.claimEveryMs);
          setTimeout(() => this.claim(), wait).unref?.();
        }
      } while (this.claimAgain && !this.stopping);
      this.claiming = null;
    })();
  }

  private take(event: RunnerEvent): void {
    if (this.held.has(event.id)) return;
    this.held.set(event.id, event);
    this.route(event);
  }

  /** Put an event where it belongs: into the run, to a waiting question, or aside for later. */
  private route(event: RunnerEvent): void {
    if (!EVENT_KINDS.has(event.kind)) {
      // From an API newer than this runner. Held, it would come back on every start.
      this.log(`an event of a kind this runner does not know: ${event.kind}`);
      this.ack(event.id);
      return;
    }
    if (this.inSession(event)) {
      this.ack(event.id);
      return;
    }
    if (event.kind === "stop") {
      this.stopTurn(event);
      return;
    }
    if (event.kind === "answer") {
      const askId = this.asks.get(event.payload.questionId);
      if (askId) {
        this.asks.delete(event.payload.questionId);
        this.answering.set(askId, event.id);
        const { answers, approved, note } = event.payload;
        this.run?.reply(askId, { answers, approved, note } satisfies Reply);
        this.refreshState();
        return;
      }
      // The run that asked is gone: the answer goes in as a message.
    }
    if (event.priority === "later") {
      this.later.push(event);
      return;
    }
    this.deliverLater();
    this.send(eventUuid(event.id), eventText(event), event.priority === "now" ? "now" : "next", {
      human: event.kind !== "check" && event.kind !== "edit",
      event: event.id,
    });
  }

  /** Whether the session already holds the event, from before this run of Claude Code. */
  private inSession(event: RunnerEvent): boolean {
    if (!this.history) return false;
    if (this.history.messages.has(eventUuid(event.id))) return true;
    return event.kind === "answer" && this.historyQuestions.has(event.payload.questionId);
  }

  /** Canvas edits go in once the agent is at the canvas, or before whatever starts its next turn. */
  private deliverLater(): void {
    for (const event of this.later.splice(0)) {
      this.send(eventUuid(event.id), eventText(event), "next", { human: false, event: event.id });
    }
  }

  private send(
    uuid: string,
    text: string,
    priority: "now" | "next",
    opts: { human: boolean; event: string | null },
  ): void {
    if (!this.run) {
      // Claude Code gave up starting: try again, which puts back every event held.
      void this.restartAgent();
      return;
    }
    this.sent.set(uuid, opts.event);
    this.run.send({ uuid, text, priority, human: opts.human });
    this.refreshState();
  }

  /** In a turn, or about to be: something was put in that Claude Code has not taken yet. */
  private get working(): boolean {
    return this.inTurn || this.sent.size > 0;
  }

  private stopTurn(event: RunnerEvent): void {
    const done = () => this.ack(event.id);
    if (!this.working || !this.run) {
      done();
      return;
    }
    this.stoppedBy = event.from;
    this.run.interrupt().then(done, (err) => {
      this.log(`interrupt failed: ${said(err)}`);
      done();
    });
  }

  private ack(id: string): void {
    this.toAck.add(id);
    this.acks.kick();
  }

  private async sendAcks(): Promise<void> {
    const ids = [...this.toAck];
    if (!ids.length) return;
    await this.api.ack(ids);
    for (const id of ids) {
      this.toAck.delete(id);
      this.held.delete(id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* The run                                                           */
  /* ---------------------------------------------------------------- */

  private async consume(run: AgentRun): Promise<void> {
    for await (const event of run) {
      try {
        this.handle(event);
      } catch (err) {
        this.log(`handling ${event.type} failed: ${said(err)}`);
      }
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.type) {
      case "ready":
        this.ready(event.sessionId, event.problems);
        break;
      case "taken":
        this.inTurn = true;
        for (const uuid of event.uuids) {
          if (!this.sent.has(uuid)) continue;
          const id = this.sent.get(uuid);
          this.sent.delete(uuid);
          if (id) this.ack(id);
        }
        break;
      case "dropped": {
        // Never in the session, so not acknowledged: the next process puts it in again.
        for (const uuid of event.uuids) this.sent.delete(uuid);
        if (!this.working) void this.endTurn();
        this.refreshState();
        break;
      }
      case "text":
        this.inTurn = true;
        this.finishWork();
        this.writeText(event.id, event.text, event.done);
        break;
      case "tool":
        this.inTurn = true;
        this.step(event.name, event.input);
        break;
      case "tool-done": {
        const answered = this.answering.get(event.id);
        if (answered) {
          this.answering.delete(event.id);
          this.ack(answered);
        }
        break;
      }
      case "ask":
        this.raise(event.id, event.ask);
        break;
      case "result":
        this.result(event.id, event.error, event.usage);
        break;
      case "exit":
        this.exited(event.error);
        break;
    }
  }

  private ready(sessionId: string, problems: string[]): void {
    this.sessionId = sessionId;
    for (const problem of problems) this.log(problem);
    this.state.set({ claudeSessionId: sessionId });
  }

  private writeText(id: string, text: string, done: boolean): void {
    let item = this.texts.get(id);
    if (!item) {
      item = randomId("ti");
      this.texts.set(id, item);
    }
    this.thread.write({ id: item, kind: "assistant", payload: { text }, streaming: !done });
    if (done) this.texts.delete(id);
  }

  private step(name: string, input: Record<string, unknown>): void {
    this.work ??= { id: randomId("ti"), steps: 0, label: "", artboards: new Set() };
    this.work.steps++;
    this.work.label = stepLabel(name, input, this.replica.doc);
    this.writeWork(true);
    this.refreshState();
  }

  private writeWork(streaming: boolean): void {
    const work = this.work;
    if (!work) return;
    this.thread.write({
      id: work.id,
      kind: "tool",
      payload: { label: this.label(), steps: work.steps, artboards: [...work.artboards] },
      streaming,
    });
  }

  /** The working line: what the agent said it is doing, or else what its last step was. */
  private label(): string {
    const said = this.status.status?.trim();
    if (said) return said.charAt(0).toUpperCase() + said.slice(1);
    return this.work?.label ?? "Working";
  }

  private finishWork(): void {
    this.writeWork(false);
    this.work = null;
  }

  /** End whatever is streaming: the turn is over, or the runner is. */
  private closeStreams(): void {
    this.finishWork();
    this.texts.clear();
  }

  private raise(askId: string, ask: Ask): void {
    const id = derivedId("q", askId);
    this.asks.set(id, askId);
    const body = questionBody(ask);
    this.background(() => this.api.ask({ id, ...body }));
    const [header, text] =
      ask.kind === "question"
        ? [ask.questions[0]?.header ?? "Question", ask.questions[0]?.question ?? ""]
        : ask.kind === "plan"
          ? ["Plan", "Claude has a plan for you to approve."]
          : ["Permission", ask.title];
    this.notice(derivedId("ti", askId), { type: "question", questionId: id, header, text });
    this.refreshState();
  }

  /** Nobody need answer what the agent asked: the run moved on. */
  private withdrawAsks(reason: string): void {
    if (!this.asks.size) return;
    const ids = [...this.asks.keys()];
    for (const askId of this.asks.values()) this.run?.withdraw(askId, reason);
    this.asks.clear();
    this.background(() => this.api.withdraw(ids));
  }

  private result(id: string, error: TurnError | null, usage: ModelUsage[]): void {
    this.closeStreams();
    this.restarts = 0;
    if (this.sessionId) {
      const used = this.usage.turn(this.sessionId, usage);
      const claudeSessionId = this.sessionId;
      if (used.length)
        this.background(() =>
          this.api.recordUsage([
            { id, claudeSessionId, at: new Date().toISOString(), models: used },
          ]),
        );
    }
    if (error?.code === "interrupted") {
      if (this.stoppedBy !== undefined)
        this.notice(randomId("ti"), { type: "stopped", by: this.stoppedBy });
    } else if (error) {
      this.notice(randomId("ti"), { type: "error", code: error.code, message: error.message });
    }
    this.stoppedBy = undefined;
    // A question cannot outlive the turn that asked it.
    this.withdrawAsks("The turn ended before anyone answered.");
    this.inTurn = false;
    if (!this.working) void this.endTurn();
    this.refreshState();
  }

  /**
   * Once the agent stops: wait for its edits to reach the API, and tell it of any the API
   * undid that no tool result said. Then nothing shows as worked on.
   */
  private async endTurn(): Promise<void> {
    await this.ws.design.settled(this.timing.settleMs);
    if (this.working || this.stopping) return;
    const notices = this.ws.notices();
    if (notices.length) {
      this.send(randomUUID(), noticeText(notices), "next", { human: false, event: null });
      return;
    }
    this.ws.presence.leave(CALLER.id);
  }

  private exited(error: string | null): void {
    if (this.stopping) return;
    this.log(`Claude Code stopped${error ? `: ${error}` : ""}`);
    this.closeStreams();
    this.withdrawAsks("Claude Code stopped.");
    this.answering.clear();
    this.sent.clear();
    this.later = [];
    this.inTurn = false;
    this.run = null;
    if (++this.restarts > MAX_RESTARTS) {
      // Until the next event, which starts it again (`send`) with a fresh count.
      this.restarts = 0;
      this.notice(randomId("ti"), {
        type: "error",
        code: "agent_exited",
        message: "Claude Code keeps stopping. Send a message to try again.",
      });
      this.refreshState();
      return;
    }
    this.notice(randomId("ti"), {
      type: "error",
      code: "agent_exited",
      message: "Claude Code stopped and is starting again.",
    });
    this.refreshState();
    setTimeout(() => void this.restartAgent(), this.timing.restartMs).unref?.();
  }

  /** Start Claude Code again on the same session, and put back what it had not taken. */
  private restartAgent(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.restarting ??= (async () => {
      await this.startAgent(this.sessionId ?? this.session.claudeSessionId);
      for (const event of this.held.values()) if (!this.toAck.has(event.id)) this.route(event);
      this.refreshState();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  /* ---------------------------------------------------------------- */
  /* Out                                                               */
  /* ---------------------------------------------------------------- */

  private refreshState(): void {
    const state: AgentState = this.asks.size ? "needs_you" : this.working ? "working" : "idle";
    this.state.set({
      state,
      status: state === "working" ? this.label() : this.problem,
      artboards: this.status.artboards,
    });
  }

  private notice(id: string, payload: Notice, streaming = false): void {
    this.thread.write({ id, kind: "notice", payload, streaming });
  }

  /** A call nothing waits for, tried again while the API is out of reach. */
  private background(call: () => Promise<unknown>): void {
    const p = this.retry(call, 5)
      .catch((err) => this.log(`call failed: ${said(err)}`))
      .finally(() => this.calls.delete(p));
    this.calls.add(p);
  }

  /** `call`, again after a growing wait while it fails in a way another try could mend. */
  private async retry<T>(call: () => Promise<T>, attempts = Number.POSITIVE_INFINITY): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await call();
      } catch (err) {
        if (!retryable(err) || n >= attempts || this.stopping) throw err;
        await sleep(Math.min(500 * 2 ** n, 30_000));
      }
    }
  }

  private log(message: string): void {
    this.opts.log(message);
  }
}

function questionBody(ask: Ask): QuestionBody {
  switch (ask.kind) {
    case "question":
      return { kind: "question", payload: { questions: ask.questions } };
    case "plan":
      return { kind: "plan", payload: { plan: ask.plan } };
    case "permission":
      return {
        kind: "permission",
        payload: { tool: ask.tool, title: ask.title, description: ask.description },
      };
  }
}

const timer = (run: () => void, ms: number) => {
  const t = setTimeout(run, ms);
  return () => clearTimeout(t);
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `p`, or nothing after `ms`: a step of shutting down never holds the rest up. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      t = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
