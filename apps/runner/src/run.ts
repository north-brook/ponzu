import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Actor, Replica } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import {
  type AgentFiles,
  type AgentStatus,
  CLOUD_INSTRUCTIONS,
  type CloudHost,
  type CloudWorkspace,
  cloudTools,
  createCloudWorkspace,
  runTool,
  type ToolCaller,
  type ToolDef,
  ToolError,
  tool,
} from "@ponzu/tools";
import { z } from "zod";
import type {
  Agent,
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentTool,
  Ask,
  Reply,
  SessionHistory,
  TurnError,
} from "./agent/agent.ts";
import { type ApiError, fatal, type RunnerApi, retryable, watchFatal } from "./api/api.ts";
import {
  type AgentState,
  CLAIM_LIMIT,
  type GitCredentialRequest,
  type GitCredentialResponse,
  HEARTBEAT_MS,
  MAX_PULL_REQUEST_SUMMARY,
  type ModelUsage,
  type PullRequestState,
  type PullRequestSummaryResponse,
  type QuestionBody,
  type QuestionRequest,
  type RunnerEvent,
  type RunnerNotice,
  type RunnerSession,
  type TurnUsage,
} from "./api/protocol.ts";
import { GitCredentials, type Probe } from "./git-token.ts";
import { derivedId, eventUuid, randomId } from "./ids.ts";
import { backoff as BACKOFF, Outbox } from "./pacer.ts";
import { Previews } from "./previews.ts";
import { eventText, noticeText, RUNNER_INSTRUCTIONS, turnContext } from "./prompt.ts";
import { BranchPush, type PushOutcome, pushFailureText } from "./push.ts";
import { type Boot, Checkpoints, type Recovery } from "./save/checkpoints.ts";
import type { Transcripts } from "./save/transcripts.ts";
import type { Git, WorkSaver } from "./save/work.ts";
import { StateReporter } from "./state.ts";
import { stepLabel, stepWeight } from "./steps.ts";
import { ThreadWriter } from "./thread.ts";
import { UsageMeter } from "./usage.ts";

export interface Timing {
  /** The backstop: claim this often even when nothing pokes. */
  claimEveryMs: number;
  heartbeatMs: number;
  /** The least time between two thread writes, and between two state reports. */
  threadGapMs: number;
  stateGapMs: number;
  /** The least time between two calls of each other kind: acks, questions, usage. */
  batchGapMs: number;
  /** How long the end of a turn waits for the agent's edits to reach the API. */
  settleMs: number;
  /** How long each step of shutting down may take. */
  stopStepMs: number;
  /** How long the canvas must be still before its previews are drawn. */
  previewDelayMs: number;
  /** The wait before Claude Code is started again after it stopped by itself. */
  restartMs: number;
  /**
   * Getting ready to sleep: how long a running turn may go on finishing, and how long the
   * checkpoint may take. The API stops the sandbox after its own wait whatever happens.
   */
  quiesceTurnMs: number;
  checkpointMs: number;
  /** The waits between tries of a push that may pass again (push.ts). */
  pushWaitsMs: number[];
  /** How long getting ready to sleep may spend pushing. */
  quiescePushMs: number;
  /** The waits between checks that GitHub honours a token for git (git-token.ts). */
  gitReadyWaitsMs: number[];
  /** The wait before a failed call is made again, after `failures` in a row. */
  backoff(failures: number): number;
}

export const TIMING: Timing = {
  claimEveryMs: 60_000,
  heartbeatMs: HEARTBEAT_MS,
  threadGapMs: 300,
  stateGapMs: 500,
  batchGapMs: 250,
  settleMs: 10_000,
  stopStepMs: 2_500,
  previewDelayMs: 3_000,
  restartMs: 2_000,
  quiesceTurnMs: 15_000,
  checkpointMs: 10_000,
  pushWaitsMs: [2_000, 5_000, 10_000, 15_000],
  quiescePushMs: 8_000,
  gitReadyWaitsMs: [500, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000],
  backoff: BACKOFF,
};

/** How many times in a row Claude Code may stop by itself before the runner stops starting it. */
const MAX_RESTARTS = 3;

/** The tool the agent describes its branch's pull request with, beside the canvas tools. */
const SUMMARY_TOOL = "describe_pull_request";

const EVENT_KINDS = new Set<string>([
  "message",
  "answer",
  "comment",
  "edit",
  "check",
  "review",
  "stop",
  "push",
] satisfies RunnerEvent["kind"][]);

export interface RunnerOptions {
  api: RunnerApi;
  agent: Agent;
  /** Without one the tools say they cannot take screenshots, and no previews are drawn. */
  renderer?: Renderer;
  /** How the tools read and write the files the agent names: as the agent, in the image. */
  files?: AgentFiles;
  /** Gets the working directory ready and returns it (`checkout` from repo.ts). */
  prepare(session: RunnerSession): Promise<string>;
  /** Where the runner keeps what it needs across restarts. */
  stateDir: string;
  /**
   * Called once a turn has ended, its edits have settled and its checkpoint is saved, and before
   * the sandbox sleeps: put what was written (the session's transcript, the checkout, the
   * runner's own files) on the disk. A stop that turns cold loses what was still in memory.
   */
  flush?(): void | Promise<void>;
  /**
   * What a checkpoint saves in this sandbox, once the working folder is ready: the session's
   * transcripts and the work in progress (save/). Without it nothing is saved or restored.
   */
  saving?(
    session: RunnerSession,
    cwd: string,
    checkedOut: boolean,
  ): { transcripts: Transcripts | null; work: WorkSaver | null };
  /** This boot of the machine, for what is logged about a rollback. */
  boot?(): Boot;
  /**
   * The checkout's git, as the agent, for a repo design checked out at `cwd`: what the runner
   * pushes the design's branch with (push.ts). Without it the runner never pushes.
   */
  checkoutGit?(cwd: string): Git;
  /**
   * Asks GitHub whether it honours a token for a push before git gets it (git-token.ts). Without
   * one, tokens go to git as the API hands them out.
   */
  gitProbe?: Probe;
  log(message: string): void;
  /** A structured line for the journal. `log` with its JSON when absent. */
  event?(name: string, fields: Record<string, unknown>): void;
  /**
   * The API said this process must stop for good (its token is revoked, or a newer runner
   * took the lease). Called once the runner has stopped.
   */
  onFatal?(reason: string): void;
  timing?: Partial<Timing>;
}

