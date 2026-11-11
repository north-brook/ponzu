import {
  type Actor,
  applyOp,
  type ClientOp,
  type CommittedOp,
  type Doc,
  emptyDoc,
  InvalidOpError,
  newId,
  newOpId,
  type Op,
} from "@ponzu/core";
import { Sequencer } from "@ponzu/core/testing";
import type { QuestionBody, RunErrorCode, ThreadItem } from "@ponzu/runner/protocol";
import type { AnswerBody, Api } from "../api.ts";
import { type Clock, systemClock } from "../clock.ts";
import { ApiError, networkError } from "../errors.ts";
import { createLive, type Live, MAX_LIVE_QUERIES } from "../live/live.ts";
import { LIVE_COLUMNS, type LiveQueryName, type RawRow } from "../live/rows.ts";
import type { Profile } from "../rpc.ts";
import type { Session, SessionState } from "../session.ts";
import { FakePullRequests } from "./pull-requests.ts";
import { type FakeQuery, FakeRealtime, fakeSeal } from "./realtime.ts";

/*
 * Ponzu Cloud in memory, behind the same interfaces as the real thing: a `Session` signed in
 * as someone, an `Api` over in-memory workspaces, designs and threads (ops ordered by core's
 * test sequencer, as the API orders them), and a `Live` whose feed is these tables. Screens
 * and stories built on it need no network; tests drive the agent and the network by hand.
 */

type Permission = "admin" | "write" | "read" | "none";
type Role = "admin" | "member";
type DesignView = Awaited<ReturnType<Api["designs"]["get"]>>;
type RepoIdeasAnswer = Awaited<ReturnType<Api["repos"]["ideas"]>>;
type AgentBlocker = NonNullable<DesignView["agentBlocker"]>;
type AgentState = DesignView["agentState"];

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
  repos: FakeRepo[];
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

