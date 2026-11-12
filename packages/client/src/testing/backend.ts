import {
  type Actor,
  applyOp,
  type ClientOp,
  type CommittedOp,
  type Doc,
  emptyDoc,
  findArtboard,
  InvalidOpError,
  newId,
  newOpId,
  type Op,
  threadPage,
} from "@ponzu/core";
import { Sequencer } from "@ponzu/core/testing";
import {
  COMMENT_PICTURE,
  type QuestionBody,
  type RunErrorCode,
  type ThreadItem,
  type TurnRecord,
} from "@ponzu/runner/protocol";
import type { AnswerBody, Api } from "../api.ts";
import { type Clock, systemClock } from "../clock.ts";
import { ApiError, networkError } from "../errors.ts";
import { createLive, type Live, MAX_LIVE_QUERIES } from "../live/live.ts";
import { LIVE_COLUMNS, type LiveQueryName, type RawRow } from "../live/rows.ts";
import type { Profile } from "../rpc.ts";
import type { Session, SessionState } from "../session.ts";
import { FakeClaude } from "./claude.ts";
import { FakePullRequests } from "./pull-requests.ts";
import { type FakeQuery, FakeRealtime, fakeSeal } from "./realtime.ts";
import { FakeSettings, type SettingsWorld } from "./settings.ts";

/*
 * Ponzu Cloud in memory, behind the same interfaces as the real thing: a `Session` signed in
 * as someone, an `Api` over in-memory workspaces, canvases and threads (ops ordered by core's
 * test sequencer, as the API orders them), and a `Live` whose feed is these tables. Screens
 * and stories built on it need no network; tests drive the agent and the network by hand.
 */

type Permission = "admin" | "write" | "read" | "none";
type Role = "admin" | "member";
type CanvasView = Awaited<ReturnType<Api["canvases"]["get"]>>;
type RepoIdeasAnswer = Awaited<ReturnType<Api["repos"]["ideas"]>>;
type AgentBlocker = NonNullable<CanvasView["agentBlocker"]>;
type AgentState = CanvasView["agentState"];

export type FakePerson = Profile;

interface FakeRepo {
  id: string;
  fullName: string;
  /** Each member's access; a member not listed can push. */
  access: Map<string, Permission>;
}

interface FakeWorkspace {
  id: string;
  githubAccountId: number;
  githubLogin: string;
  name: string;
  kind: "personal" | "org";
  members: Map<string, Role>;
  /** Who owns the account on GitHub: always admins. */
  owners: Set<string>;
  repos: FakeRepo[];
  /** The App is on the account. */
  installed: boolean;
  /** It was once, so its members still have it, marked. */
  everInstalled: boolean;
  suspended: boolean;
  /** Someone has GitHub's install page open for it: the next sync finds it installed. */
  installing: boolean;
  /** People GitHub says can reach it who have not opened Ponzu. */
  githubOnly: FakeGithubOnly[];
}

/** Someone with access on GitHub who has never opened Ponzu: no user, no role. */
interface FakeGithubOnly {
  githubUserId: number;
  login: string;
  name: string | null;
  /** What they may do in each repo, by repo id; one left out they cannot reach. */
  access: Map<string, Exclude<Permission, "none">>;
}

interface FakeThreadItem {
  item: ThreadItem;
  userId: string | null;
  updatedAt: string;
}

interface FakeQuestion {
  id: string;
  seq: number;
  body: QuestionBody;
  status: "open" | "answered" | "cancelled";
  createdAt: string;
  /** Who answered it, and what they said: the `answer` event the runner is handed. */
  answer: { userId: string; body: AnswerBody } | null;
}

/** One canvas and everything under it. */
export interface FakeCanvas {
  id: string;
  workspaceId: string;
  repoId: string | null;
  ownerId: string;
  sequencer: Sequencer;
  icon: string | null;
  settledAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  /** Per person, the seqs of their own ops they may undo, newest last; and of their undos. */
  done: Map<string, number[]>;
  undone: Map<string, number[]>;
  agent: { state: AgentState; status: string | null; artboards: string[] };
  /** Why the agent can't run now, as the API's sandbox jobs say it. */
  blocker: AgentBlocker | null;
  /** The canvas's seq its previews show, once the runner has drawn them. */
  previewSeq: number | null;
  /** How many times its file links were reset, and when last: its files' address has it. */
  assetKeyResets: number;
  assetKeyRotatedAt: string | null;
  /** `pz/<topic>`, from the first message; null for Scratch and before it. */
  branch: string | null;
  /** Its branch and pull request on GitHub; null for Scratch. */
  github: FakePullRequests | null;
  /** The files people uploaded to it: `assets/<name>` to their type. */
  assets: Map<string, string>;
  /** The pictures of people's comments, `comments/<name>` to their bytes, by upload id. */
  pictures: Map<string, { ref: string; bytes: Uint8Array; userId: string }>;
  /** Stops people asked for, oldest first. */
  stops: string[];
  /** What it was made to run on, when the create said. */
  model: string | null;
  effort: string | null;
  thread: FakeThreadItem[];
  questions: FakeQuestion[];
  /** Who has it open; `focusedAt` while their window is focused and showing it. */
  presence: Map<
    string,
    { pageId: string | null; joinedAt: string; seenAt: string; focusedAt: string | null }
  >;
  reads: Map<string, { seq: number; threadSeq: number | null }>;
}

/** What one signed-in device holds. */
export interface FakeClient {
  session: Session;
  api: Api;
  live: Live;
}

export interface FakeAgent {
  /** Commit ops as the agent, as its runner would. */
  commit(ops: Op[]): CommittedOp[];
  /** Say something in the thread; while `streaming`, saying again with the same id replaces it. */
  say(text: string, opts?: { id?: string; streaming?: boolean }): string;
  /**
   * The agent's work in the thread: with `turn`, a turn's one item and its record, as a runner
   * that keeps one writes it; without, a stretch of work as an older runner wrote it. Saying
   * again with the same id replaces it while it streams.
   */
  tool(
    label: string,
    opts?: {
      id?: string;
      streaming?: boolean;
      steps?: number;
      artboards?: string[];
      turn?: TurnRecord;
    },
  ): string;
  /** Show it at work on these boards, with a working line. */
  work(artboards: string[], status?: string): void;
  idle(): void;
  /** Its sandbox starting: the head says `waking`, and the thread a `waking` notice. */
  wake(): void;
  /** A turn ended badly, as the runner says in the thread. */
  fail(code: RunErrorCode, message?: string): void;
  /** Ask the person something: a question row, a notice in the thread, and "needs you". */
  ask(body: QuestionBody, header?: string): string;
  /** The run moved on without an answer: the question is cancelled. */
  withdraw(questionId: string): void;
  /** Why the agent can't run, as the API's sandbox jobs set it; null when it can. */
  block(blocker: AgentBlocker | null): void;
  /** The runner drew the previews of the canvas as it is now. */
  preview(): void;
  /** Commits pushed to the canvas's branch on GitHub. */
  push(...files: Parameters<FakePullRequests["push"]>): string;
}

const AGENT: Actor = { kind: "agent", id: "claude", name: "Claude" };
const LIVE_NAMES = Object.keys(LIVE_COLUMNS) as LiveQueryName[];

export function createFakeBackend(opts: { clock?: Clock } = {}): FakeBackend {
  return new FakeBackend(opts.clock ?? systemClock);
}