/** Who the replica edits as. The API takes the real actor from the runner token. */
const ACTOR: Actor = { kind: "agent", id: "agent_claude", name: "Claude" };
const CALLER: ToolCaller = {
  id: "claude",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};

/** An acknowledgement, and whether the event went into the Claude session. */
interface Ack {
  id: string;
  inSession: boolean;
}

type QuestionCall = { ask: QuestionRequest } | { withdraw: string };

/** An event that goes into the session as text: every kind but a stop and a push. */
type Talk = Exclude<RunnerEvent, { kind: "stop" | "push" }>;

/** Something put into the run that Claude Code has not taken yet. */
interface Sent {
  /** The event it carries, if any. */
  event: string | null;
  human: boolean;
}

interface Work {
  id: string;
  steps: number;
  /** The step running now. */
  label: string;
  /** The step that says most about the stretch, which names it once it is over. */
  best: string;
  weight: number;
  artboards: Set<string>;
}

/**
 * The one long-lived process in a design's sandbox (docs/cloud.md, "The runner"). It opens the
 * design as a `Replica`, runs one Claude session on it with the canvas tools, puts what
 * happens to the design into that session, and writes what the agent does to the thread and
 * the design's state.
 *
 * An event is acknowledged only once the Claude session holds it: its message's uuid came
 * back from Claude Code, or, for an answer, the question's tool result did. The ack names that
 * session, so the next process resumes the session its events went into. Anything claimed and
 * not yet held is claimed again by the next process, which first reads the session's
 * transcript and acknowledges, without delivering again, whatever it already holds.
 */
export class Runner {
  private readonly api: RunnerApi;
  private readonly timing: Timing;
  private readonly thread: ThreadWriter;
  private readonly state: StateReporter;
  private readonly acks: Outbox<Ack>;
  private readonly questions: Outbox<QuestionCall>;
  private readonly turns: Outbox<TurnUsage>;
  private readonly usage: UsageMeter;

  private session!: RunnerSession;
  private cwd!: string;
  private replica!: Replica;
  private ws!: CloudWorkspace;
  private previews: Previews | null = null;
  private run: AgentRun | null = null;

  /** The Claude session the run is on, once known: Claude Code said, or it was resumed. */
  private sessionId: string | null = null;
  /** What the session held when this run of Claude Code started. */
  private history: SessionHistory | null = null;
  private historyQuestions = new Set<string>();
  private wakeItem = randomId("ti");
  private restarts = 0;
  private restarting: Promise<void> | null = null;

  /** Claimed and not yet acknowledged, by id. */
  private held = new Map<string, RunnerEvent>();
  /** Messages put into the run that Claude Code has not taken yet, by uuid. */
  private sent = new Map<string, Sent>();
  /** Edits put in beside the run, to be read with its next turn: their uuids, to their events. */
  private asides = new Map<string, string>();
  private asideUuids = new Set<string>();
  /** Canvas edits that came during a turn, for the agent to read once it next touches the canvas. */
  private later: Talk[] = [];
  /**
   * Open questions: question id to the ask the agent waits on, or to null for one that nobody
   * waits on (an earlier run asked it, or the sandbox went to sleep), whose answer goes in as
   * a message.
   */
  private asks = new Map<string, string | null>();
  /** Answers handed to the agent: ask id to the answer's event, until the tool result is in. */
  private answering = new Map<string, string>();

  /** Claude Code is in a turn: from what it took in until its result. */
  private inTurn = false;
  /** A person's stop that is ending the turn, and what had been put in behind it when it came. */
  private ending: { event: string; cancelled: Set<string> } | null = null;
  /** The agent's replies being written: API message id to the thread item and its text so far. */
  private texts = new Map<string, { item: string; text: string }>();
  private work: Work | null = null;
  private status: AgentStatus = { artboards: [] };
  /** Why the repository could not be checked out, if it could not. */
  private cloneError: string | null = null;
  /** What the last turn's failure says about Claude (its credential, its limit), until one works. */
  private claudeProblem: string | null = null;
  /** Hands git tokens GitHub honours for a push. */
  private readonly credentials: GitCredentials;
  /** Pushes the design's branch; null for Scratch and a checkout that failed. */
  private pusher: BranchPush | null = null;
  /** The pushes asked for, one after another. */
  private pushes: Promise<void> = Promise.resolve();
  /** A push the person may want to know is happening: the state says so while it lasts. */
  private pushingNow = false;
  /** The design's branch against GitHub, as the last push found it. */
  private branch: PushOutcome | null = null;
  /** The last push failure the thread was told of (head and kind), so it is said once. */
  private toldPushFailure: string | null = null;
  /** The design's pull request as the app shows it, from the last claim or tool answer. */
  private pullRequest: PullRequestState | null = null;

  private claiming: Promise<void> | null = null;
  private claimAgain = false;
  /** The claim being sent, until it is answered. */
  private claimId: string | null = null;
  private claimFailures = 0;
  /** A claim has been answered since the start: until then the state says it is waking. */
  private claimedOnce = false;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private stopping: Promise<void> | null = null;
  private fatalReason: string | null = null;
  /** Saves and restores what lives only on this disk; null until the folder is ready. */
  private checkpoints: Checkpoints | null = null;
  /** What starting found of the disk against the API's last checkpoint. */
  recovery: Recovery = { kind: "none", restored: { session: false, workspace: false } };
  /**
   * The sleep the API is putting the sandbox through, as its state answers name it: no new work
   * is claimed until it says the sandbox is awake again. `ready` once the runner said so.
   */
  private sleep: { id: string; ready: boolean } | null = null;