/** One design and everything under it. */
export interface FakeDesign {
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
  /** The design's seq its previews show, once the runner has drawn them. */
  previewSeq: number | null;
  /** `pz/<topic>`, from the first message; null for Scratch and before it. */
  branch: string | null;
  /** Its branch and pull request on GitHub; null for Scratch. */
  github: FakePullRequests | null;
  /** The files people uploaded to it: `assets/<name>` to their type. */
  assets: Map<string, string>;
  /** Stops people asked for, oldest first. */
  stops: string[];
  thread: FakeThreadItem[];
  questions: FakeQuestion[];
  presence: Map<string, { pageId: string | null; joinedAt: string; seenAt: string }>;
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
   * A stretch of work in the thread: while `streaming`, the working line; saying again with the
   * same id replaces it, until it is finished.
   */
  tool(
    label: string,
    opts?: { id?: string; streaming?: boolean; steps?: number; artboards?: string[] },
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
  /** The runner drew the previews of the design as it is now. */
  preview(): void;
  /** Commits pushed to the design's branch on GitHub. */
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
  readonly designs = new Map<string, FakeDesign>();
  /**
   * What `GET /v1/repos/:id/ideas` answers for each repo, in turn: each ask takes the next
   * answer and the last one stays. A repo with none set has `none`.
   */
  readonly repoIdeas = new Map<string, RepoIdeasAnswer[]>();
  /** While false, every call fails as if there were no network. */
  online = true;
  private ids = 0;
  private refreshing = false;

  constructor(readonly clock: Clock) {
    this.realtime = new FakeRealtime((query) => this.rows(query), clock);
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
    return person;
  }

  /** A workspace with members and repos. Every member may push to a repo unless `access` says otherwise. */
  addWorkspace(input: {
    login: string;
    name?: string;
    kind?: "personal" | "org";
    members: Record<string, Role>;
    repos?: { name: string; access?: Record<string, Permission> }[];
  }): { id: string; repos: { id: string; fullName: string }[] } {
    const workspace: FakeWorkspace = {
      id: this.id("ws"),
      githubAccountId: 1000 + this.ids,
      githubLogin: input.login,
      name: input.name ?? input.login,
      kind: input.kind ?? "org",
      members: new Map(Object.entries(input.members)),
      repos: (input.repos ?? []).map((repo) => ({
        id: this.id("repo"),
        fullName: `${input.login}/${repo.name}`,
        access: new Map(Object.entries(repo.access ?? {})),
      })),
    };
    this.workspaces.set(workspace.id, workspace);
    return {
      id: workspace.id,
      repos: workspace.repos.map(({ id, fullName }) => ({ id, fullName })),
    };
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

  design(id: string): FakeDesign {
    const design = this.designs.get(id);
    if (!design) throw new Error(`No design ${id}.`);
    return design;
  }

  /** The design's runner, played by hand. */
  agent(designId: string): FakeAgent {
    const design = this.design(designId);
    return {
      commit: (ops) => {
        const result = design.sequencer.commit(
          ops.map((op) => ({ id: newOpId(), op })),
          AGENT,
        );
        this.touch(design);
        // A test that hands the agent an op that cannot apply has a bug: say so.
        if (result.rejected.length) throw new Error(`Rejected: ${result.rejected[0]!.reason}`);
        return result.committed;
      },
      say: (text, { id = this.id("ti"), streaming = false } = {}) => {
        const existing = design.thread.find((entry) => entry.item.id === id);
        if (existing?.item.streaming) {
          existing.item = { ...existing.item, payload: { text }, streaming } as ThreadItem;
          existing.updatedAt = this.now();
        } else if (!existing) {
          this.append(design, { kind: "assistant", payload: { text } }, null, streaming, id);
        }
        this.touch(design);
        return id;
      },
      tool: (label, { id = this.id("ti"), streaming = true, steps = 1, artboards = [] } = {}) => {
        const payload = { label, steps, artboards };
        const existing = design.thread.find((entry) => entry.item.id === id);
        if (existing?.item.streaming) {
          existing.item = { ...existing.item, payload, streaming } as ThreadItem;
          existing.updatedAt = this.now();
        } else if (!existing) {
          this.append(design, { kind: "tool", payload }, null, streaming, id);
        }
        this.touch(design);
        return id;
      },
      work: (artboards, status) => {
        design.agent = { state: "working", status: status ?? null, artboards };
        this.touch(design);
      },
      idle: () => {
        design.agent = { state: "idle", status: null, artboards: [] };
        this.touch(design);
      },
      wake: () => {
        design.agent = { state: "waking", status: null, artboards: [] };
        this.append(design, { kind: "notice", payload: { type: "waking" } });
        this.touch(design);
      },
      fail: (code, message = "") => {
        this.append(design, { kind: "notice", payload: { type: "error", code, message } });
        design.agent = { state: "idle", status: null, artboards: [] };
        this.touch(design);
      },
      withdraw: (questionId) => {
        const question = design.questions.find((q) => q.id === questionId);
        if (question?.status === "open") question.status = "cancelled";
        if (!design.questions.some((q) => q.status === "open")) design.agent.state = "idle";
        this.touch(design);
      },
      block: (blocker) => {
        design.blocker = blocker;
        this.touch(design);
      },
      preview: () => {
        design.previewSeq = design.sequencer.seq;
        this.touch(design);
      },
      push: (...files) => {
        if (!design.github) throw new Error("A Scratch design has no branch.");
        return design.github.push(...files);
      },
      ask: (body, header = "A question") => {
        const id = this.id("q");
        const seq = this.nextThreadSeq(design);
        design.questions.push({
          id,
          seq,
          body,
          status: "open",
          createdAt: this.now(),
          answer: null,
        });
        const text =
          body.kind === "question" ? (body.payload.questions[0]?.question ?? "") : header;
        this.append(design, {
          kind: "notice",
          payload: { type: "question", questionId: id, header, text },
        });
        design.agent = { ...design.agent, state: "needs_you" };
        this.touch(design);
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
      await Promise.resolve();
      if (!this.online) throw networkError(new Error("offline"));
      return run();
    };
    const readable = (id: string) => {
      const design = this.designs.get(id);
      if (!design || this.permission(person.id, design) === "none") {
        throw new ApiError(404, "not_found", "There is no such design.");
      }
      return design;
    };
    const writable = (id: string) => {
      const design = readable(id);
      if (!canWrite(this.permission(person.id, design))) {
        throw new ApiError(403, "forbidden", "You can only look at this design.");
      }
      return design;
    };
    const github = (design: FakeDesign) => {
      if (!design.github) {
        throw new ApiError(409, "no_repository", "A Scratch design has no repository.");
      }
      return design.github;
    };
    const member = (workspaceId: string) => {
      const workspace = this.workspaces.get(workspaceId);
      const role = workspace?.members.get(person.id);
      if (!workspace || !role) throw new ApiError(404, "not_found", "There is no such workspace.");
      return { workspace, role };
    };
    const commit = (design: FakeDesign, ops: ClientOp[]) => {
      let result: ReturnType<Sequencer["commit"]>;
      try {
        result = design.sequencer.commit(ops, actor);
      } catch (error) {
        if (error instanceof InvalidOpError) {
          throw new ApiError(400, "invalid_request", error.message);
        }
        throw error;
      }
      const done = design.done.get(person.id) ?? [];
      for (const op of result.committed) if (!done.includes(op.seq)) done.push(op.seq);
      design.done.set(person.id, done);
      if (result.committed.length) design.undone.set(person.id, []);
      // A new comment or reply reaches the thread with its commit, as the API's statement does.
      const doc = design.sequencer.doc;
      for (const { op } of result.committed) {
        for (const comment of commentsIn(op, doc)) {
          const payload = { ...comment, from: personOf(person) };
          this.append(design, { kind: "comment", payload }, person.id);
        }
      }
      this.touch(design);
      return result;
    };
    const reverse = (design: FakeDesign, kind: "undo" | "redo") => {
      const from = kind === "undo" ? design.done : design.undone;
      const to = kind === "undo" ? design.undone : design.done;
      const seq = from.get(person.id)?.pop();
      if (seq === undefined) {
        throw new ApiError(409, `nothing_to_${kind}`, `There is nothing to ${kind}.`);
      }
      const before = JSON.parse(design.sequencer.history[seq - 1]!) as Doc;
      const inverse = applyOp(before, design.sequencer.log[seq - 1]!.op);
      const { committed } = design.sequencer.commit([{ id: newOpId(), op: inverse }], actor);
      const reversal = committed[0];
      if (!reversal) throw new ApiError(409, `nothing_to_${kind}`, `There is nothing to ${kind}.`);
      to.set(person.id, [...(to.get(person.id) ?? []), reversal.seq]);
      this.touch(design);
      return { committed: reversal, seq: design.sequencer.seq };
    };
    const summary = (workspace: FakeWorkspace, role: Role) => ({
      id: workspace.id,
      githubAccountId: workspace.githubAccountId,
      githubLogin: workspace.githubLogin,
      name: workspace.name,
      kind: workspace.kind,
      avatarUrl: null,
      role,
      installed: true,
      suspended: false,
    });
    const mine = () =>
      [...this.workspaces.values()].flatMap((workspace) => {
        const role = workspace.members.get(person.id);
        return role ? [{ workspace, role }] : [];
      });
    const accounts = () => ({
      accounts: mine().map(({ workspace }) => ({
        githubAccountId: workspace.githubAccountId,
        login: workspace.githubLogin,
        name: workspace.name,
        avatarUrl: null,
        kind: workspace.kind,
        status: "ready" as const,
        workspaceId: workspace.id,
        suspended: false,
        memberCount: workspace.kind === "org" ? workspace.members.size : null,
      })),
    });
    const memberRow = (workspace: FakeWorkspace, userId: string) => {
      const who = this.people.get(userId)!;
      return {
        userId,
        githubLogin: who.githubLogin,
        name: who.name,
        avatarUrl: who.avatarUrl,
        role: workspace.members.get(userId)!,
        githubAccess: "member" as const,
      };
    };

    return {
      me: () =>
        call(() => ({
          user: person,
          onboarding: { whereConfirmedAt: null, iphoneStepSeenAt: null },
          claudeAccount: null,
          workspaces: mine().map(({ workspace, role }) => summary(workspace, role)),
        })),
      github: {
        accounts: () => call(accounts),
        sync: () => call(accounts),
        installLink: () =>
          call(() => ({
            url: "https://github.com/apps/ponzu-dev/installations/new?state=fake",
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
                installation: {
                  id: workspace.githubAccountId,
                  repositorySelection: "selected" as const,
                  installedAt: null,
                  installedBy: null,
                  suspendedAt: null,
                },
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
            };
          }),
        designs: (id) =>
          call(() => {
            member(id);
            return {
              designs: this.visibleDesigns(id, person.id).map((design) =>
                listRow(this.headOf(design), design, person.id),
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
      designs: {
        create: (body) =>
          call(() => {
            const { workspace } = member(body.workspaceId);
            const repo = body.repoId
              ? workspace.repos.find((candidate) => candidate.id === body.repoId)
              : null;
            if (body.repoId && !repo)
              throw new ApiError(404, "not_found", "There is no such repo.");
            if (repo && !canWrite(repoPermission(repo, person.id))) {
              throw new ApiError(403, "forbidden", "Designs need a repo you can push to.");
            }
            const name = body.name ?? "Untitled";
            const doc: Doc = {
              ...emptyDoc(name),
              pages: [{ id: newId("pg"), name: "Page 1", artboards: [] }],
            };
            const branch = repo ? `pz/${topic(name)}` : null;
            const design: FakeDesign = {
              id: this.id("dsn"),
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
              blocker: null,
              previewSeq: null,
              branch,
              github: null,
              assets: new Map(),
              stops: [],
              thread: [],
              questions: [],
              presence: new Map(),
              reads: new Map(),
            };
            design.sequencer.now = this.clock.now();
            if (repo && branch) design.github = this.pullRequestsOf(design, repo.fullName, branch);
            this.designs.set(design.id, design);
            this.changed();
            return this.view(design, person.id);
          }),
        get: (id) => call(() => this.view(readable(id), person.id)),
        rename: (id, body) =>
          call(() => {
            const design = writable(id);
            const ops: Op[] = [];
            if (body.name !== undefined) ops.push({ op: "file.rename", name: body.name });
            if (body.icon !== undefined) ops.push({ op: "file.icon", icon: body.icon });
            if (ops.length) commit(design, [{ id: newOpId(), op: { op: "batch", ops } }]);
            if (body.icon !== undefined) design.icon = body.icon ?? null;
            return this.view(design, person.id);
          }),
        settle: (id, settled) =>
          call(() => {
            const design = writable(id);
            design.settledAt = settled ? this.now() : null;
            this.touch(design);
            return this.view(design, person.id);
          }),
        delete: (id) =>
          call(() => {
            const design = writable(id);
            const { role } = member(design.workspaceId);
            if (design.ownerId !== person.id && role !== "admin") {
              throw new ApiError(
                403,
                "forbidden",
                "Only its owner or a workspace admin can delete it.",
              );
            }
            this.designs.delete(id);
            this.changed();
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
        presence: (id, pageId) =>
          call(() => {
            const design = readable(id);
            const now = this.now();
            const was = design.presence.get(person.id);
            design.presence.set(person.id, {
              pageId: pageId === undefined ? (was?.pageId ?? null) : pageId,
              joinedAt: was?.joinedAt ?? now,
              seenAt: now,
            });
            this.changed();
            return {
              present: [...design.presence].map(([userId, row]) => {
                const who = this.people.get(userId)!;
                return {
                  userId,
                  githubLogin: who.githubLogin,
                  name: who.name,
                  avatarUrl: who.avatarUrl,
                  ...row,
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
            const design = readable(id);
            const was = design.reads.get(person.id);
            design.reads.set(person.id, {
              seq: Math.max(was?.seq ?? 0, body.seq ?? design.sequencer.seq),
              threadSeq: body.threadSeq ?? was?.threadSeq ?? null,
            });
            this.changed();
          }),
        sendMessage: (id, body) =>
          call(() => {
            const design = writable(id);
            const text = body.text.trim();
            if (!text) throw new ApiError(400, "invalid_request", "Say something.");
            const refs = [...new Set(body.attachments ?? [])];
            const missing = refs.find((ref) => !design.assets.has(ref));
            if (missing) {
              throw new ApiError(
                400,
                "invalid_request",
                `${missing} is not one of this design's files.`,
              );
            }
            const attachments = refs.map((ref) => ({ ref, contentType: design.assets.get(ref)! }));
            const item = this.append(
              design,
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
            this.touch(design);
            return item;
          }),
        answer: (id, questionId, body) =>
          call(() => {
            const design = writable(id);
            const question = design.questions.find((q) => q.id === questionId);
            if (!question) throw new ApiError(404, "not_found", "There is no such question.");
            if (question.status !== "open") {
              throw new ApiError(409, "question_closed", "This question is no longer open.");
            }
            checkAnswer(question.body, body);
            question.status = "answered";
            question.answer = { userId: person.id, body };
            // The runner takes the answer at once, and works again.
            if (!design.questions.some((q) => q.status === "open")) design.agent.state = "working";
            this.touch(design);
            return { id: question.id, status: question.status };
          }),
        stop: (id) =>
          call(() => {
            const design = writable(id);
            design.stops.push(person.id);
            // The runner answers a stop at once: the turn ends, and it says who stopped it.
            for (const entry of design.thread) {
              if (entry.item.streaming) entry.item = { ...entry.item, streaming: false };
            }
            this.append(design, {
              kind: "notice",
              payload: { type: "stopped", by: personOf(person) },
            });
            design.agent = { state: "idle", status: null, artboards: [] };
            this.touch(design);
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
            const design = writable(id);
            if (!file.type.startsWith("image/")) {
              throw new ApiError(400, "invalid_request", "A person uploads images only.");
            }
            // Each is kept under its own name with a few characters added, as the API does.
            const dot = file.name.lastIndexOf(".");
            const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
            const ext = dot > 0 ? file.name.slice(dot) : "";
            const ref = `assets/${stem}-${this.id("x").slice(-6)}${ext}`;
            design.assets.set(ref, file.type);
            return { id: this.id("up"), ref, url: `${assetsUrl(design)}${ref}` };
          }),
        pullRequest: {
          get: (id) => call(() => github(readable(id)).tab()),
          file: (id, path) => call(() => github(readable(id)).file(path)),
          open: (id) =>
            call(() => {
              const design = writable(id);
              return github(design).open(person.githubLogin, design.sequencer.doc.name).tab;
            }),
          ready: (id) => call(() => github(writable(id)).ready()),
          merge: (id, body) =>
            call(() => github(writable(id)).merge(person.githubLogin, body.headSha, !!body.bypass)),
          autoMerge: (id, on) => call(() => github(writable(id)).autoMerge(on)),
          close: (id) => call(() => github(writable(id)).close()),
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
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tables                                                            */
  /* ---------------------------------------------------------------- */

  private authorizeLive(userId: string, name: string, args: Record<string, unknown>): void {
    if (!LIVE_NAMES.includes(name as LiveQueryName)) {
      throw new ApiError(404, "not_found", "There is no live query by that name.");
    }
    if (name === "me") return;
    if (name === "workspace.designs") {
      if (!this.workspaces.get(String(args.workspaceId))?.members.has(userId)) {
        throw new ApiError(404, "not_found", "There is no such workspace.");
      }
      return;
    }
    const design = this.designs.get(String(args.designId));
    if (!design || this.permission(userId, design) === "none") {
      throw new ApiError(404, "not_found", "There is no such design.");
    }
  }

  /** What a live query's SQL would select now, row by row as Realtime sends it. */
  private rows({ name, args, userId }: FakeQuery): unknown[] {
    try {
      this.authorizeLive(userId, name, args);
    } catch {
      return [];
    }
    const design = this.designs.get(String(args.designId));
    switch (name as LiveQueryName) {
      case "me": {
        const who = this.people.get(userId)!;
        const row: RawRow<"me"> = {
          id: who.id,
          github_login: who.githubLogin,
          name: who.name,
          email: who.email,
          avatar_url: who.avatarUrl,
          default_agent: null,
          default_model: null,
          default_effort: null,
          ping_needs_you: true,
          ping_replies: true,
          ping_pr_ready: true,
          ping_teammate_comments: true,
          email_digest: false,
          onboarding_where_at: null,
          onboarding_iphone_at: null,
          claude_account_id: null,
          claude_account_kind: null,
          claude_account_status: null,
          claude_plan_label: null,
          claude_key_hint: null,
          claude_connected_at: null,
          claude_expires_at: null,
          claude_limited_until: null,
        };
        return [row];
      }
      case "workspace.designs":
        return this.visibleDesigns(String(args.workspaceId), userId).map((visible) => {
          const read = visible.reads.get(userId);
          const head = this.headOf(visible);
          const row: RawRow<"workspace.designs"> = {
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
            seen_seq: read ? String(read.seq) : null,
            seen_thread_seq: read?.threadSeq === null || !read ? null : String(read.threadSeq),
          };
          return row;
        });
      case "design.head": {
        const head = this.headOf(design!);
        const row: RawRow<"design.head"> = {
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
          agent_blocker: head.agentBlocker,
          sandbox_state: null,
        };
        return [row];
      }
      case "design.thread":
        return design!.thread.map(({ item, userId: author, updatedAt }) => {
          const row: RawRow<"design.thread"> = {
            id: item.id,
            design_id: design!.id,
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
      case "design.questions":
        return design!.questions
          .filter((question) => question.status === "open")
          .map((question) => {
            const row: RawRow<"design.questions"> = {
              id: question.id,
              design_id: design!.id,
              seq: String(question.seq),
              kind: question.body.kind,
              payload: question.body.payload,
              status: question.status,
              created_at: question.createdAt,
            };
            return row;
          });
      case "design.presence":
        return [...design!.presence].map(([presentId, presence]) => {
          const who = this.people.get(presentId)!;
          const row: RawRow<"design.presence"> = {
            design_id: design!.id,
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

  private view(design: FakeDesign, userId: string): DesignView {
    const head = this.headOf(design);
    return {
      ...head,
      repo: design.repoId ? { id: design.repoId, fullName: this.repoOf(design)!.fullName } : null,
      ownerId: design.ownerId,
      settledAt: design.settledAt,
      createdAt: design.createdAt,
      access: canWrite(this.permission(userId, design)) ? "write" : "read",
      assetsUrl: assetsUrl(design),
    };
  }

  private headOf(design: FakeDesign) {
    const doc = design.sequencer.doc;
    const pr = design.github?.row;
    return {
      id: design.id,
      workspaceId: design.workspaceId,
      name: doc.name,
      icon: design.icon,
      branch: design.branch,
      status: design.settledAt ? ("settled" as const) : ("active" as const),
      seq: design.sequencer.seq,
      previewSeq: design.previewSeq,
      agentState: design.agent.state,
      agentStatus: design.agent.status,
      agentArtboards: design.agent.artboards,
      agentBlocker: design.blocker,
      needsYouCount: design.questions.filter((question) => question.status === "open").length,
      prNumber: pr?.prNumber ?? null,
      prState: pr?.prState ?? null,
      prChecks: pr?.prChecks ?? ("none" as const),
      prMergeable: pr?.prMergeable ?? null,
      prAutoMerge: pr?.prAutoMerge ?? false,
      lastActivityAt: design.lastActivityAt,
    };
  }

  /** The design's branch and pull request, saying in its thread what GitHub does to it. */
  private pullRequestsOf(design: FakeDesign, repo: string, branch: string): FakePullRequests {
    return new FakePullRequests(repo, branch, () => this.now(), {
      notice: (number, url, title, state) => {
        const verb = state === "draft" || state === "open" ? "opened" : state;
        const id = `ti_pr-${number}-${verb}`;
        if (design.thread.some((entry) => entry.item.id === id)) return;
        const payload = { type: "pull_request", number, url, title, state } as const;
        this.append(design, { kind: "notice", payload }, null, false, id);
      },
      // A merge settles the design, as a read that finds it merged does.
      merged: () => {
        design.settledAt = this.now();
      },
      changed: () => this.touch(design),
    });
  }

  private visibleDesigns(workspaceId: string, userId: string): FakeDesign[] {
    return [...this.designs.values()].filter(
      (design) => design.workspaceId === workspaceId && this.permission(userId, design) !== "none",
    );
  }

  /** What GitHub would say `userId` may do in the design's repo, or the owner's own Scratch. */
  private permission(userId: string, design: FakeDesign): Permission {
    const workspace = this.workspaces.get(design.workspaceId);
    if (!workspace?.members.has(userId)) return "none";
    const repo = this.repoOf(design);
    if (!repo) return design.ownerId === userId ? "admin" : "none";
    return repoPermission(repo, userId);
  }

  private repoOf(design: FakeDesign): FakeRepo | undefined {
    return this.workspaces.get(design.workspaceId)?.repos.find((repo) => repo.id === design.repoId);
  }

  private append(
    design: FakeDesign,
    content: Pick<ThreadItem, "kind" | "payload">,
    userId: string | null = null,
    streaming = false,
    id = this.id("ti"),
  ): ThreadItem {
    const item = {
      id,
      seq: this.nextThreadSeq(design),
      at: this.now(),
      streaming,
      ...content,
    } as ThreadItem;
    design.thread.push({ item, userId, updatedAt: item.at });
    return item;
  }

  private nextThreadSeq(design: FakeDesign): number {
    const seqs = [...design.thread.map((e) => e.item.seq), ...design.questions.map((q) => q.seq)];
    return Math.max(0, ...seqs) + 1;
  }

  private touch(design: FakeDesign): void {
    design.lastActivityAt = this.now();
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

function listRow(head: ReturnType<FakeBackend["headOf"]>, design: FakeDesign, userId: string) {
  const read = design.reads.get(userId);
  return {
    id: design.id,
    workspaceId: design.workspaceId,
    repoId: design.repoId,
    repoFullName: null,
    ownerId: design.ownerId,
    name: head.name,
    icon: head.icon,
    branch: head.branch,
    status: head.status,
    settledAt: design.settledAt,
    seq: head.seq,
    previewSeq: head.previewSeq,
    agentState: head.agentState,
    agentStatus: head.agentStatus,
    needsYouCount: head.needsYouCount,
    prNumber: head.prNumber,
    prState: head.prState,
    prChecks: head.prChecks,
    lastActivityAt: design.lastActivityAt,
    createdAt: design.createdAt,
    seenSeq: read?.seq ?? null,
    seenThreadSeq: read?.threadSeq ?? null,
  };
}

/** The new comments and replies an op makes, as apps/api/src/designs/events.ts finds them. */
function commentsIn(op: Op, doc: Doc): Omit<CommentPayload, "from">[] {
  if (op.op === "batch") return op.ops.flatMap((inner) => commentsIn(inner, doc));
  const said =
    op.op === "thread.create"
      ? op.thread.messages[0] && { thread: op.thread, message: op.thread.messages[0] }
      : op.op === "thread.message"
        ? { thread: doc.threads.find((t) => t.id === op.id), message: op.message }
        : null;
  if (!said?.thread) return [];
  const artboardId = said.thread.artboardId ?? null;
  const board = doc.pages.flatMap((page) => page.artboards).find((ab) => ab.id === artboardId);
  return [
    {
      threadId: said.thread.id,
      messageId: said.message.id,
      text: said.message.text,
      artboardId,
      artboardName: board?.name ?? null,
    },
  ];
}

type CommentPayload = Extract<ThreadItem, { kind: "comment" }>["payload"];

/** Where the design's files are served, as `GET /v1/designs/:id` answers it. */
function assetsUrl(design: FakeDesign): string {
  return `https://assets.test/${design.id}/`;
}

/** A branch's topic from the design's first words, as the API names `pz/<topic>`. */
function topic(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 3).join("-") || "design";
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