export class FakeBackend {
  readonly realtime: FakeRealtime;
  readonly people = new Map<string, FakePerson>();
  readonly workspaces = new Map<string, FakeWorkspace>();
  readonly canvases = new Map<string, FakeCanvas>();
  /** Secrets people gave for `secret` questions, as the API keeps them: apart from the question. */
  readonly secretsGiven: { canvasId: string; name: string; value: string }[] = [];
  /**
   * What `GET /v1/repos/:id/ideas` answers for each repo, in turn: each ask takes the next
   * answer and the last one stays. A repo with none set has `none`.
   */
  readonly repoIdeas = new Map<string, RepoIdeasAnswer[]>();
  /** Each person's own Claude: connecting it, and what their canvases start on. */
  readonly claude: FakeClaude;
  /** When each person finished the guided setup steps that leave no other trace. */
  readonly onboarding = new Map<string, { whereAt: string | null; iphoneAt: string | null }>();
  /** Canvases by the person's create key: a create sent again makes nothing new. */
  private readonly createKeys = new Map<string, string>();
  /**
   * The switches `GET /v1/me` reports, as an API with none of them set: billing off, and no
   * pings or email. A test sets them to act out an API that has them.
   */
  features: Awaited<ReturnType<Api["me"]>>["features"] = {
    billing: "off",
    push: false,
    email: false,
  };
  /** While false, every call fails as if there were no network. */
  online = true;
  /** How long every call takes to answer, in real time, as a network would: none by default. */
  latencyMs = 0;
  private ids = 0;
  private refreshing = false;
  /** Each person's GitHub id, and the next one to hand out. */
  private readonly githubIds = new Map<string, number>();
  private nextGithubId = 70_001;

  /** Settings: ping toggles and devices, environments, usage and caps (`setBase`, `use`). */
  readonly settings: FakeSettings;

  constructor(readonly clock: Clock) {
    this.realtime = new FakeRealtime((query) => this.rows(query), clock);
    this.claude = new FakeClaude(clock);
    this.settings = new FakeSettings(clock);
  }

  addPerson(input: { login: string; name?: string | null }): FakePerson {
    const person: FakePerson = {
      id: this.id("usr"),
      githubLogin: input.login,
      name: input.name === undefined ? input.login : input.name,
      email: `${input.login}@example.com`,
      avatarUrl: null,
    };
    this.people.set(person.id, person);
    this.githubIds.set(person.id, this.nextGithubId++);
    return person;
  }

  /** A workspace with members and repos. Every member may push to a repo unless `access` says otherwise. */
  addWorkspace(input: {
    login: string;
    name?: string;
    kind?: "personal" | "org";
    members: Record<string, Role>;
    /** Who owns the account on GitHub. A personal account's admins own it. */
    owners?: string[];
    repos?: { name: string; access?: Record<string, Permission> }[];
    /** False: a GitHub account the App is not on yet, which "Where do you build?" offers. */
    installed?: boolean;
    suspended?: boolean;
    /**
     * People with access on GitHub who have not opened Ponzu. Each can push to every repo
     * unless `repos` (by repo name) says what they may do and where.
     */
    githubOnly?: {
      login: string;
      name?: string | null;
      repos?: Record<string, Exclude<Permission, "none">>;
    }[];
  }): { id: string; githubAccountId: number; repos: { id: string; fullName: string }[] } {
    const installed = input.installed ?? true;
    const kind = input.kind ?? "org";
    const repos = (input.repos ?? []).map((repo) => ({
      id: this.id("repo"),
      fullName: `${input.login}/${repo.name}`,
      name: repo.name,
      access: new Map(Object.entries(repo.access ?? {})),
    }));
    const workspace: FakeWorkspace = {
      id: this.id("ws"),
      githubAccountId: 1000 + this.ids,
      githubLogin: input.login,
      name: input.name ?? input.login,
      kind,
      members: new Map(Object.entries(input.members)),
      owners: new Set(
        input.owners ??
          (kind === "personal"
            ? Object.entries(input.members)
                .filter(([, role]) => role === "admin")
                .map(([id]) => id)
            : []),
      ),
      installed,
      everInstalled: installed,
      suspended: input.suspended ?? false,
      installing: false,
      repos: repos.map(({ id, fullName, access }) => ({ id, fullName, access })),
      githubOnly: (input.githubOnly ?? []).map((someone) => ({
        githubUserId: this.nextGithubId++,
        login: someone.login,
        name: someone.name === undefined ? someone.login : someone.name,
        access: new Map(
          repos.flatMap((repo) => {
            const can = someone.repos ? someone.repos[repo.name] : "write";
            return can ? [[repo.id, can] as const] : [];
          }),
        ),
      })),
    };
    this.workspaces.set(workspace.id, workspace);
    return {
      id: workspace.id,
      githubAccountId: workspace.githubAccountId,
      repos: workspace.repos.map(({ id, fullName }) => ({ id, fullName })),
    };
  }

  /** The App installed on a workspace's account, as its webhook would tell the API. */
  install(workspaceId: string): void {
    const workspace = this.workspace(workspaceId);
    Object.assign(workspace, { installed: true, everInstalled: true, installing: false });
    this.changed();
  }

  /** GitHub suspended the App on the account, or lifted the suspension. */
  suspend(workspaceId: string, suspended = true): void {
    this.workspace(workspaceId).suspended = suspended;
    this.changed();
  }

  /** The App removed from the account: its members keep the workspace, marked. */
  uninstall(workspaceId: string): void {
    this.workspace(workspaceId).installed = false;
    this.changed();
  }

  /** Mark a guided setup step done for `userId`, as another device would have. */
  finishStep(userId: string, step: "where" | "iphone"): void {
    const was = this.onboarding.get(userId) ?? { whereAt: null, iphoneAt: null };
    const at = this.now();
    this.onboarding.set(userId, {
      whereAt: step === "where" ? (was.whereAt ?? at) : was.whereAt,
      iphoneAt: step === "iphone" ? (was.iphoneAt ?? at) : was.iphoneAt,
    });
    this.changed();
  }