  constructor(private readonly opts: RunnerOptions) {
    this.api = watchFatal(opts.api, (err) => this.fatal(err));
    this.timing = { ...TIMING, ...opts.timing };
    const onError = (what: string) => (err: unknown) => this.log(`${what} failed: ${said(err)}`);
    const { backoff } = this.timing;
    this.thread = new ThreadWriter(this.api, {
      gapMs: this.timing.threadGapMs,
      onError: onError("thread write"),
      backoff,
    });
    this.state = new StateReporter(this.api, {
      gapMs: this.timing.stateGapMs,
      heartbeatMs: this.timing.heartbeatMs,
      onSeq: (seq) => this.replica?.notify(seq),
      onSleep: (sleep) => this.onSleep(sleep),
      onError: onError("state report"),
      backoff,
    });
    const gapMs = this.timing.batchGapMs;
    this.acks = new Outbox((acks) => this.sendAcks(acks), {
      gapMs,
      // An event in the session is acknowledged with the session's id, so it waits for one.
      ready: (ack) => !ack.inSession || this.sessionId !== null,
      onError: onError("ack"),
      backoff,
    });
    this.questions = new Outbox((calls) => this.sendQuestions(calls), {
      gapMs,
      onError: onError("question"),
      backoff,
    });
    this.turns = new Outbox((turns) => this.sendUsage(turns), {
      gapMs,
      onError: onError("usage"),
      backoff,
    });
    this.usage = new UsageMeter(join(opts.stateDir, "usage.json"));
    const probe = opts.gitProbe;
    this.credentials = new GitCredentials({
      api: this.api,
      // Without a probe every token counts as honoured: handed to git as the API gave it.
      probe: probe ?? (async () => 200),
      event: (name, fields) => (probe ? this.event(name, fields) : undefined),
      waitsMs: this.timing.gitReadyWaitsMs,
    });
  }

  /** Start: read the session, ready the checkout, open the design, start Claude, claim. */
  async start(): Promise<void> {
    this.session = await this.retry(() => this.api.session());
    this.notice(this.wakeItem, { type: "waking" }, true);
    this.state.set({ state: "working", status: "Waking up", claudeSessionId: null });
    this.state.start();
    // Still theirs to answer: the answer comes in as a message.
    for (const id of this.session.openQuestions) this.asks.set(id, null);

    this.cwd = await this.prepare();
    // Before Claude Code reads its transcript: a disk behind the last checkpoint gets it back.
    await this.recover();
    if (this.stopping) return;
    this.pusher = this.branchPush();
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
      ...(this.opts.files ? { files: this.opts.files } : {}),
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
    if (this.stopping) return;
    // Still waking until the first claim is answered: reporting idle now would show the person
    // nothing (and Send) for the moment between that and the run their message starts.
    this.claimTimer = setInterval(() => this.claim(), this.timing.claimEveryMs);
    this.claimTimer.unref?.();
    this.claim();
  }

  /** Something may be waiting to be claimed. What arrives is never trusted: it only starts a claim. */
  poke(): void {
    this.claim();
  }

  /**
   * Report the state now. What arrives is never trusted: only the API's answer to the report can
   * say the sandbox is going to sleep.
   */
  report(): void {
    // Not started: a report now would carry no lease, and the API would answer `superseded`.
    // The reports that start the heartbeat hear any sleep there is.
    if (this.stopping || !this.claimTimer) return;
    this.state.now();
  }

  /** What `/health` says. */
  health(): { ok: true; state: AgentState } {
    return { ok: true, state: this.state.current.state };
  }

  /**
   * A token for git, asked through this runner's lease (the agent's git holds no runner token),
   * once GitHub honours it for a push (git-token.ts).
   */
  gitCredential(ask: GitCredentialRequest): Promise<GitCredentialResponse> {
    return this.credentials.get(ask);
  }

  /** GitHub refused the token git was given. */
  eraseGitCredential(ask: GitCredentialRequest): Promise<void> {
    return this.credentials.erase(ask);
  }

  /**
   * Shut down in order, within a few seconds: stop the turn, let the agent's edits reach the
   * API, report the final state, close. Whatever was not acknowledged is claimed again next
   * time, and questions stay open for people to answer while the sandbox sleeps.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    const within = (p: Promise<unknown>) => bounded(p, this.timing.stopStepMs);
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.working && this.run) await within(this.run.interrupt());
    // A runner the API has let go of can deliver nothing more: the next one has the design.
    if (this.ws && !this.fatalReason) await this.ws.design.settled(this.timing.stopStepMs);
    this.dropAsks("The sandbox is going to sleep.");
    this.closeStreams();
    this.inTurn = false;
    this.sent.clear();
    this.asides.clear();
    this.refreshState();
    await within(
      Promise.all([
        this.thread.flush(),
        this.acks.flush(),
        this.questions.flush(),
        this.turns.flush(),
        this.state.stop(),
        this.previews?.flush(),
      ]),
    );
    if (this.run) await within(this.run.close());
    // Claude Code has written the transcript's last line: keep it, with the work, and flush.
    if (!this.fatalReason)
      await bounded(
        this.checkpoint(),
        Math.min(this.timing.checkpointMs, this.timing.stopStepMs * 2),
      );
    for (const outbox of [this.thread, this.acks, this.questions, this.turns]) outbox.close();
    this.ws?.close();
    this.replica?.close();
    await within(this.opts.renderer?.close() ?? Promise.resolve());
  }

  /** The API has let this process go: stop at once, and for good. */
  private fatal(err: ApiError): void {
    if (this.fatalReason) return;
    this.fatalReason =
      err.status === 401
        ? `The API refused the runner token: ${err.message}`
        : `Another runner took over this design: ${err.message}`;
    this.log(this.fatalReason);
    const reason = this.fatalReason;
    void this.stop().then(() => this.opts.onFatal?.(reason));
  }

  /* ---------------------------------------------------------------- */
  /* Starting                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * The disk against the API's last checkpoint (save/checkpoints.ts): behind it, or holding none
   * of it, the transcript and the work in progress come back from it. A rollback is said in the
   * log, to the API, and in the thread when the session resumes.
   */
  private async recover(): Promise<void> {
    const parts = this.opts.saving?.(this.session, this.cwd, !this.cloneError);
    if (!parts) return;
    this.checkpoints = new Checkpoints({
      api: this.api,
      stateDir: this.opts.stateDir,
      transcripts: parts.transcripts,
      work: parts.work,
      log: (m) => this.log(m),
      event: (name, fields) => this.event(name, fields),
      boot: () => this.opts.boot?.() ?? { id: null, at: null },
      flush: () => this.flushDisk(),
      // `turn_failed` is the notice whose own words the thread shows.
      notify: (message) =>
        this.notice(randomId("ti"), { type: "error", code: "turn_failed", message }),
    });
    try {
      this.recovery = await this.checkpoints.recover(this.session.saved ?? null);
    } catch (err) {
      if (fatal(err)) throw err;
      this.log(`restoring from the last checkpoint failed: ${said(err)}`);
    }
  }

  /** Save a checkpoint of the session and the work in progress, then flush the disk. */
  private async checkpoint(): Promise<void> {
    await this.checkpoints?.save(this.sessionId);
    await this.flushDisk();
  }

  private async flushDisk(): Promise<void> {
    try {
      await this.opts.flush?.();
    } catch (err) {
      this.log(`flushing the disk failed: ${said(err)}`);
    }
  }

  private event(name: string, fields: Record<string, unknown>): void {
    if (this.opts.event) this.opts.event(name, fields);
    else this.log(JSON.stringify({ event: name, designId: this.session?.design.id, ...fields }));
  }

  /* ---------------------------------------------------------------- */
  /* Sleep                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * What the API's state answer says of sleep. A stop under way makes the runner take no new
   * work, finish the turn (for a while), let its edits reach the API, save a checkpoint, flush
   * the disk and say it is ready; the API stops the sandbox after its own wait either way. The
   * sandbox awake again (a warm resume thaws this same process) makes it take work again.
   */
  private onSleep(sleep: string | null): void {
    if (sleep === null) {
      if (!this.sleep) return;
      this.sleep = null;
      this.log("awake again");
      this.state.set({ quiesced: null });
      this.claim();
      return;
    }
    if (this.sleep?.id === sleep || this.stopping) return;
    this.sleep = { id: sleep, ready: false };
    void this.quiesce(sleep).catch((err) =>
      this.log(`getting ready to sleep failed: ${said(err)}`),
    );
  }

  private async quiesce(id: string): Promise<void> {
    const current = () => this.sleep?.id === id && !this.stopping;
    this.log(`getting ready to sleep (${id})`);
    const until = Date.now() + this.timing.quiesceTurnMs;
    // A claim already out may bring work: `claim` holds back what it brings, once it is in.
    if (this.claiming) await bounded(this.claiming, this.timing.quiesceTurnMs);
    while (this.working && Date.now() < until && current()) await sleep(50);
    if (!current()) return;
    if (this.working && this.run) {
      // The stop would cut the turn anyway: end it here, so the transcript and the thread say
      // where it stopped, and the person knows to pick it up.
      this.log("the turn did not finish before the sleep: interrupting it");
      await bounded(this.interrupt(), this.timing.stopStepMs);
      this.notice(randomId("ti"), {
        type: "error",
        code: "turn_failed",
        message:
          "The sandbox had to go to sleep before Claude finished this turn. Send a message to pick it up again.",
      });
    }
    if (this.ws) await this.ws.design.settled(this.timing.settleMs);
    await bounded(
      Promise.all([
        this.thread.flush(),
        this.acks.flush(),
        this.questions.flush(),
        this.turns.flush(),
        this.previews?.flush(),
      ]),
      this.timing.stopStepMs,
    );
    await bounded(this.checkpoint(), this.timing.checkpointMs);
    // The checkpoint holds the commits whatever happens; GitHub gets them too if it can in time.
    if (current()) {
      const deadline = Date.now() + this.timing.quiescePushMs;
      await bounded(this.push("sleep", { deadline }), this.timing.quiescePushMs);
    }
    if (!current()) return;
    this.sleep!.ready = true;
    this.state.set({ quiesced: id });
    this.log("ready to sleep");
  }

  private async prepare(): Promise<string> {
    try {
      return await this.opts.prepare(this.session);
    } catch (err) {
      // The canvas still works without the code, so the run goes on in Scratch's place.
      this.cloneError = said(err);
      this.log(this.cloneError);
      this.notice(randomId("ti"), {
        type: "error",
        code: "clone_failed",
        message: this.cloneError,
      });
      return this.opts.prepare({ ...this.session, repo: null, branch: null });
    }
  }

  private async startAgent(resume: string | null): Promise<void> {
    let history: SessionHistory | null = null;
    try {
      history = resume ? await this.opts.agent.history(resume) : null;
    } catch (err) {
      // An unreadable transcript is a lost one: the session starts over, and whatever is held
      // goes into the new one.
      this.log(`could not read the session's transcript: ${said(err)}`);
    }
    if (this.stopping) return;
    this.history = history;
    this.historyQuestions = new Set(
      [...(history?.toolResults ?? [])].map((id) => derivedId("q", id)),
    );
    // A resumed session keeps its id; a new one says its id when it starts.
    this.sessionId = history ? resume : null;
    // Said once, when the runner starts: Claude Code itself says nothing until its first turn.
    this.notice(this.wakeItem, { type: history ? "resumed" : "started" });
    const run = this.opts.agent.start({
      cwd: this.cwd,
      // A session whose transcript is gone (the sandbox was rebuilt) cannot be resumed.
      resume: history ? resume : null,
      model: this.session.model,
      effort: this.session.effort,
      instructions: this.instructions(),
      tools: this.tools().map((def) => this.tool(def)),
    });
    this.run = run;
    this.consume(run).catch((err) => this.log(`reading Claude Code failed: ${said(err)}`));
    if (this.sessionId) {
      this.state.set({ claudeSessionId: this.sessionId });
      this.acks.kick();
    }
  }