  private workspace(id: string): FakeWorkspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`No workspace ${id}.`);
    return workspace;
  }

  /**
   * What asking for a repo's ideas answers from now on, in turn: `setIdeas(repo, "generating",
   * ["Make checkout one page", …])` is one `generating`, then those ideas, ready.
   */
  setIdeas(repoId: string, ...answers: (RepoIdeasAnswer["status"] | string[])[]): void {
    this.repoIdeas.set(
      repoId,
      answers.map((answer) =>
        Array.isArray(answer)
          ? { status: "ready", ideas: answer.map((prompt) => ({ prompt })) }
          : { status: answer, ideas: [] },
      ),
    );
  }

  /** A device signed in as `person`. */
  connect(person: FakePerson): FakeClient {
    const api = this.apiFor(person);
    return {
      session: fakeSession(person),
      api,
      live: createLive({ api, transport: this.realtime, clock: this.clock }),
    };
  }

  canvas(id: string): FakeCanvas {
    const canvas = this.canvases.get(id);
    if (!canvas) throw new Error(`No canvas ${id}.`);
    return canvas;
  }

  /** The canvas's runner, played by hand. */
  agent(canvasId: string): FakeAgent {
    const canvas = this.canvas(canvasId);
    return {
      commit: (ops) => {
        const result = canvas.sequencer.commit(
          ops.map((op) => ({ id: newOpId(), op })),
          AGENT,
        );
        this.touch(canvas);
        // A test that hands the agent an op that cannot apply has a bug: say so.
        if (result.rejected.length) throw new Error(`Rejected: ${result.rejected[0]!.reason}`);
        return result.committed;
      },
      say: (text, { id = this.id("ti"), streaming = false } = {}) => {
        const existing = canvas.thread.find((entry) => entry.item.id === id);
        if (existing?.item.streaming) {
          existing.item = { ...existing.item, payload: { text }, streaming } as ThreadItem;
          existing.updatedAt = this.now();
        } else if (!existing) {
          this.append(canvas, { kind: "assistant", payload: { text } }, null, streaming, id);
        }
        this.touch(canvas);
        return id;
      },
      tool: (
        label,
        { id = this.id("ti"), streaming = true, steps = 1, artboards = [], turn } = {},
      ) => {
        const payload = { label, steps, artboards, ...(turn ? { turn } : {}) };
        const existing = canvas.thread.find((entry) => entry.item.id === id);
        if (existing?.item.streaming) {
          existing.item = { ...existing.item, payload, streaming } as ThreadItem;
          existing.updatedAt = this.now();
        } else if (!existing) {
          this.append(canvas, { kind: "tool", payload }, null, streaming, id);
        }
        this.touch(canvas);
        return id;
      },
      work: (artboards, status) => {
        canvas.agent = { state: "working", status: status ?? null, artboards };
        this.touch(canvas);
      },
      idle: () => {
        canvas.agent = { state: "idle", status: null, artboards: [] };
        this.touch(canvas);
      },
      wake: () => {
        canvas.agent = { state: "waking", status: null, artboards: [] };
        this.append(canvas, { kind: "notice", payload: { type: "waking" } });
        this.touch(canvas);
      },
      fail: (code, message = "") => {
        this.append(canvas, { kind: "notice", payload: { type: "error", code, message } });
        canvas.agent = { state: "idle", status: null, artboards: [] };
        this.touch(canvas);
      },
      withdraw: (questionId) => {
        const question = canvas.questions.find((q) => q.id === questionId);
        if (question?.status === "open") {
          question.status = "cancelled";
          this.settings.resolve(canvas.id, question.id);
        }
        if (!canvas.questions.some((q) => q.status === "open")) canvas.agent.state = "idle";
        this.touch(canvas);
      },
      block: (blocker) => {
        canvas.blocker = blocker;
        this.touch(canvas);
      },
      preview: () => {
        canvas.previewSeq = canvas.sequencer.seq;
        this.touch(canvas);
      },
      push: (...files) => {
        if (!canvas.github) throw new Error("A Scratch canvas has no branch.");
        return canvas.github.push(...files);
      },
      ask: (body, header = "A question") => {
        const id = this.id("q");
        const seq = this.nextThreadSeq(canvas);
        canvas.questions.push({
          id,
          seq,
          body,
          status: "open",
          createdAt: this.now(),
          answer: null,
        });
        const text =
          body.kind === "question" ? (body.payload.questions[0]?.question ?? "") : header;
        this.append(canvas, {
          kind: "notice",
          payload: { type: "question", questionId: id, header, text },
        });
        canvas.agent = { ...canvas.agent, state: "needs_you" };
        this.touch(canvas);
        return id;
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* The API, as one person                                            */
  /* ---------------------------------------------------------------- */

  private apiFor(person: FakePerson): Api {
    const actor: Actor = {
      kind: "user",
      id: person.id,
      name: person.name ?? person.githubLogin,
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
    };
    const call = async <T>(run: () => T): Promise<T> => {
      await (this.latencyMs > 0
        ? new Promise((resolve) => setTimeout(resolve, this.latencyMs))
        : Promise.resolve());
      if (!this.online) throw networkError(new Error("offline"));
      return run();
    };
    const readable = (id: string) => {
      const canvas = this.canvases.get(id);
      if (!canvas || this.permission(person.id, canvas) === "none") {
        throw new ApiError(404, "not_found", "There is no such canvas.");
      }
      return canvas;
    };
    const writable = (id: string) => {
      const canvas = readable(id);
      if (!canWrite(this.permission(person.id, canvas))) {
        throw new ApiError(403, "forbidden", "You can only look at this canvas.");
      }
      return canvas;
    };
    const github = (canvas: FakeCanvas) => {
      if (!canvas.github) {
        throw new ApiError(409, "no_repository", "A Scratch canvas has no repository.");
      }
      return canvas.github;
    };
    const member = (workspaceId: string) => {
      const workspace = this.workspaces.get(workspaceId);
      const role = workspace?.members.get(person.id);
      if (!workspace || !role) throw new ApiError(404, "not_found", "There is no such workspace.");
      return { workspace, role };
    };
    const commit = (canvas: FakeCanvas, ops: ClientOp[]) => {
      let result: ReturnType<Sequencer["commit"]>;
      try {
        result = canvas.sequencer.commit(ops, actor);
      } catch (error) {
        if (error instanceof InvalidOpError) {
          throw new ApiError(400, "invalid_request", error.message);
        }
        throw error;
      }
      const done = canvas.done.get(person.id) ?? [];
      for (const op of result.committed) if (!done.includes(op.seq)) done.push(op.seq);
      canvas.done.set(person.id, done);
      if (result.committed.length) canvas.undone.set(person.id, []);
      // A new comment or reply reaches the thread with its commit, as the API's statement does.
      const doc = canvas.sequencer.doc;
      for (const { op } of result.committed) {
        for (const comment of commentsIn(op, doc)) {
          const payload = { ...comment, from: personOf(person) };
          this.append(canvas, { kind: "comment", payload }, person.id);
        }
      }
      this.touch(canvas);
      return result;
    };
    const reverse = (canvas: FakeCanvas, kind: "undo" | "redo") => {
      const from = kind === "undo" ? canvas.done : canvas.undone;
      const to = kind === "undo" ? canvas.undone : canvas.done;
      const seq = from.get(person.id)?.pop();
      if (seq === undefined) {
        throw new ApiError(409, `nothing_to_${kind}`, `There is nothing to ${kind}.`);
      }
      const before = JSON.parse(canvas.sequencer.history[seq - 1]!) as Doc;
      const inverse = applyOp(before, canvas.sequencer.log[seq - 1]!.op);
      const { committed } = canvas.sequencer.commit([{ id: newOpId(), op: inverse }], actor);
      const reversal = committed[0];
      if (!reversal) throw new ApiError(409, `nothing_to_${kind}`, `There is nothing to ${kind}.`);
      to.set(person.id, [...(to.get(person.id) ?? []), reversal.seq]);
      this.touch(canvas);
      return { committed: reversal, seq: canvas.sequencer.seq };
    };
    const summary = (workspace: FakeWorkspace, role: Role) => ({
      id: workspace.id,
      githubAccountId: workspace.githubAccountId,
      githubLogin: workspace.githubLogin,
      name: workspace.name,
      kind: workspace.kind,
      avatarUrl: null,
      role,
      installed: workspace.installed,
      suspended: workspace.suspended,
    });
    /** The workspaces the person is in: those the App is or was on. */
    const mine = () =>
      [...this.workspaces.values()].flatMap((workspace) => {
        const role = workspace.members.get(person.id);
        return role && workspace.everInstalled ? [{ workspace, role }] : [];
      });
    // The person's own account first, then each one with the App that they reach.
    const accounts = () => ({
      accounts: [...this.workspaces.values()]
        .filter(
          (workspace) =>
            workspace.members.has(person.id) &&
            (workspace.installed || workspace.kind === "personal"),
        )
        .toSorted((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"))
        .map((workspace) => ({
          githubAccountId: workspace.githubAccountId,
          login: workspace.githubLogin,
          name: workspace.name,
          avatarUrl: null,
          kind: workspace.kind,
          status: workspace.installed ? ("ready" as const) : ("not_installed" as const),
          workspaceId: workspace.installed ? workspace.id : null,
          suspended: workspace.suspended,
          // Everyone GitHub says can reach it, whether or not they have opened Ponzu.
          memberCount:
            workspace.kind === "org" && workspace.installed
              ? workspace.members.size + workspace.githubOnly.length
              : null,
        })),
    });
    const onboarding = () => {
      const done = this.onboarding.get(person.id);
      return { whereConfirmedAt: done?.whereAt ?? null, iphoneStepSeenAt: done?.iphoneAt ?? null };
    };
    const claudeApi = this.claude.api(person.id, () => this.claudeChanged(person.id));
    const memberRow = (workspace: FakeWorkspace, userId: string) => {
      const who = this.people.get(userId)!;
      return {
        userId,
        githubLogin: who.githubLogin,
        name: who.name,
        avatarUrl: who.avatarUrl,
        role: workspace.members.get(userId)!,
        githubAccess: workspace.owners.has(userId) ? ("owner" as const) : ("member" as const),
      };
    };
    /** Someone who has opened Ponzu, as the API's `people` lists them. */
    const joinedRow = (workspace: FakeWorkspace, userId: string) => {
      const row = memberRow(workspace, userId);
      return {
        githubUserId: this.githubIds.get(userId)!,
        githubLogin: row.githubLogin,
        name: row.name,
        avatarUrl: row.avatarUrl,
        joined: true,
        userId,
        role: row.role,
        githubAccess: row.githubAccess,
      };
    };
    /** Someone who has not, yet. */
    const githubOnlyRow = (someone: FakeGithubOnly) => ({
      githubUserId: someone.githubUserId,
      githubLogin: someone.login,
      name: someone.name,
      avatarUrl: null,
      joined: false,
      userId: null,
      role: null,
      githubAccess: "member" as const,
    });
    const byName = (a: { name: string | null; githubLogin: string }, b: typeof a) =>
      (a.name ?? a.githubLogin).localeCompare(b.name ?? b.githubLogin);
    /** Everyone who can reach a workspace: joined admins, joined members, then the rest. */
    const peopleOf = (workspace: FakeWorkspace) => [
      ...[...workspace.members.keys()]
        .map((userId) => joinedRow(workspace, userId))
        .toSorted(
          (a, b) => Number(b.role === "admin") - Number(a.role === "admin") || byName(a, b),
        ),
      ...workspace.githubOnly.map(githubOnlyRow).toSorted(byName),
    ];

    return {
      me: () =>
        call(() => ({
          user: person,
          onboarding: onboarding(),
          privacy: { shareUsage: this.settings.sharing.get(person.id) ?? true },
          claudeAccount: this.claude.view(person.id),
          workspaces: mine().map(({ workspace, role }) => summary(workspace, role)),
          features: { ...this.features },
        })),
      onboarding: (step) =>
        call(() => {
          this.finishStep(person.id, step);
          return onboarding();
        }),
      claude: claudeApi,
      github: {
        accounts: () => call(accounts),
        // GitHub is asked again: an install page that was open has finished by now.
        sync: () =>
          call(() => {
            for (const workspace of this.workspaces.values()) {
              if (workspace.installing && workspace.members.has(person.id)) {
                this.install(workspace.id);
              }
            }
            return accounts();
          }),
        installLink: (body) =>
          call(() => {
            const account = [...this.workspaces.values()].find(
              (workspace) =>
                workspace.githubAccountId === body.githubAccountId &&
                workspace.members.has(person.id) &&
                !workspace.installed,
            );
            if (account) account.installing = true;
            return {
              id: "auth_fake",
              url: "https://github.com/apps/ponzu-dev/installations/new?state=fake",
              expiresAt: new Date(this.clock.now() + 15 * 60_000).toISOString(),
            };
          }),
        // GitHub's page is played by the test, which says how it went with a link: an install
        // asked about is always still waiting.
        install: () =>
          call(() => ({
            status: "waiting" as const,
            expiresAt: new Date(this.clock.now() + 15 * 60_000).toISOString(),
          })),
      },
      workspaces: {
        list: () =>
          call(() => ({
            workspaces: mine().map(({ workspace, role }) => summary(workspace, role)),
          })),
        get: (id) =>
          call(() => {
            const { workspace, role } = member(id);
            return {
              workspace: {
                ...summary(workspace, role),
                installation: workspace.installed
                  ? {
                      id: workspace.githubAccountId,
                      repositorySelection: "selected" as const,
                      installedAt: null,
                      installedBy: null,
                      suspendedAt: workspace.suspended ? this.now() : null,
                    }
                  : null,
              },
              repos: workspace.repos
                .filter((repo) => repoPermission(repo, person.id) !== "none")
                .map((repo) => ({
                  id: repo.id,
                  fullName: repo.fullName,
                  name: repo.fullName.split("/")[1]!,
                  defaultBranch: "main",
                  private: true,
                  pushedAt: null,
                  canPush: canWrite(repoPermission(repo, person.id)),
                })),
              members: [...workspace.members.keys()].map((userId) => memberRow(workspace, userId)),
              people: peopleOf(workspace),
            };
          }),
        canvases: (id) =>
          call(() => {
            member(id);
            return {
              canvases: this.visibleCanvases(id, person.id).map((canvas) =>
                listRow(this.headOf(canvas), canvas, person.id),
              ),
            };
          }),
        setRole: (id, userId, role) =>
          call(() => {
            const { workspace, role: mineRole } = member(id);
            if (mineRole !== "admin") throw new ApiError(403, "forbidden", "Admins only.");
            if (!workspace.members.has(userId)) {
              throw new ApiError(404, "not_found", "There is no such member in this workspace.");
            }
            const admins = [...workspace.members.values()].filter((r) => r === "admin").length;
            if (role === "member" && workspace.owners.has(userId)) {
              throw new ApiError(
                409,
                "owner_is_admin",
                "They own it on GitHub, so they're an admin.",
              );
            }
            if (role === "member" && workspace.members.get(userId) === "admin" && admins === 1) {
              throw new ApiError(409, "last_admin", "A workspace needs an admin.");
            }
            workspace.members.set(userId, role);
            this.changed();
            return { member: memberRow(workspace, userId) };
          }),
      },
      repos: {
        ideas: (id) =>
          call(() => {
            const repo = [...this.workspaces.values()]
              .filter((workspace) => workspace.members.has(person.id))
              .flatMap((workspace) => workspace.repos)
              .find((candidate) => candidate.id === id);
            if (!repo || repoPermission(repo, person.id) === "none") {
              throw new ApiError(404, "not_found", "There is no such repo.");
            }
            const answers = this.repoIdeas.get(id) ?? [];
            const answer = answers.length > 1 ? answers.shift()! : answers[0];
            return answer ?? { status: "none" as const, ideas: [] };
          }),
      },
      canvases: {
        create: (body) =>
          call(() => {
            const key = body.createKey ? `${person.id}:${body.createKey}` : null;
            const made = key ? this.createKeys.get(key) : undefined;
            if (made) return this.view(readable(made), person.id);
            const { workspace } = member(body.workspaceId);
            const repo = body.repoId
              ? workspace.repos.find((candidate) => candidate.id === body.repoId)
              : null;
            if (body.repoId && !repo)
              throw new ApiError(404, "not_found", "There is no such repo.");
            if (repo && !canWrite(repoPermission(repo, person.id))) {
              throw new ApiError(403, "forbidden", "Canvases need a repo you can push to.");
            }
            if (body.model !== undefined || body.effort !== undefined) {
              this.claude.checkOffered(
                person.id,
                body.model ?? this.claude.defaultsOf(person.id).model,
                body.effort,
              );
            }
            const name = body.name ?? "Untitled";
            const doc: Doc = {
              ...emptyDoc(name),
              pages: [{ id: newId("pg"), name: "Page 1", artboards: [] }],
            };
            const branch = repo ? `pz/${topic(name)}` : null;
            const canvas: FakeCanvas = {
              id: this.id("cnv"),
              workspaceId: workspace.id,
              repoId: repo?.id ?? null,
              ownerId: person.id,
              sequencer: new Sequencer(doc),
              icon: null,
              settledAt: null,
              createdAt: this.now(),
              lastActivityAt: this.now(),
              done: new Map(),
              undone: new Map(),
              agent: { state: "idle", status: null, artboards: [] },
              model: body.model ?? null,
              effort: body.effort ?? null,
              blocker: null,
              previewSeq: null,
              assetKeyResets: 0,
              assetKeyRotatedAt: null,
              branch,
              github: null,
              assets: new Map(),
              pictures: new Map(),
              stops: [],
              thread: [],
              questions: [],
              presence: new Map(),
              reads: new Map(),
            };
            canvas.sequencer.now = this.clock.now();
            if (repo && branch) canvas.github = this.pullRequestsOf(canvas, repo.fullName, branch);
            this.canvases.set(canvas.id, canvas);
            if (key) this.createKeys.set(key, canvas.id);
            if (body.message) {
              const payload = { text: body.message.text, from: personOf(person) };
              this.append(canvas, { kind: "message", payload }, person.id);
              // As the API: the first message wakes the agent, on its owner's Claude; without
              // one connected, the canvas waits for it.
              if (this.claude.view(person.id)?.status === "connected") {
                canvas.agent = { state: "waking", status: null, artboards: [] };
                this.append(canvas, { kind: "notice", payload: { type: "waking" } });
              } else {
                canvas.blocker = "claude_not_connected";
              }
            }
            this.changed();
            return this.view(canvas, person.id);
          }),
        get: (id) => call(() => this.view(readable(id), person.id)),
        rename: (id, body) =>
          call(() => {
            const canvas = writable(id);
            const ops: Op[] = [];
            if (body.name !== undefined) ops.push({ op: "file.rename", name: body.name });
            if (body.icon !== undefined) ops.push({ op: "file.icon", icon: body.icon });
            if (ops.length) commit(canvas, [{ id: newOpId(), op: { op: "batch", ops } }]);
            if (body.icon !== undefined) canvas.icon = body.icon ?? null;
            return this.view(canvas, person.id);
          }),
        settle: (id, settled) =>
          call(() => {
            const canvas = writable(id);
            canvas.settledAt = settled ? this.now() : null;
            this.touch(canvas);
            return this.view(canvas, person.id);
          }),
        delete: (id) =>
          call(() => {
            const canvas = writable(id);
            const { role } = member(canvas.workspaceId);
            if (canvas.ownerId !== person.id && role !== "admin") {
              throw new ApiError(
                403,
                "forbidden",
                "Only its owner or a workspace admin can delete it.",
              );
            }
            this.canvases.delete(id);
            this.changed();
          }),
        // As the API's reset: the owner or an admin moves its files under a new address.
        rotateAssetKey: (id) =>
          call(() => {
            const canvas = writable(id);
            const { role } = member(canvas.workspaceId);
            if (canvas.ownerId !== person.id && role !== "admin") {
              throw new ApiError(
                403,
                "forbidden",
                "Only its owner or a workspace admin can reset its file links.",
              );
            }
            canvas.assetKeyResets += 1;
            canvas.assetKeyRotatedAt = this.now();
            this.changed();
            return this.view(canvas, person.id);
          }),
        // As the API's take-over: only a canvas whose owner is gone from its workspace, by
        // someone who can change it with their own Claude connected.
        takeOver: (id) =>
          call(() => {
            const canvas = writable(id);
            const members = this.workspaces.get(canvas.workspaceId)?.members;
            if (members?.has(canvas.ownerId)) {
              throw new ApiError(409, "not_ownerless", "Its owner is in the workspace.");
            }
            if (this.claude.view(person.id)?.status !== "connected") {
              throw new ApiError(409, "claude_not_connected", "Connect your Claude first.");
            }
            canvas.ownerId = person.id;
            if (canvas.blocker?.startsWith("claude_")) canvas.blocker = null;
            this.append(canvas, {
              kind: "notice",
              payload: { type: "owner_changed", by: personOf(person) },
            });
            this.touch(canvas);
            return this.view(canvas, person.id);
          }),
        doc: (id) => call(() => readable(id).sequencer.snapshot()),
        ops: (id, after) =>
          call(() => {
            const answer = readable(id).sequencer.opsAfter(after);
            if (answer === "gone") {
              throw new ApiError(410, "ops_pruned", "Those ops are no longer kept.");
            }
            return answer;
          }),
        commit: (id, ops) => call(() => commit(writable(id), ops)),
        undo: (id) => call(() => reverse(writable(id), "undo")),
        redo: (id) => call(() => reverse(writable(id), "redo")),
        people: (id) =>
          call(() => {
            const canvas = readable(id);
            const workspace = this.workspaces.get(canvas.workspaceId)!;
            const repo = workspace.repos.find((candidate) => candidate.id === canvas.repoId);
            const accessOf = (userId: string | null, permission: Permission) =>
              userId === canvas.ownerId
                ? ("owner" as const)
                : permission === "read"
                  ? ("view" as const)
                  : ("edit" as const);
            const joined = [...workspace.members.keys()]
              .filter((userId) =>
                repo ? repoPermission(repo, userId) !== "none" : userId === canvas.ownerId,
              )
              .map((userId) => ({
                ...joinedRow(workspace, userId),
                access: accessOf(userId, repo ? repoPermission(repo, userId) : "admin"),
              }));
            const others = repo
              ? workspace.githubOnly.flatMap((someone) => {
                  const can = someone.access.get(repo.id);
                  return can ? [{ ...githubOnlyRow(someone), access: accessOf(null, can) }] : [];
                })
              : [];
            return {
              people: [...joined.toSorted(byName), ...others.toSorted(byName)].toSorted(
                (a, b) => Number(b.access === "owner") - Number(a.access === "owner"),
              ),
            };
          }),
        presence: (id, pageId, focused) =>
          call(() => {
            const canvas = readable(id);
            const now = this.now();
            const was = canvas.presence.get(person.id);
            canvas.presence.set(person.id, {
              pageId: pageId === undefined ? (was?.pageId ?? null) : pageId,
              joinedAt: was?.joinedAt ?? now,
              seenAt: now,
              focusedAt: focused === undefined ? (was?.focusedAt ?? null) : focused ? now : null,
            });
            this.changed();
            return {
              present: [...canvas.presence].map(([userId, row]) => {
                const who = this.people.get(userId)!;
                return {
                  userId,
                  githubLogin: who.githubLogin,
                  name: who.name,
                  avatarUrl: who.avatarUrl,
                  pageId: row.pageId,
                  joinedAt: row.joinedAt,
                  seenAt: row.seenAt,
                };
              }),
            };
          }),
        leave: (id) =>
          call(() => {
            readable(id).presence.delete(person.id);
            this.changed();
          }),
        seen: (id, body = {}) =>
          call(() => {
            const canvas = readable(id);
            const was = canvas.reads.get(person.id);
            canvas.reads.set(person.id, {
              seq: Math.max(was?.seq ?? 0, body.seq ?? canvas.sequencer.seq),
              threadSeq: body.threadSeq ?? was?.threadSeq ?? null,
            });
            // Looking at it (focused within 75 seconds), what Ponzu told them about the canvas
            // is read too, as the API does. A window open in the background reads nothing.
            const here = canvas.presence.get(person.id);
            const looking =
              here?.focusedAt != null &&
              this.clock.now() - Date.parse(here.focusedAt) <= 75_000 &&
              this.clock.now() - Date.parse(here.seenAt) <= 75_000;
            if (looking) this.settings.read(person.id, { canvasId: canvas.id });
            this.changed();
          }),
        sendMessage: (id, body) =>
          call(() => {
            const canvas = writable(id);
            const text = body.text.trim();
            if (!text) throw new ApiError(400, "invalid_request", "Say something.");
            const refs = [...new Set(body.attachments ?? [])];
            const missing = refs.find((ref) => !canvas.assets.has(ref));
            if (missing) {
              throw new ApiError(
                400,
                "invalid_request",
                `${missing} is not one of this canvas's files.`,
              );
            }
            const attachments = refs.map((ref) => ({ ref, contentType: canvas.assets.get(ref)! }));
            const item = this.append(
              canvas,
              {
                kind: "message",
                payload: {
                  text,
                  from: personOf(person),
                  ...(attachments.length ? { attachments } : {}),
                },
              },
              person.id,
            );
            this.touch(canvas);
            return item;
          }),
        answer: (id, questionId, body) =>
          call(() => {
            const canvas = writable(id);
            const question = canvas.questions.find((q) => q.id === questionId);
            if (!question) throw new ApiError(404, "not_found", "There is no such question.");
            if (question.status !== "open") {
              // As the API: who answered it first is named, when someone did.
              const by = question.answer ? this.people.get(question.answer.userId) : undefined;
              throw new ApiError(
                409,
                "question_closed",
                "This question is no longer open.",
                by ? { answeredBy: personOf(by) } : undefined,
              );
            }
            checkAnswer(question.body, body);
            question.status = "answered";
            question.answer = { userId: person.id, body };
            // As the API: its needs-you rows resolve for everyone, and the one who answered
            // has read theirs.
            this.settings.resolve(canvas.id, question.id);
            const own = this.settings
              .inboxOf(person.id)
              .filter((row) => row.kind === "needs_you" && row.link.questionId === question.id);
            if (own.length) this.settings.read(person.id, { ids: own.map((row) => row.id) });
            // The runner takes the answer at once, and works again.
            if (!canvas.questions.some((q) => q.status === "open")) canvas.agent.state = "working";
            this.touch(canvas);
            return { id: question.id, status: question.status };
          }),
        answerSecret: (id, questionId, value) =>
          call(() => {
            const canvas = writable(id);
            const question = canvas.questions.find((q) => q.id === questionId);
            if (!question) throw new ApiError(404, "not_found", "There is no such question.");
            if (question.status !== "open" || question.body.kind !== "secret") {
              const by = question.answer ? this.people.get(question.answer.userId) : undefined;
              throw new ApiError(
                409,
                "question_closed",
                "This question is no longer open.",
                by ? { answeredBy: personOf(by) } : undefined,
              );
            }
            if (!canvas.repoId) {
              throw new ApiError(409, "no_repository", "A Scratch canvas has no repository.");
            }
            if (!value || value.includes("\u0000")) {
              throw new ApiError(400, "invalid_request", "A secret needs a value.");
            }
            // As the API: the value is kept apart, never on the question.
            this.secretsGiven.push({ canvasId: id, name: question.body.payload.name, value });
            question.status = "answered";
            question.answer = { userId: person.id, body: {} };
            if (!canvas.questions.some((q) => q.status === "open")) canvas.agent.state = "working";
            this.touch(canvas);
            return { id: question.id, status: question.status };
          }),
        question: (id, questionId) =>
          call(() => {
            const question = readable(id).questions.find((q) => q.id === questionId);
            if (!question) throw new ApiError(404, "not_found", "There is no such question.");
            const answered = question.status === "answered" ? question.answer : null;
            const by = answered ? this.people.get(answered.userId) : undefined;
            return {
              id: question.id,
              status: question.status,
              answer: answered
                ? {
                    ...(answered.body.answers ? { answers: answered.body.answers } : {}),
                    ...(answered.body.approved === undefined
                      ? {}
                      : { approved: answered.body.approved }),
                    ...(answered.body.note ? { note: answered.body.note } : {}),
                  }
                : null,
              answeredBy: by ? personOf(by) : null,
            };
          }),
        stop: (id) =>
          call(() => {
            const canvas = writable(id);
            canvas.stops.push(person.id);
            // The runner answers a stop at once: the turn ends, and it says who stopped it.
            for (const entry of canvas.thread) {
              if (entry.item.streaming) entry.item = { ...entry.item, streaming: false };
            }
            this.append(canvas, {
              kind: "notice",
              payload: { type: "stopped", by: personOf(person) },
            });
            canvas.agent = { state: "idle", status: null, artboards: [] };
            this.touch(canvas);
          }),
        thread: (id, page = {}) =>
          call(() => {
            const older = readable(id)
              .thread.map((entry) => entry.item)
              .filter((item) => page.before === undefined || item.seq < page.before)
              .toSorted((a, b) => a.seq - b.seq);
            return { items: older.slice(-Math.min(page.limit ?? 50, 50)) };
          }),
        upload: (id, file) =>
          call(() => {
            const canvas = writable(id);
            if (!file.type.startsWith("image/")) {
              throw new ApiError(400, "invalid_request", "A person uploads images only.");
            }
            // Each is kept under its own name with a few characters added, as the API does.
            const dot = file.name.lastIndexOf(".");
            const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
            const ext = dot > 0 ? file.name.slice(dot) : "";
            const ref = `assets/${stem}-${this.id("x").slice(-6)}${ext}`;
            canvas.assets.set(ref, file.type);
            return { id: this.id("up"), ref, url: `${assetsUrl(canvas)}${ref}` };
          }),
        uploadCommentPicture: (id, messageId, files) =>
          call(() => {
            const canvas = writable(id);
            return (["light", "dark"] as const).map((theme) => {
              const upload = this.id("up");
              const ref = `comments/${messageId}-${theme}-${upload.slice(-6)}.webp`;
              canvas.pictures.set(upload, { ref, bytes: files[theme], userId: person.id });
              return upload;
            });
          }),
        attachCommentPicture: (id, messageId, uploads) =>
          call(() => {
            const canvas = writable(id);
            const refs = uploads.map((upload) => canvas.pictures.get(upload));
            const of = (theme: string) =>
              refs.find((r) => r?.userId === person.id && r.ref.includes(`${messageId}-${theme}-`));
            const light = of("light");
            const dark = of("dark");
            if (!light || !dark) {
              throw new ApiError(400, "invalid_request", "A comment's picture is its two files.");
            }
            // As the API's statement does: the author's comment keeps the first it is given.
            const entry = canvas.thread.find(
              ({ item, userId }) =>
                item.kind === "comment" &&
                item.payload.messageId === messageId &&
                userId === person.id,
            );
            if (!entry || entry.item.kind !== "comment") {
              throw new ApiError(404, "not_found", "There is no such comment of yours.");
            }
            entry.item.payload.picture ??= {
              light: light.ref,
              dark: dark.ref,
              width: COMMENT_PICTURE.width,
              height: COMMENT_PICTURE.height,
            };
            entry.updatedAt = this.now();
            this.changed();
            return { picture: entry.item.payload.picture };
          }),
        pullRequest: {
          get: (id) => call(() => github(readable(id)).tab()),
          file: (id, path) => call(() => github(readable(id)).file(path)),
          open: (id) =>
            call(() => {
              const canvas = writable(id);
              return github(canvas).open(person.githubLogin, canvas.sequencer.doc.name).tab;
            }),
          ready: (id) => call(() => github(writable(id)).ready()),
          merge: (id, body) =>
            call(() => github(writable(id)).merge(person.githubLogin, body.headSha, !!body.bypass)),
          autoMerge: (id, on) => call(() => github(writable(id)).autoMerge(on)),
          close: (id, number) => call(() => github(writable(id)).close(number)),
          updateBranch: (id, body) => call(() => github(writable(id)).updateBranch(body.headSha)),
        },
      },
      live: (queries) =>
        call(() => {
          if (queries.length === 0 || queries.length > MAX_LIVE_QUERIES) {
            throw new ApiError(400, "invalid_request", `Ask for 1 to ${MAX_LIVE_QUERIES} queries.`);
          }
          return {
            url: this.realtime.url,
            results: queries.map(({ name, args = {} }) => {
              try {
                this.authorizeLive(person.id, name, args as Record<string, unknown>);
                return {
                  name,
                  sealed: fakeSeal(
                    { name, args: args as Record<string, unknown>, userId: person.id },
                    this.clock.now(),
                  ),
                };
              } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                return { name, error: { code: error.code, message: error.message } };
              }
            }),
          };
        }),
      ...this.settings.apiFor(person.id, this.settingsWorld(person, call, member)),
    };
  }

  /** What the settings routes ask of the rest of the fake, as `person`. */
  private settingsWorld(
    person: FakePerson,
    call: SettingsWorld["call"],
    member: (workspaceId: string) => { workspace: FakeWorkspace; role: Role },
  ): SettingsWorld {
    const readable = (workspace: FakeWorkspace) =>
      workspace.repos.filter((repo) => repoPermission(repo, person.id) !== "none");
    return {
      call,
      member,
      repo: (repoId) => {
        for (const workspace of this.workspaces.values()) {
          const repo = readable(workspace).find(({ id }) => id === repoId);
          if (repo && workspace.members.has(person.id)) {
            return {
              id: repo.id,
              fullName: repo.fullName,
              workspaceId: workspace.id,
              canPush: canWrite(repoPermission(repo, person.id)),
            };
          }
        }
        throw new ApiError(404, "not_found", "There is no such repo.");
      },
      repos: (workspaceId) => readable(member(workspaceId).workspace),
      hasCanvasIn: (repoId) => [...this.canvases.values()].some((d) => d.repoId === repoId),
      person: (userId) => this.people.get(userId)!,
      soleAdminOf: (userId) =>
        [...this.workspaces.values()]
          .filter(
            (workspace) =>
              workspace.kind === "org" &&
              workspace.members.get(userId) === "admin" &&
              workspace.members.size > 1 &&
              [...workspace.members].every(([id, role]) => id === userId || role !== "admin"),
          )
          .map(({ id, name }) => ({ id, name })),
      forget: (userId) => {
        for (const workspace of this.workspaces.values()) workspace.members.delete(userId);
        this.people.delete(userId);
      },
      email: (userId) => ({
        address: this.people.get(userId)?.email ?? null,
        available: this.features.email,
      }),
      changed: () => this.changed(),
      meChanged: () => this.changed(),
    };
  }

  /**
   * Tell a person something, as the API's notification pipeline would: a row in their inbox,
   * which `me.notifications` delivers. Answers the row.
   */
  notify(
    userId: string,
    row: Parameters<FakeSettings["notify"]>[1],
  ): ReturnType<FakeSettings["notify"]> {
    const notification = this.settings.notify(userId, row);
    this.changed();
    return notification;
  }

  /* ---------------------------------------------------------------- */
  /* Tables                                                            */
  /* ---------------------------------------------------------------- */

  private authorizeLive(userId: string, name: string, args: Record<string, unknown>): void {
    if (!LIVE_NAMES.includes(name as LiveQueryName)) {
      throw new ApiError(404, "not_found", "There is no live query by that name.");
    }
    if (name === "me" || name === "me.notifications") return;
    if (name === "workspace.canvases") {
      if (!this.workspaces.get(String(args.workspaceId))?.members.has(userId)) {
        throw new ApiError(404, "not_found", "There is no such workspace.");
      }
      return;
    }
    const canvas = this.canvases.get(String(args.canvasId));
    if (!canvas || this.permission(userId, canvas) === "none") {
      throw new ApiError(404, "not_found", "There is no such canvas.");
    }
  }

  /** What a live query's SQL would select now, row by row as Realtime sends it. */
  private rows({ name, args, userId }: FakeQuery): unknown[] {
    try {
      this.authorizeLive(userId, name, args);
    } catch {
      return [];
    }
    const canvas = this.canvases.get(String(args.canvasId));
    switch (name as LiveQueryName) {
      case "me": {
        const who = this.people.get(userId)!;
        const done = this.onboarding.get(userId);
        const claude = this.claude.view(userId);
        const defaults = this.claude.defaultsOf(userId);
        const row: RawRow<"me"> = {
          id: who.id,
          github_login: who.githubLogin,
          name: who.name,
          email: who.email,
          avatar_url: who.avatarUrl,
          default_agent: null,
          default_model: defaults.model,
          default_effort: defaults.effort,
          ping_needs_you: true,
          ping_replies: true,
          ping_pr_ready: true,
          ping_teammate_comments: true,
          email_digest: false,
          share_usage: this.settings.sharing.get(userId) ?? true,
          onboarding_where_at: done?.whereAt ?? null,
          onboarding_iphone_at: done?.iphoneAt ?? null,
          claude_account_id: claude ? `cla_${userId}` : null,
          claude_account_kind: claude?.kind ?? null,
          claude_account_status: claude?.status ?? null,
          claude_plan_label: null,
          claude_key_hint: null,
          claude_connected_at: claude?.connectedAt ?? null,
          claude_expires_at: claude?.expiresAt ?? null,
          claude_limited_until: null,
        };
        return [row];
      }
      case "me.notifications":
        return this.settings.inboxOf(userId).map((notification) => {
          const row: RawRow<"me.notifications"> = {
            id: notification.id,
            kind: notification.kind,
            workspace_id: notification.workspaceId,
            canvas_id: notification.canvasId,
            title: notification.title,
            subtitle: notification.subtitle,
            body: notification.body,
            link: notification.link,
            count: notification.count,
            muted: notification.muted,
            read_at: notification.readAt,
            resolved_at: notification.resolvedAt,
            created_at: notification.createdAt,
            updated_at: notification.updatedAt,
          };
          return row;
        });
      case "workspace.canvases":
        return this.visibleCanvases(String(args.workspaceId), userId).map((visible) => {
          const read = visible.reads.get(userId);
          const head = this.headOf(visible);
          const row: RawRow<"workspace.canvases"> = {
            id: visible.id,
            workspace_id: visible.workspaceId,
            repo_id: visible.repoId,
            repo_full_name: this.repoOf(visible)?.fullName ?? null,
            owner_id: visible.ownerId,
            name: head.name,
            icon: head.icon,
            branch: head.branch,
            status: head.status,
            settled_at: visible.settledAt,
            seq: String(head.seq),
            preview_seq: head.previewSeq === null ? null : String(head.previewSeq),
            agent_state: head.agentState,
            agent_status: head.agentStatus,
            agent_blocker: head.agentBlocker,
            needs_you_count: head.needsYouCount,
            pr_number: head.prNumber,
            pr_state: head.prState,
            pr_checks: head.prChecks,
            last_activity_at: visible.lastActivityAt,
            created_at: visible.createdAt,
            asset_key_rotated_at: visible.assetKeyRotatedAt,
            seen_seq: read ? String(read.seq) : null,
            seen_thread_seq: read?.threadSeq === null || !read ? null : String(read.threadSeq),
          };
          return row;
        });
      case "canvas.head": {
        const head = this.headOf(canvas!);
        const row: RawRow<"canvas.head"> = {
          id: head.id,
          workspace_id: head.workspaceId,
          name: head.name,
          icon: head.icon,
          status: head.status,
          seq: String(head.seq),
          preview_seq: head.previewSeq === null ? null : String(head.previewSeq),
          agent_state: head.agentState,
          agent_status: head.agentStatus,
          agent_artboards: head.agentArtboards,
          needs_you_count: head.needsYouCount,
          pr_number: head.prNumber,
          pr_state: head.prState,
          pr_checks: head.prChecks,
          pr_mergeable: head.prMergeable,
          pr_auto_merge: head.prAutoMerge,
          last_activity_at: head.lastActivityAt,
          asset_key_rotated_at: canvas!.assetKeyRotatedAt,
          agent_blocker: head.agentBlocker,
          agent_blocked_until: null,
          sandbox_state: null,
        };
        return [row];
      }
      case "canvas.thread":
        return canvas!.thread.map(({ item, userId: author, updatedAt }) => {
          const row: RawRow<"canvas.thread"> = {
            id: item.id,
            canvas_id: canvas!.id,
            seq: String(item.seq),
            kind: item.kind,
            user_id: author,
            payload: item.payload,
            streaming: item.streaming,
            created_at: item.at,
            updated_at: updatedAt,
          };
          return row;
        });
      case "canvas.questions":
        return canvas!.questions
          .filter((question) => question.status === "open")
          .map((question) => {
            const row: RawRow<"canvas.questions"> = {
              id: question.id,
              canvas_id: canvas!.id,
              seq: String(question.seq),
              kind: question.body.kind,
              payload: question.body.payload,
              status: question.status,
              created_at: question.createdAt,
            };
            return row;
          });
      case "canvas.presence":
        return [...canvas!.presence].map(([presentId, presence]) => {
          const who = this.people.get(presentId)!;
          const row: RawRow<"canvas.presence"> = {
            canvas_id: canvas!.id,
            user_id: presentId,
            page_id: presence.pageId,
            joined_at: presence.joinedAt,
            seen_at: presence.seenAt,
            github_login: who.githubLogin,
            name: who.name,
            avatar_url: who.avatarUrl,
          };
          return row;
        });
    }
  }

  private view(canvas: FakeCanvas, userId: string): CanvasView {
    const head = this.headOf(canvas);
    return {
      ...head,
      repo: canvas.repoId ? { id: canvas.repoId, fullName: this.repoOf(canvas)!.fullName } : null,
      ownerId: canvas.ownerId,
      settledAt: canvas.settledAt,
      createdAt: canvas.createdAt,
      access: canWrite(this.permission(userId, canvas)) ? "write" : "read",
      assetsUrl: assetsUrl(canvas),
      assetKeyRotatedAt: canvas.assetKeyRotatedAt,
    };
  }

  private headOf(canvas: FakeCanvas) {
    const doc = canvas.sequencer.doc;
    const pr = canvas.github?.row;
    return {
      id: canvas.id,
      workspaceId: canvas.workspaceId,
      name: doc.name,
      icon: canvas.icon,
      branch: canvas.branch,
      status: canvas.settledAt ? ("settled" as const) : ("active" as const),
      seq: canvas.sequencer.seq,
      previewSeq: canvas.previewSeq,
      agentState: canvas.agent.state,
      agentStatus: canvas.agent.status,
      agentArtboards: canvas.agent.artboards,
      agentBlocker: canvas.blocker,
      needsYouCount: canvas.questions.filter((question) => question.status === "open").length,
      prNumber: pr?.prNumber ?? null,
      prState: pr?.prState ?? null,
      prChecks: pr?.prChecks ?? ("none" as const),
      prMergeable: pr?.prMergeable ?? null,
      prAutoMerge: pr?.prAutoMerge ?? false,
      lastActivityAt: canvas.lastActivityAt,
    };
  }

  /** The canvas's branch and pull request, saying in its thread what GitHub does to it. */
  private pullRequestsOf(canvas: FakeCanvas, repo: string, branch: string): FakePullRequests {
    return new FakePullRequests(repo, branch, () => this.now(), {
      notice: (number, url, title, state) => {
        const verb = state === "draft" || state === "open" ? "opened" : state;
        const id = `ti_pr-${number}-${verb}`;
        if (canvas.thread.some((entry) => entry.item.id === id)) return;
        const payload = { type: "pull_request", number, url, title, state } as const;
        this.append(canvas, { kind: "notice", payload }, null, false, id);
      },
      // A merge settles the canvas, as a read that finds it merged does.
      merged: () => {
        canvas.settledAt = this.now();
      },
      changed: () => this.touch(canvas),
    });
  }

  private visibleCanvases(workspaceId: string, userId: string): FakeCanvas[] {
    return [...this.canvases.values()].filter(
      (canvas) => canvas.workspaceId === workspaceId && this.permission(userId, canvas) !== "none",
    );
  }

  /** What GitHub would say `userId` may do in the canvas's repo, or the owner's own Scratch. */
  private permission(userId: string, canvas: FakeCanvas): Permission {
    const workspace = this.workspaces.get(canvas.workspaceId);
    if (!workspace?.members.has(userId)) return "none";
    const repo = this.repoOf(canvas);
    if (!repo) return canvas.ownerId === userId ? "admin" : "none";
    return repoPermission(repo, userId);
  }

  private repoOf(canvas: FakeCanvas): FakeRepo | undefined {
    return this.workspaces.get(canvas.workspaceId)?.repos.find((repo) => repo.id === canvas.repoId);
  }

  private append(
    canvas: FakeCanvas,
    content: Pick<ThreadItem, "kind" | "payload">,
    userId: string | null = null,
    streaming = false,
    id = this.id("ti"),
  ): ThreadItem {
    const item = {
      id,
      seq: this.nextThreadSeq(canvas),
      at: this.now(),
      streaming,
      ...content,
    } as ThreadItem;
    canvas.thread.push({ item, userId, updatedAt: item.at });
    return item;
  }

  private nextThreadSeq(canvas: FakeCanvas): number {
    const seqs = [...canvas.thread.map((e) => e.item.seq), ...canvas.questions.map((q) => q.seq)];
    return Math.max(0, ...seqs) + 1;
  }

  private touch(canvas: FakeCanvas): void {
    canvas.lastActivityAt = this.now();
    this.changed();
  }

  /**
   * The person's Claude changed, as the API's `setClaudeBlocker` follows it: connected, their
   * active canvases that waited on it no longer do, and one with a message to take up wakes.
   */
  private claudeChanged(userId: string): void {
    if (this.claude.view(userId)?.status === "connected") {
      for (const canvas of this.canvases.values()) {
        const waited =
          canvas.blocker === "claude_not_connected" || canvas.blocker === "claude_expired";
        if (canvas.ownerId !== userId || canvas.settledAt !== null || !waited) continue;
        canvas.blocker = null;
        // What the person said while it waited is still to be taken up: the agent wakes for it.
        if (canvas.thread.at(-1)?.item.kind === "message") {
          canvas.agent = { state: "waking", status: null, artboards: [] };
          this.append(canvas, { kind: "notice", payload: { type: "waking" } });
        }
        this.touch(canvas);
      }
    }
    this.changed();
  }

  /** The tables changed: what each live query selects goes out, once the call has answered. */
  private changed(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      this.realtime.refresh();
    });
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}_${String(++this.ids).padStart(16, "0")}`;
  }
}

function repoPermission(repo: FakeRepo, userId: string): Permission {
  return repo.access.get(userId) ?? "write";
}

function canWrite(permission: Permission): boolean {
  return permission === "admin" || permission === "write";
}

function personOf(person: FakePerson) {
  return { id: person.id, name: person.name ?? person.githubLogin, login: person.githubLogin };
}

function listRow(head: ReturnType<FakeBackend["headOf"]>, canvas: FakeCanvas, userId: string) {
  const read = canvas.reads.get(userId);
  return {
    id: canvas.id,
    workspaceId: canvas.workspaceId,
    repoId: canvas.repoId,
    repoFullName: null,
    ownerId: canvas.ownerId,
    name: head.name,
    icon: head.icon,
    branch: head.branch,
    status: head.status,
    settledAt: canvas.settledAt,
    seq: head.seq,
    previewSeq: head.previewSeq,
    agentState: head.agentState,
    agentStatus: head.agentStatus,
    needsYouCount: head.needsYouCount,
    prNumber: head.prNumber,
    prState: head.prState,
    prChecks: head.prChecks,
    lastActivityAt: canvas.lastActivityAt,
    createdAt: canvas.createdAt,
    seenSeq: read?.seq ?? null,
    seenThreadSeq: read?.threadSeq ?? null,
  };
}

/** The new comments and replies an op makes, as apps/api/src/canvases/events.ts finds them. */
function commentsIn(op: Op, doc: Doc): Omit<CommentPayload, "from">[] {
  if (op.op === "batch") return op.ops.flatMap((inner) => commentsIn(inner, doc));
  const said =
    op.op === "thread.create"
      ? op.thread.messages[0] && { thread: op.thread, message: op.thread.messages[0] }
      : op.op === "thread.message"
        ? { thread: doc.threads.find((t) => t.id === op.id), message: op.message }
        : null;
  if (!said?.thread) return [];
  const thread = said.thread;
  const artboardId = thread.artboardId ?? null;
  const board = artboardId ? findArtboard(doc, artboardId)?.artboard : undefined;
  const page = doc.threads.some((t) => t.id === thread.id) ? threadPage(doc, thread) : null;
  return [
    {
      threadId: thread.id,
      messageId: said.message.id,
      text: said.message.text,
      artboardId,
      artboardName: board?.name ?? null,
      ...(page
        ? {
            pageId: page.id,
            pageName: page.name,
            at: { x: (board?.x ?? 0) + thread.x, y: (board?.y ?? 0) + thread.y },
          }
        : {}),
    },
  ];
}

type CommentPayload = Extract<ThreadItem, { kind: "comment" }>["payload"];

/** Where the canvas's files are served, as `GET /v1/canvases/:id` answers it. */
function assetsUrl(canvas: FakeCanvas): string {
  const reset = canvas.assetKeyResets > 0 ? `-${canvas.assetKeyResets}` : "";
  return `https://assets.test/${canvas.id}${reset}/`;
}

/** A branch's topic from the canvas's first words, as the API names `pz/<topic>`. */
function topic(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 3).join("-") || "canvas";
}