  /** What Claude is told about this sandbox, after Ponzu's own instructions. */
  private instructions(): string {
    const { design, repo, branch, link } = this.session;
    const where = !repo
      ? `This design has no repository: ${this.cwd} is an empty folder for your own files.`
      : this.cloneError
        ? `The design's repository, ${repo.owner}/${repo.name}, could not be checked out (${this.cloneError}), so ${this.cwd} is an empty folder. Work on the canvas only, and tell the person the code is out of reach until the sandbox starts again.`
        : [
            `The repository ${repo.owner}/${repo.name} is checked out at ${this.cwd}, on the design's branch ${branch}. Commit as you go and push the branch (git push sets its upstream itself).`,
            "If a push fails, don't work around it or guess why: Ponzu pushes the branch itself when your turn ends, trying again, and tells the person if it still can't.",
            "Ponzu doesn't open a pull request by itself, and there is no GitHub API token here: the person opens it with Create PR in Ponzu once the branch has commits. Each turn starts by saying whether a pull request is open.",
            `Once the branch has your change, write what it changes with ${SUMMARY_TOOL}: a few lines of Markdown for a reviewer, what changed and why. Its answer says what it did: updated the open pull request's description, or saved it for the one the person will open. Never say you opened or updated a pull request unless that answer named it.`,
            "End a turn by saying in plain words where the work stands: what is committed and whether it is on GitHub, that the description is ready, and, when no pull request is open, that they can press Create PR when they're ready.",
          ].join(" ");
    const naming = `The design's name titles its pull request and the commit that merges it. If it is still the person's first words rather than a name, give it one in your first turn with update_design: two to four words for what is being designed, like "Quieter shop hero".`;
    return `${CLOUD_INSTRUCTIONS}\n\nThis sandbox's design is "${design.name}" (${link}). ${naming} ${where}\n\n${RUNNER_INSTRUCTIONS}`;
  }