/**
 * An answer is checked against what was asked, since it closes the question for good: every one
 * of a `question`'s questions by its text and no other, or `approved` for a plan or permission.
 */
function checkAnswer(asked: QuestionBody, body: AnswerBody): void {
  if (asked.kind === "question") {
    const texts = asked.payload.questions.map((q) => q.question);
    const answers = body.answers ?? {};
    if (texts.some((text) => !Object.hasOwn(answers, text))) {
      throw new ApiError(400, "invalid_request", "Answer every question.");
    }
    if (Object.keys(answers).some((text) => !texts.includes(text))) {
      throw new ApiError(400, "invalid_request", "Answer only the questions that were asked.");
    }
  } else if (body.approved === undefined) {
    throw new ApiError(400, "invalid_request", "Say whether you approve.");
  }
}

/** A session that is signed in as `person` until `signOut`, and sends nothing anywhere. */
export function fakeSession(person: FakePerson): Session {
  let state: SessionState = { status: "signed_in", user: person };
  const listeners = new Set<() => void>();
  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    apiUrl: "https://api.test",
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: () => Promise.reject(new Error("The fake session sends nothing: use the fake api.")),
    async completeSignIn() {
      set({ status: "signed_in", user: person });
      return person;
    },
    async signOut() {
      set({ status: "signed_out" });
    },
  };
}