  /** The canvas tools, and for a design with a repo, the one that describes its pull request. */
  private tools(): ToolDef<any>[] {
    if (!this.session.repo || this.cloneError) return cloudTools;
    const api = this.api;
    const describe = tool({
      name: SUMMARY_TOOL,
      title: "Write pull request description",
      group: "converse",
      description:
        "Write what the design's branch changes, as its pull request's description: a few lines of Markdown for a reviewer, what changed and why. When a pull request is open, Ponzu updates its description on GitHub; when none is, Ponzu saves it as the description of the one the person opens with Create PR. The answer says which. Call it again when the story changes; the last one wins.",
      input: {
        summary: z.string().min(1).max(MAX_PULL_REQUEST_SUMMARY).describe("Markdown."),
      },
      handler: async ({ summary }) => {
        let saved: PullRequestSummaryResponse;
        try {
          saved = await api.pullRequestSummary(summary);
        } catch (err) {
          throw new ToolError(`Ponzu could not take it: ${said(err)}`);
        }
        if (saved.open !== undefined) this.pullRequest = saved.open;
        const unpushed = await this.pusher?.unpushed().catch(() => 0);
        return { text: summaryAnswer(saved, unpushed ?? 0) };
      },
    });
    return [...cloudTools, describe];
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
        this.deliverLater("next");
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
    // Not started: a poke that comes first is answered by the claim that ends `start`, which
    // the design and Claude Code are ready for.
    if (this.stopping || !this.claimTimer) return;
    // Going to sleep, or just thawed from it: what arrives now waits in the feed until the API
    // says the sandbox is awake. A warm wake only pokes, so ask it now; an answer with no sleep
    // claims (`onSleep`).
    if (this.sleep) {
      this.state.now();
      return;
    }
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = (async () => {
      do {
        this.claimAgain = false;
        try {
          // Kept until a claim is answered: one that is sent again after no answer hands out
          // again what it handed out, rather than leaving that with nobody.
          this.claimId ??= randomId("clm");
          const { events, seq, pullRequest } = await this.api.claim({
            claimId: this.claimId,
            limit: CLAIM_LIMIT,
          });
          this.claimFailures = 0;
          if (pullRequest !== undefined) this.pullRequest = pullRequest;
          this.replica.notify(seq);
          if (this.sleep) {
            // The sleep came while this claim was out: nothing it brought starts a turn the stop
            // would cut. Unacknowledged, they are handed out again to the same claim id (this
            // process, after a warm wake) or to the next runner (after a cold one).
            break;
          }
          this.claimId = null;
          for (const event of events) this.take(event);
          // The first answer ends the start: working on what it handed out, or idle.
          if (!this.claimedOnce) {
            this.claimedOnce = true;
            this.refreshState();
            // What a turn left unpushed before this start, or a restore brought back.
            void this.push("start");
          }
          // A full page: there may be more behind it.
          if (events.length >= CLAIM_LIMIT) this.claimAgain = true;
        } catch (err) {
          if (fatal(err)) break;
          this.log(`claim failed: ${said(err)}`);
          const wait = Math.min(
            this.timing.backoff(++this.claimFailures),
            this.timing.claimEveryMs,
          );
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
      this.ack(event.id, false);
      return;
    }
    if (event.kind === "push") {
      // Create PR, with commits only this sandbox holds: pushed now, without the agent.
      this.ack(event.id, false);
      void this.push("asked");
      return;
    }
    if (this.inSession(event)) {
      this.ack(event.id, true);
      return;
    }
    if (event.kind === "stop") {
      this.stopTurn(event);
      return;
    }
    if (event.kind === "answer") {
      const { questionId } = event.payload;
      const askId = this.asks.get(questionId);
      this.asks.delete(questionId);
      if (askId) {
        this.answering.set(askId, event.id);
        const { answers, approved, note } = event.payload;
        this.run?.reply(askId, { answers, approved, note } satisfies Reply);
        this.refreshState();
        return;
      }
      // The run that asked is gone: the answer goes in as a message.
    }
    if (event.priority === "later") {
      if (this.working) this.later.push(event);
      else this.aside(event);
      return;
    }
    this.deliverLater("next");
    // A turn starts with where the branch and its pull request stand, as the app shows them.
    const context = this.working ? null : this.context();
    const text = context ? `${eventText(event)}\n\n${context}` : eventText(event);
    this.send(eventUuid(event.id), text, event.priority === "now" ? "now" : "next", {
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

  /**
   * Canvas edits from during a turn: `next` once the agent is at the canvas, or before
   * whatever is put in next; `aside` when the turn is over, to be read with the next one.
   */
  private deliverLater(how: "next" | "aside"): void {
    for (const event of this.later.splice(0)) {
      if (how === "aside") this.aside(event);
      else
        this.send(eventUuid(event.id), eventText(event), "next", { human: false, event: event.id });
    }
  }

  /** Into the session without starting a turn, so it is held there, and acknowledged. */
  private aside(event: Talk): void {
    if (!this.run) {
      void this.restartAgent();
      return;
    }
    const uuid = eventUuid(event.id);
    this.asides.set(uuid, event.id);
    this.asideUuids.add(uuid);
    this.run.send({ uuid, text: eventText(event), priority: "aside", human: false });
  }

  private send(
    uuid: string,
    text: string,
    priority: AgentInput["priority"],
    opts: { human: boolean; event: string | null },
  ): void {
    if (!this.run) {
      // Claude Code gave up starting: try again, which puts back every event held.
      void this.restartAgent();
      return;
    }
    this.sent.set(uuid, { event: opts.event, human: opts.human });
    this.run.send({ uuid, text, priority, human: opts.human });
    this.refreshState();
  }

  /** In a turn, or about to be: something was put in that Claude Code has not taken yet. */
  private get working(): boolean {
    return this.inTurn || this.sent.size > 0;
  }

  /**
   * A person's stop ends the running turn and whatever had been put in behind it: what Claude
   * Code takes of that afterwards is interrupted as it starts.
   */
  private stopTurn(event: RunnerEvent): void {
    const done = () => this.ack(event.id, false);
    if (!this.working || !this.run) {
      done();
      return;
    }
    this.ending = { event: event.id, cancelled: new Set(this.sent.keys()) };
    if (!this.inTurn) {
      done();
      return;
    }
    this.interrupt().then(done);
  }

  private interrupt(): Promise<void> {
    return (
      this.run?.interrupt().catch((err) => this.log(`interrupt failed: ${said(err)}`)) ??
      Promise.resolve()
    );
  }

  private ack(id: string, inSession: boolean): void {
    this.held.delete(id);
    this.acks.put(id, { id, inSession });
  }

  private async sendAcks(acks: Ack[]): Promise<void> {
    try {
      await this.api.ack(
        acks.map((a) => a.id),
        this.sessionId,
      );
    } catch (err) {
      if (retryable(err)) throw err;
      // Refused outright: the next process claims them again and finds them in the session.
      this.log(`ack refused: ${said(err)}`);
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
        this.taken(event.uuids);
        break;
      case "dropped":
        this.dropped(event.uuids);
        break;
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
          this.ack(answered, true);
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
    this.acks.kick();
  }

  private taken(uuids: string[]): void {
    let interrupt = false;
    for (const uuid of uuids) {
      const aside = this.asides.get(uuid);
      if (aside) {
        this.asides.delete(uuid);
        this.ack(aside, true);
      }
      const sent = this.sent.get(uuid);
      if (sent) {
        this.sent.delete(uuid);
        if (sent.event) this.ack(sent.event, true);
      }
      if (this.ending?.cancelled.delete(uuid)) interrupt = true;
    }
    if (uuids.every((u) => this.asideUuids.has(u))) return;
    // A new turn that no stop is ending: the last stop is spent.
    if (!this.inTurn && !interrupt && !this.ending?.cancelled.size) this.ending = null;
    this.inTurn = true;
    if (interrupt) void this.interrupt();
  }

  /** Claude Code is done with these. Any it never took, a repo's hook refused. */
  private dropped(uuids: string[]): void {
    for (const uuid of uuids) {
      const event = this.asides.get(uuid) ?? null;
      this.asides.delete(uuid);
      const sent = this.sent.get(uuid);
      this.sent.delete(uuid);
      const id = sent?.event ?? event;
      // A message cancelled as Claude Code shut down is the next process's to put in.
      if (!id || this.stopping) continue;
      if (this.ending?.cancelled.delete(uuid)) {
        this.ack(id, false);
        continue;
      }
      // Put in again, the repo would refuse it again: acknowledge it, and say so.
      this.log(`Claude Code turned away ${id}`);
      this.ack(id, false);
      if (sent?.human)
        this.notice(randomId("ti"), {
          type: "error",
          code: "message_refused",
          message: "The repository's Claude Code settings turned this message away.",
        });
    }
    if (!this.working) this.endTurn();
    this.refreshState();
  }

  private writeText(id: string, text: string, done: boolean): void {
    const entry = this.texts.get(id) ?? { item: randomId("ti"), text };
    entry.text = text;
    this.texts.set(id, entry);
    this.thread.write({ id: entry.item, kind: "assistant", payload: { text }, streaming: !done });
    if (done) this.texts.delete(id);
  }

  private step(name: string, input: Record<string, unknown>): void {
    const label = stepLabel(name, input, this.replica.doc);
    const weight = stepWeight(name, input);
    // The boards the agent is on carry over from the stretch before: the canvas says them only
    // when they change.
    this.work ??= {
      id: randomId("ti"),
      steps: 0,
      label,
      best: label,
      weight,
      artboards: new Set(this.status.artboards),
    };
    const work = this.work;
    work.steps++;
    work.label = label;
    if (weight >= work.weight) {
      work.best = label;
      work.weight = weight;
    }
    this.writeWork(true);
    this.refreshState();
  }

  private writeWork(streaming: boolean): void {
    const work = this.work;
    if (!work) return;
    this.thread.write({
      id: work.id,
      kind: "tool",
      payload: { label: this.label(streaming), steps: work.steps, artboards: [...work.artboards] },
      streaming,
    });
  }

  /**
   * The working line: what the agent said it is doing, or else its step running now. Once the
   * stretch is over, the step that says most about it.
   */
  private label(streaming = true): string {
    const said = this.status.status?.trim();
    if (said) return said.charAt(0).toUpperCase() + said.slice(1);
    if (!this.work) return "Working";
    return streaming ? this.work.label : this.work.best;
  }

  private finishWork(): void {
    this.writeWork(false);
    this.work = null;
  }

  /** End whatever is streaming: the turn is over, or the runner is. A reply cut off ends as it was. */
  private closeStreams(): void {
    this.finishWork();
    for (const { item, text } of this.texts.values())
      this.thread.write({ id: item, kind: "assistant", payload: { text }, streaming: false });
    this.texts.clear();
  }

  private raise(askId: string, ask: Ask): void {
    const id = derivedId("q", askId);
    // The work so far ends where the question is asked, so the thread reads in order: what it
    // did, what it asked, then what it did with the answer.
    this.finishWork();
    this.asks.set(id, askId);
    this.questions.put(`ask:${id}`, { ask: { id, ...questionBody(ask) } });
    const [header, text] =
      ask.kind === "question"
        ? [ask.questions[0]?.header ?? "Question", ask.questions[0]?.question ?? ""]
        : ask.kind === "plan"
          ? ["Plan", "Claude has a plan for you to approve."]
          : ["Permission", ask.title];
    this.notice(derivedId("ti", askId), { type: "question", questionId: id, header, text });
    this.refreshState();
  }

  /**
   * Nothing waits on the agent's questions any more. When the run moved on they are withdrawn;
   * when the sandbox is going to sleep they stay open, and an answer comes in as a message.
   */
  private dropAsks(reason: string): void {
    for (const [id, askId] of this.asks) {
      if (askId) this.run?.withdraw(askId, reason);
      if (this.stopping) {
        this.asks.set(id, null);
        continue;
      }
      this.asks.delete(id);
      // Not sent yet, it need not be.
      if (!this.questions.take(`ask:${id}`)) this.questions.put(`withdraw:${id}`, { withdraw: id });
    }
  }

  private async sendQuestions(calls: QuestionCall[]): Promise<void> {
    // In order: a question is raised before it can be withdrawn.
    const withdrawn: string[] = [];
    for (const call of calls) {
      if ("withdraw" in call) {
        withdrawn.push(call.withdraw);
        continue;
      }
      try {
        await this.api.ask(call.ask);
      } catch (err) {
        if (retryable(err)) throw err;
        this.refused(call.ask.id, err);
      }
    }
    if (!withdrawn.length) return;
    try {
      await this.api.withdraw(withdrawn);
    } catch (err) {
      if (retryable(err)) throw err;
      this.log(`withdrawing ${withdrawn.join(", ")} was refused: ${said(err)}`);
    }
  }

  /** The API would not take a question: nobody will see it, so the agent goes on without it. */
  private refused(id: string, err: unknown): void {
    this.log(`question ${id} was refused: ${said(err)}`);
    const askId = this.asks.get(id);
    this.asks.delete(id);
    if (askId)
      this.run?.withdraw(
        askId,
        "Ponzu could not show this question to anyone. Go on without an answer.",
      );
    this.notice(randomId("ti"), {
      type: "error",
      code: "question_failed",
      message: "Claude had a question that Ponzu could not show, so it went on without an answer.",
    });
    this.refreshState();
  }

  private async sendUsage(turns: TurnUsage[]): Promise<void> {
    try {
      await this.api.recordUsage(turns);
    } catch (err) {
      if (retryable(err)) throw err;
      this.log(`usage refused: ${said(err)}`);
    }
  }

  private result(id: string, error: TurnError | null, usage: ModelUsage[]): void {
    this.closeStreams();
    this.restarts = 0;
    if (this.sessionId) {
      const used = this.usage.turn(this.sessionId, usage);
      if (used.length)
        this.turns.put(id, {
          id,
          claudeSessionId: this.sessionId,
          at: new Date().toISOString(),
          models: used,
        });
    }
    if (error?.code === "interrupted") {
      // Written by the stop's id: a stop that ends two turns says so once.
      if (this.ending)
        this.notice(derivedId("ti", this.ending.event), {
          type: "stopped",
          eventId: this.ending.event,
        });
    } else if (error) {
      this.notice(randomId("ti"), { type: "error", code: error.code, message: error.message });
    }
    this.claudeProblem =
      error?.code === "claude_auth" || error?.code === "claude_limit" ? error.message : null;
    if (!this.ending?.cancelled.size) this.ending = null;
    // A question cannot outlive the turn that asked it, nor one an earlier run left open.
    this.dropAsks("The turn ended before anyone answered.");
    this.inTurn = false;
    if (!this.working) {
      this.deliverLater("aside");
      this.endTurn();
    }
    this.refreshState();
  }

  /**
   * Once the agent stops: wait for its edits to reach the API, and tell it of any the API
   * undid that no tool result said. Then nothing shows as worked on.
   */
  private endTurn(): void {
    const end = async () => {
      await this.ws.design.settled(this.timing.settleMs);
      if (this.working || this.stopping) return;
      const notices = this.ws.notices();
      if (notices.length) {
        this.send(randomUUID(), noticeText(notices), "next", { human: false, event: null });
        return;
      }
      this.ws.presence.leave(CALLER.id);
      // The turn's commits go to GitHub whether or not the agent pushed them.
      await this.push("turn");
      // The sandbox may be stopped at any time now: nothing of the turn may live only here.
      await this.checkpoint();
    };
    end().catch((err) => this.log(`ending the turn failed: ${said(err)}`));
  }

  private exited(error: string | null): void {
    if (this.stopping) return;
    this.log(`Claude Code stopped${error ? `: ${error}` : ""}`);
    this.closeStreams();
    // The process that asked is gone; the questions stay for people to answer as messages.
    for (const id of this.asks.keys()) this.asks.set(id, null);
    this.answering.clear();
    this.sent.clear();
    this.asides.clear();
    this.later = [];
    this.ending = null;
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
      try {
        await this.startAgent(this.sessionId ?? this.session.claudeSessionId);
        for (const event of [...this.held.values()]) this.route(event);
      } catch (err) {
        this.log(`starting Claude Code again failed: ${said(err)}`);
        this.notice(randomId("ti"), {
          type: "error",
          code: "agent_exited",
          message: "Claude Code could not be started. Send a message to try again.",
        });
      }
      this.refreshState();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  /* ---------------------------------------------------------------- */
  /* The branch on GitHub                                              */
  /* ---------------------------------------------------------------- */

  /** What pushes the design's branch, for a repo design that is checked out. */
  private branchPush(): BranchPush | null {
    const { repo, branch } = this.session;
    if (!repo || !branch || this.cloneError || !this.opts.checkoutGit) return null;
    const ask = { protocol: "https", host: "github.com", path: `${repo.owner}/${repo.name}.git` };
    return new BranchPush({
      git: this.opts.checkoutGit(this.cwd),
      branch,
      defaultBranch: repo.defaultBranch,
      erase: (reason) => this.credentials.erase({ ...ask, reason }),
      event: (name, fields) => this.event(name, fields),
      waitsMs: this.timing.pushWaitsMs,
    });
  }

  /**
   * Push the design's branch if GitHub lacks commits of it (push.ts), one push at a time, and say
   * how it stands: to the API with the state (what Create PR goes by), and in the thread when a
   * push failed for good. The end of a turn, a sleep, a start and a person's Create PR ask for it.
   */
  private push(why: "turn" | "sleep" | "start" | "asked", opts: { deadline?: number } = {}) {
    const pusher = this.pusher;
    if (!pusher || this.fatalReason) return Promise.resolve();
    const run = async () => {
      try {
        const ahead = await pusher.unpushed();
        // Said while it lasts, but not on the way to sleep: that would read as work to keep awake for.
        if ((ahead > 0 || why === "asked") && why !== "sleep") {
          this.pushingNow = true;
          this.refreshState();
        }
        const outcome = await pusher.push(opts);
        this.branch = outcome;
        const error = outcome.failure
          ? pushFailureText(outcome.failure, {
              branch: pusher.branchName,
              repo: `${this.session.repo!.owner}/${this.session.repo!.name}`,
              unpushed: Math.max(outcome.unpushed, 1),
            })
          : null;
        this.state.set({ branch: { unpushed: outcome.unpushed, error } });
        if (!outcome.failure || !error) {
          this.toldPushFailure = null;
          return;
        }
        // Said once for a commit and a reason, and again whenever a person asked.
        const told = `${await pusher.head()}:${outcome.failure.kind}`;
        if (why === "asked" || told !== this.toldPushFailure) {
          this.toldPushFailure = told;
          this.notice(randomId("ti"), { type: "error", code: "push_failed", message: error });
        }
      } catch (err) {
        if (fatal(err)) return;
        this.log(`pushing the branch failed: ${said(err)}`);
      } finally {
        if (this.pushingNow) {
          this.pushingNow = false;
          this.refreshState();
        }
      }
    };
    this.pushes = this.pushes.then(run, run);
    return this.pushes;
  }

  /** Where the branch and its pull request stand, for the start of a turn. */
  private context(): string | null {
    const { repo, branch } = this.session;
    if (!repo || !branch || this.cloneError) return null;
    return turnContext({
      branch,
      pullRequest: this.pullRequest,
      unpushed: this.branch?.unpushed ?? 0,
      pushFailed: this.branch?.failure?.said.split("\n").at(-1) ?? null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Out                                                               */
  /* ---------------------------------------------------------------- */

  private refreshState(): void {
    const waiting = [...this.asks.values()];
    const state: AgentState = waiting.some((a) => a)
      ? "needs_you"
      : this.working || this.pushingNow
        ? "working"
        : waiting.length
          ? "needs_you"
          : "idle";
    this.state.set({
      state,
      status:
        state !== "working"
          ? (this.claudeProblem ?? this.cloneProblem)
          : this.working
            ? this.label()
            : "Pushing to GitHub",
      artboards: this.status.artboards,
    });
  }

  private get cloneProblem(): string | null {
    return this.cloneError ? "Couldn't get the repository" : null;
  }

  private notice(id: string, payload: RunnerNotice, streaming = false): void {
    this.thread.write({ id, kind: "notice", payload, streaming });
  }

  /** `call`, again after a growing wait while it fails in a way another try could mend. */
  private async retry<T>(call: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await call();
      } catch (err) {
        if (!retryable(err) || this.stopping) throw err;
        await sleep(this.timing.backoff(n));
      }
    }
  }

  private log(message: string): void {
    this.opts.log(message);
  }
}

/**
 * What `describe_pull_request` tells the agent it did, in words it can repeat to the person: the
 * open pull request's description updated on GitHub, or saved for the one the person opens.
 */
export function summaryAnswer(saved: PullRequestSummaryResponse, unpushed: number): string {
  if (saved.pullRequest !== null) {
    return `Updated the description of pull request #${saved.pullRequest} on GitHub.`;
  }
  const open = saved.open;
  if (open && (open.state === "open" || open.state === "draft")) {
    return saved.kept === "rewritten"
      ? `Pull request #${open.number} is open, but its description was rewritten on GitHub, so Ponzu left it as it is. Your words are saved in Ponzu.`
      : `Pull request #${open.number} is open, but Ponzu couldn't reach it on GitHub just now, so its description is unchanged. Your words are saved, and go in when you call this again.`;
  }
  const pending =
    unpushed > 0
      ? ` The branch has ${unpushed === 1 ? "a commit" : `${unpushed} commits`} GitHub doesn't have yet; Ponzu pushes ${unpushed === 1 ? "it" : "them"} when your turn ends.`
      : "";
  return `Saved as the description the pull request will open with. No pull request is open yet: the person opens it with Create PR in Ponzu.${pending}`;
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
