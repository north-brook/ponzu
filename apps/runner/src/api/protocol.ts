/*
 * The wire protocol between a canvas's runner and the API (docs/cloud.md, "The runner
 * protocol"): every body that crosses it, as JSON. The apps import the thread's types from here
 * (`@ponzu/runner/protocol`) to render what the runner writes; this file imports nothing, so
 * it adds nothing to a client's bundle.
 */

export type Theme = "light" | "dark";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A person, as the runner and the thread name them. */
export interface Person {
  id: string;
  name: string;
  /** Their GitHub login. */
  login: string | null;
}

/* ------------------------------------------------------------------ */
/* Starting                                                            */
/* ------------------------------------------------------------------ */

/**
 * The runner's one port, which the sandbox makes public at `https://<sub>.vercel.run`. Every
 * route answers 401 without `authorization: Bearer <PONZU_PORT_TOKEN>`: `POST /poke` (204) and
 * `GET /health` (200 `{ started }`).
 */
export const RUNNER_PORT = 4600;

/**
 * The image's own commands for the runner, root-owned, which the API runs as root
 * (`runCommand({ sudo: true })`).
 */
export const IMAGE_COMMANDS = {
  /**
   * Detached, at every start of the sandbox: fetch the runner bundle `PONZU_RUNNER_BUNDLE` names
   * if it is missing, then the supervisor behind its lock, its output in /var/log/ponzu/runner.log.
   */
  start: "/opt/ponzu/bin/ponzu-start",
  /** Waited (30 s): SIGTERM the supervisor, wait up to 25 s for its lock, sync. Idempotent. */
  stop: "/opt/ponzu/bin/ponzu-stop",
} as const;

/**
 * The environment of `IMAGE_COMMANDS.start`, the one place the runner's secrets go: never the
 * sandbox's own environment, never a file. Exactly one Claude credential.
 */
export type StartEnv = {
  PONZU_API_URL: string;
  PONZU_CANVAS_ID: string;
  /** `pzr_…`, 25 h, new at every start. */
  PONZU_RUNNER_TOKEN: string;
  /** 32 random bytes, base64url: the bearer of the runner's port. */
  PONZU_PORT_TOKEN: string;
  /** The sha256 (hex) of the runner bundle this API serves (`@ponzu/runner/bundle`). */
  PONZU_RUNNER_BUNDLE: string;
  /** The repo's secrets (`REPO_SECRETS_VARIABLE`), at most 64 KB: our own cap. */
  PONZU_REPO_SECRETS?: string;
} & (
  | { ANTHROPIC_API_KEY: string; CLAUDE_CODE_OAUTH_TOKEN?: never }
  | { CLAUDE_CODE_OAUTH_TOKEN: string; ANTHROPIC_API_KEY?: never }
);

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * The header every call after the session carries: which runner process is making it. The
 * API answers 409 `superseded` to any process but the one it started last.
 */
export const RUNNER_HEADER = "x-ponzu-runner";

/** `POST /v1/runner/session`: everything the runner needs to start, and its lease. */
export interface RunnerSession {
  /**
   * This process, `rnr_` and 16 characters: minted by this call, which makes it the canvas's
   * one runner. Sent as `X-Ponzu-Runner` on every later call.
   */
  runnerId: string;
  canvas: { id: string; name: string };
  /** Null for Scratch. */
  repo: { owner: string; name: string; defaultBranch: string } | null;
  /** The branch to work on, `pz/<topic>`. Null for Scratch. */
  branch: string | null;
  /** The Claude session to resume, as the runner last reported it. Null for a new one. */
  claudeSessionId: string | null;
  /** Null for Claude Code's default. */
  model: string | null;
  effort: Effort | null;
  /** Who commits are authored by: the person, at their GitHub noreply address. */
  author: { name: string; email: string };
  /** Who commits are committed by: the Ponzu GitHub App's bot. */
  committer: { name: string; email: string };
  /** What `assets/<name>` resolves against, `https://assets.ponzu.cloud/<asset key>`. */
  assetBase: string;
  /** Opens the canvas in Ponzu. */
  link: string;
  /** The theme of the canvas of the person the agent works for, once known. */
  theme: Theme | null;
  /**
   * Questions an earlier run left open, which people can still answer: the answer comes in as
   * a message. They stay open until the next turn ends.
   */
  openQuestions: string[];
  /** The canvas's head: its latest committed op. */
  seq: number;
  /**
   * The canvas's last checkpoint, as the API recorded it: a runner whose disk is behind it
   * (a rollback) or holds none of it (a new sandbox) restores from it before it resumes.
   */
  saved: SavedPoint | null;
  /** The workspace the canvas is in: the group its turns are reported under. */
  workspaceId?: string;
  /**
   * Where the runner reports each turn's trace to PostHog's LLM analytics, or null (or absent,
   * from an older API) when analytics is off (docs/analytics.md).
   */
  analytics?: RunnerAnalytics | null;
  /**
   * What the API holds of the models Claude Code offers the Claude account the canvas runs on,
   * as a runner on its credential last reported them: the runner reports again only when what
   * its Claude Code says differs, or this is stale. Null when nothing is held; absent from an
   * older API.
   */
  models?: ModelsHeld | null;
}

/** One model Claude Code offers, as `supportedModels()` said it (docs/cloud.md, "Models"). */
export interface ReportedModel {
  /** What Claude Code takes as a model: an alias (`opus`, `default`) or a full id. */
  value: string;
  /** The full id `value` runs as now, when Claude Code says. */
  resolvedModel: string | null;
  displayName: string;
  description: string;
  /** The effort levels it takes; empty when it takes none, null when Claude Code did not say. */
  efforts: Effort[] | null;
}

/**
 * `POST /v1/runner/models`: what Claude Code offers the account this runner runs as, and which
 * Claude Code said so. Answered 200 with whether the API kept it (`ModelsResponse`). Safe to
 * repeat: the last one kept wins. A runner's first report is kept, then at most one in ten
 * minutes; one sent sooner is answered `kept: false`, never 429.
 */
export interface ModelsReport {
  claudeCode: string;
  models: ReportedModel[];
}

export interface ModelsResponse {
  /**
   * False when the account the canvas runs on is no longer the credential this runner holds, or
   * the report came within ten minutes of the account's last one kept since this runner started.
   */
  kept: boolean;
}

/** What the API holds of a report. */
export interface ModelsHeld extends ModelsReport {
  /** When it was reported. ISO 8601. */
  at: string;
}

/** PostHog, as the API hands it to a runner. Every value is public. */
export interface RunnerAnalytics {
  /** The project token, `phc_…`. */
  key: string;
  host: string;
  /** Whether prompts, replies and tool arguments and results go with the trace. */
  content: boolean;
}

/* ------------------------------------------------------------------ */
/* Saving the sandbox                                                  */
/* ------------------------------------------------------------------ */

/**
 * What a checkpoint saved, as the API recorded it. A runner saves one after each turn has
 * settled and before the sandbox sleeps: the session's transcript, and the checkout's work in
 * progress, so that nothing lives only on the sandbox's disk.
 */
export interface SavedPoint {
  /** Goes up by one each checkpoint, across runners and sandboxes: the API keeps the highest. */
  turn: number;
  /** When the API recorded it, as an ISO 8601 time. */
  at: string;
  /** The Claude session whose transcript is stored, if one is. */
  claudeSessionId: string | null;
  /**
   * A repo canvas's work in progress: a commit on `refs/ponzu/wip/<canvas id>` whose parent is
   * the checkout's HEAD and whose tree is its working tree, untracked files included.
   */
  wipCommit: string | null;
  /** Whether the transcript, and a Scratch canvas's files, are stored with it. */
  session: boolean;
  workspace: boolean;
}

/** The hidden ref a repo canvas's work in progress is pushed to. Never a branch. */
export const wipRef = (canvasId: string) => `refs/ponzu/wip/${canvasId}`;

/** The names and type of the two archives a checkpoint uploads. */
export const SESSION_ARCHIVE = "session.tar.gz";
export const WORKSPACE_ARCHIVE = "workspace.tar.gz";
export const ARCHIVE_TYPE = "application/gzip";
/** The largest each may be, compressed. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;

/**
 * `POST /v1/runner/checkpoint`: record a checkpoint whose archives were uploaded (purposes
 * `session` and `workspace`). Recorded only if `turn` is above the one the API has, so a late
 * or repeated call never puts an older one back.
 */
export interface CheckpointRequest {
  turn: number;
  claudeSessionId: string | null;
  wipCommit: string | null;
  /** The upload ids of the archives, as `/v1/runner/uploads` answered them. */
  session: string | null;
  workspace: string | null;
  /**
   * Keep the archive the last checkpoint stored in place of one this checkpoint does not carry:
   * the transcript (with its session id) when it could not be packed or is not on this disk, the
   * work in progress (with its commit) when nothing changed or it could not be saved. A
   * checkpoint never carries less than the one before it. Absent: keep nothing.
   */
  keep?: { session?: boolean; workspace?: boolean };
}

export interface CheckpointResponse {
  /** The checkpoint the API has now: this one, or a newer one it kept. */
  saved: SavedPoint;
}

/** Where to read one stored archive back, for a few minutes. */
export interface SavedArchive {
  url: string;
  size: number;
  /** Hex. */
  sha256: string;
}

/** `POST /v1/runner/restore`: the canvas's last checkpoint and where to read its archives. */
export interface RestoreResponse {
  saved: SavedPoint | null;
  session: SavedArchive | null;
  workspace: SavedArchive | null;
}

/**
 * `POST /v1/runner/restored`: the runner found its disk behind the canvas's last checkpoint and
 * restored from it. The API logs it with the sandbox it happened in, and counts a rollback.
 */
export interface RestoredReport {
  /** `rollback`: the disk had an older checkpoint. `rebuilt`: it had none (a new sandbox). */
  kind: "rollback" | "rebuilt";
  /** The checkpoint the disk had, if any. */
  disk: { turn: number; at: string; bootId: string | null } | null;
  saved: { turn: number; at: string };
  /** This boot of the machine (`/proc/sys/kernel/random/boot_id`), and when it began. */
  bootId: string | null;
  bootAt: string | null;
  restored: { session: boolean; workspace: boolean };
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type Priority = "now" | "next" | "later";

/** Something that happened to the canvas, for the agent to take up. */
export type RunnerEvent = {
  id: string;
  /** Its place in the canvas's feed. Increasing, with gaps. */
  seq: number;
  /** When it happened, as an ISO 8601 time. */
  at: string;
  priority: Priority;
  /** The person behind it. Null when GitHub was. */
  from: Person | null;
  /**
   * The PostHog session of the app that sent it, when it said: the turn it begins is traced
   * under it, so a session recording links to the agent's work (docs/analytics.md).
   */
  posthogSessionId?: string | null;
} & EventBody;

export type EventBody =
  | { kind: "message"; payload: MessageEvent }
  | { kind: "answer"; payload: AnswerEvent }
  | { kind: "comment"; payload: CommentEvent }
  | { kind: "edit"; payload: EditEvent }
  | { kind: "check"; payload: CheckEvent }
  | { kind: "review"; payload: ReviewEvent }
  | { kind: "stop"; payload: Record<string, never> }
  /**
   * A person pressed Create PR while the branch had commits only this sandbox holds: the runner
   * pushes them now, without the agent. Nothing goes into the session.
   */
  | { kind: "push"; payload: Record<string, never> };

export type EventKind = EventBody["kind"];

export interface MessageEvent {
  text: string;
}

/** A person answered a question the runner raised. */
export interface AnswerEvent {
  questionId: string;
  /** What the runner asked, as it raised it: the agent may no longer have the question in mind. */
  question: QuestionBody;
  /**
   * For a `question`: each question's text, to the label chosen (labels joined with ", " for
   * several), the person's own words, or both. A client folds a note into the answer it goes with.
   */
  answers?: Record<string, string>;
  /** For a `plan` or a `permission`: whether the person said yes. */
  approved?: boolean;
  /** For a `plan` or a `permission`: what the person wrote beside their answer. */
  note?: string;
}

/** A comment on the canvas: a new thread, or a reply in one. */
export interface CommentEvent {
  threadId: string;
  messageId: string;
  text: string;
  /** False for the first message of a thread. */
  reply: boolean;
  /** The artboard the pin is on, with its name when the comment was made. Null for a pin off any board. */
  artboardId: string | null;
  artboardName: string | null;
  /** The node the pin points at, if any. */
  nodeId: string | null;
}

/** A person changed the canvas: moved, renamed or deleted artboards, managed pages. */
export interface EditEvent {
  /** What they did, in a few words: `summarize` from @ponzu/core, as the canvas says it. */
  summary: string;
  artboards: { id: string; name: string }[];
}

/** A check on the pull request failed. */
export interface CheckEvent {
  name: string;
  conclusion: "failure" | "timed_out" | "cancelled" | "action_required";
  url: string | null;
  /** The check's own summary, or the end of its log, clipped. */
  summary: string | null;
}

/** Someone reviewed the pull request. */
export interface ReviewEvent {
  state: "approved" | "changes_requested" | "commented";
  /** The reviewer on GitHub, who need not be a Ponzu user (then `from` is null). */
  reviewer: { login: string };
  body: string;
  url: string | null;
  /** The line comments that came with it: the first `MAX_REVIEW_COMMENTS`, each body clipped. */
  comments: ReviewComment[];
}

export interface ReviewComment {
  path: string;
  /** The line in the new file, or null for a comment on the whole file. */
  line: number | null;
  body: string;
}

/** The most line comments a review event carries, and the longest each body is. */
export const MAX_REVIEW_COMMENTS = 20;
export const MAX_REVIEW_COMMENT = 2_000;

/** `POST /v1/runner/events/claim`. */
export interface ClaimRequest {
  /**
   * The runner's id for this claim (`clm_…`): new for each claim, the same when it is sent
   * again. Sent again, it hands out what it handed out the first time, and nothing new.
   */
  claimId: string;
  /** At most this many, oldest first. `CLAIM_LIMIT` when absent, and never more. */
  limit?: number;
}

export const CLAIM_LIMIT = 100;

export interface ClaimResponse {
  events: RunnerEvent[];
  /** The canvas's head, so the runner's replica can catch up. */
  seq: number;
  /**
   * The canvas's pull request as the app shows it (the canvas's row): what the agent is told
   * when a turn starts. Null when it has none; absent from an API that does not say.
   */
  pullRequest?: PullRequestState | null;
}

/** A canvas's pull request, as the app shows it. */
export interface PullRequestState {
  number: number;
  state: "draft" | "open" | "merged" | "closed";
}

/** `POST /v1/runner/events/ack`: these are in the Claude session and never to be handed out again. */
export interface AckRequest {
  ids: string[];
  /**
   * The Claude session that holds them, stored as the canvas's session in the same
   * transaction, so the next runner resumes the session its events went into. Null only when
   * none of them went into a session (a stop, a kind this runner does not know).
   */
  claudeSessionId: string | null;
}

export interface AckResponse {
  acked: number;
}

/* ------------------------------------------------------------------ */
/* The thread                                                          */
/* ------------------------------------------------------------------ */

/**
 * One item of a canvas's thread, as clients read it. People's messages and comments are the
 * API's to write; the runner writes the rest. A client renders the thread from these alone.
 */
export type ThreadItem = {
  id: string;
  /** Orders the thread. Increasing, with gaps. */
  seq: number;
  /** When it was first written, as an ISO 8601 time. */
  at: string;
  /** Still being written; its payload will change. */
  streaming: boolean;
} & ThreadContent;

export type ThreadContent =
  /** Written by the API when a person sends a message. */
  | { kind: "message"; payload: { text: string; from: Person } }
  /**
   * Written by the API when a comment reaches the agent: shown with a picture of where it was
   * left, once its author's app has attached one.
   */
  | { kind: "comment"; payload: CommentItem }
  /** What the agent says. Streams as it is written. */
  | { kind: "assistant"; payload: AssistantItem }
  /**
   * The agent's work. A runner that writes `turn` writes one per turn, streaming while the turn
   * runs; an older one wrote one per stretch of work between two things the agent said.
   */
  | { kind: "tool"; payload: WorkItem }
  | { kind: "notice"; payload: Notice };

export type ThreadKind = ThreadContent["kind"];

/** A person's comment or reply on the canvas, as the thread shows it. */
export interface CommentItem {
  threadId: string;
  messageId: string;
  text: string;
  artboardId: string | null;
  artboardName: string | null;
  /**
   * The page it was left on, and that page's name then: where it was, even once the thread is
   * gone. Left out of comments from before they were kept.
   */
  pageId?: string;
  pageName?: string;
  /** Where the pin was on that page, in page px. Left out of comments from before it was kept. */
  at?: { x: number; y: number };
  from: Person;
  /**
   * A picture of the area round the pin as it was when the comment was made, which its author's
   * app makes and attaches a moment after the comment. Left out until then, for good when it
   * couldn't be made or kept, and on comments from before there were pictures. (Those may carry
   * `board`, the copy of a board earlier thumbnails drew; nothing reads it now.)
   */
  picture?: CommentPicture;
}

/**
 * A comment's picture: the area round its pin, the pin drawn in, in each theme. Each is a WebP
 * under the canvas's assets address, `COMMENT_PICTURE.scale` times its size as shown.
 */
export interface CommentPicture {
  /** `comments/<message id>-light.webp`, relative to the canvas's assets address. */
  light: string;
  dark: string;
  /** Its size as shown, in CSS px. */
  width: number;
  height: number;
}

/** The size a comment's picture is shown at, in CSS px, and how many device px it has to each. */
export const COMMENT_PICTURE = { width: 240, height: 160, scale: 2 } as const;

export interface AssistantItem {
  /** Markdown. Clipped to `MAX_TEXT` characters. */
  text: string;
}

/**
 * The agent's work, folded. With `turn`, one item per turn: it opens when the turn first shows
 * something (before the turn's first message, so everything the runner writes until the next
 * such item belongs to the turn), streams while the turn runs and finishes when it ends. Without
 * `turn` (an older runner), one stretch of tool calls between two things the agent said.
 * Clients that don't know `turn` show a streaming item's label as the working line and a
 * finished one as a quiet line, which reads well either way.
 */
export interface WorkItem {
  /**
   * While streaming, what the agent is doing ("Drawing "Pricing · B""); once finished, what it
   * did in a few words ("Worked on 3 boards and 2 files").
   */
  label: string;
  /** How many steps it took so far. */
  steps: number;
  /** The artboards it was on, by id. */
  artboards: string[];
  /** The turn's record: absent from what an older runner wrote. */
  turn?: TurnRecord;
}

export type TurnEnding = "done" | "stopped" | "failed";

/**
 * What a turn did, for the thread to fold away once it ends: how long it took, what it made,
 * which of its messages is its answer, and its steps between its messages. Never a tool's input
 * or output; each step is a phrase ("Drew "Hero"", "Edited src/app/page.tsx").
 */
export interface TurnRecord {
  /** How it ended; null while it runs. A turn that ends on a question is `done`. */
  ended: TurnEnding | null;
  /** How long it ran, so far, in milliseconds. */
  ms: number;
  /**
   * Its answer: the id of its last `assistant` item, which stays in full when the turn folds.
   * Null when there is none, or it went on working after it (stopped or failed mid-step).
   */
  final: string | null;
  /** How many boards it made or changed, and files it changed, each counted once. */
  boards: number;
  files: number;
  /**
   * Its steps in order, grouped after each message. At most `MAX_TURN_GROUPS` with text, and
   * twice that in all: past them, steps are only counted.
   */
  log: StepGroup[];
}

export interface StepGroup {
  /** The `assistant` item these came after; null before the turn's first message. */
  after: string | null;
  /** The step, said in the past tense; null for steps past the limit, only counted. */
  text: string | null;
  /** How many times, after that message. */
  count: number;
}

/** The most step groups a turn lists, and the longest one's text. */
export const MAX_TURN_GROUPS = 120;
export const MAX_STEP_TEXT = 120;

/** A notice as clients read it. */
export type Notice =
  | Exclude<RunnerNotice, { type: "stopped" }>
  /** A person stopped the run: the API names them from the stop event the runner wrote. */
  | { type: "stopped"; by: Person | null }
  /** Written by the API: the canvas's pull request opened, merged or closed. */
  | {
      type: "pull_request";
      number: number;
      url: string;
      title: string;
      state: "draft" | "open" | "merged" | "closed";
    }
  /** Written by the API: the agent did this to the pull request, as `as` on GitHub. */
  | {
      type: "pull_request_agent";
      action: AgentPullRequestDone;
      number: number;
      url: string;
      title: string;
      as: Person | null;
    }
  /**
   * Written by the API, once per change, as a runner session starts: the model the canvas was
   * made with is no longer one the Claude account offers, so it runs on `to` in its place
   * ("Models"). Both are model ids, each with the name Ponzu knew it by then (the id itself when
   * it knew none). `account` is whose Claude it is, as they were then; null when the canvas's
   * owner is gone or is not the account's holder.
   */
  | {
      type: "model_changed";
      from: string;
      to: string;
      fromName: string;
      toName: string;
      account: Person | null;
    };

/** What the agent did to its pull request, as its thread's line says. */
export type AgentPullRequestDone = "opened" | "ready" | "updated_branch" | "auto_merge" | "merged";

/**
 * The notices a runner may write. The API refuses any other type with 400: what only the API
 * knows (a pull request, who stopped the run) is never taken from the sandbox, where the agent
 * can run anything.
 */
export type RunnerNotice =
  /** The runner is starting; it becomes `resumed` or `started` once Claude is up. */
  | { type: "waking" }
  /** Claude picked up the canvas's session where it left off. */
  | { type: "resumed" }
  /** Claude started a new session for the canvas. */
  | { type: "started" }
  /** The agent asked something; the question itself is a question row. */
  | { type: "question"; questionId: string; header: string; text: string }
  /** The stop event that ended the turn. The API stores `{ type: "stopped", by }` from it. */
  | { type: "stopped"; eventId: string }
  | { type: "error"; code: RunErrorCode; message: string };

export type RunErrorCode =
  /** The repository could not be cloned or its branch checked out. */
  | "clone_failed"
  /** Anthropic refused the Claude credential: reconnect Claude. */
  | "claude_auth"
  /** The Claude plan or key is at its limit. */
  | "claude_limit"
  /** The model asked for does not exist or is not available. */
  | "model_unavailable"
  /** The turn ended at Claude Code's turn limit. */
  | "max_turns"
  /** The turn failed some other way; the message says how. */
  | "turn_failed"
  /** Claude Code itself stopped and had to be started again. */
  | "agent_exited"
  /** The repository's Claude Code settings (a `UserPromptSubmit` hook) turned a message away. */
  | "message_refused"
  /** The API would not take a question, so nobody could answer it and the agent went on. */
  | "question_failed"
  /** Commits on the canvas's branch could not be pushed to GitHub; the message says why. */
  | "push_failed";

/** The longest text one thread item carries. Longer agent text is clipped, with an ellipsis. */
export const MAX_TEXT = 32_000;

/** What the runner writes. */
export type ThreadWrite = {
  /** Chosen by the runner, `ti_` and 16 characters: writing the same id again is safe. */
  id: string;
  streaming: boolean;
} & (
  | Extract<ThreadContent, { kind: "assistant" | "tool" }>
  | { kind: "notice"; payload: RunnerNotice }
);

/**
 * `POST /v1/runner/thread`. Each item is written by id within the canvas: an id the thread
 * does not have is appended, one that is still streaming has its payload replaced, and one
 * that has finished stays as it is.
 */
export interface ThreadRequest {
  items: ThreadWrite[];
}

export interface ThreadResponse {
  items: { id: string; seq: number; streaming: boolean }[];
}

/** The most items one thread write carries. */
export const MAX_THREAD_WRITE = 32;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export type AgentState = "working" | "needs_you" | "idle";

/**
 * `PUT /v1/runner/state`: what the agent is doing, as the canvas's row shows it. Sent when it
 * changes and at least every `HEARTBEAT_MS` while the runner is alive.
 */
export interface StateRequest {
  state: AgentState;
  /**
   * While working, the working state: what the tool running now is doing ("Reading
   * src/app/page.tsx"), else what the agent said it is about since it last spoke, else
   * "Thinking". Otherwise what is wrong, if anything (a clone that failed).
   */
  status: string | null;
  /** The artboards it is on. */
  artboards: string[];
  /** The Claude session, once Claude Code has said which it is. Stored for the next resume. */
  claudeSessionId: string | null;
  /**
   * The canvas's branch in this sandbox against GitHub, once the runner has looked: what Create
   * PR goes by while GitHub lacks commits. Absent: unchanged. Null for Scratch, or a checkout
   * that failed.
   */
  branch?: BranchReport | null;
}

/** The canvas's branch in the sandbox against GitHub. */
export interface BranchReport {
  /** Commits on the branch that GitHub does not have. */
  unpushed: number;
  /** Why the last push of them failed, in words for a person; null when it did not. */
  error: string | null;
}

export interface StateResponse {
  /** The canvas's head, so the runner's replica can catch up. */
  seq: number;
}

/** How often a live runner reports its state, changed or not. */
export const HEARTBEAT_MS = 30_000;
/** How long the API waits without a report before it takes the runner for dead. */
export const RUNNER_TIMEOUT_MS = 90_000;

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */

export type QuestionKind = "question" | "plan" | "permission";

export interface AskedQuestion {
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export type QuestionBody =
  /** Claude's AskUserQuestion: one to four questions, each with two to four options. */
  | { kind: "question"; payload: { questions: AskedQuestion[] } }
  /** Claude wants a plan approved before it goes on (ExitPlanMode). */
  | { kind: "plan"; payload: { plan: string } }
  /** Claude wants to do something only a person can allow. */
  | { kind: "permission"; payload: { tool: string; title: string; description: string | null } };

/**
 * `POST /v1/runner/questions`. The runner chooses the id (`q_` and 16 characters), so raising
 * the same question again is safe. The answer comes back as an `answer` event.
 */
export type QuestionRequest = { id: string } & QuestionBody;

export interface QuestionResponse {
  id: string;
  status: "open" | "answered" | "cancelled";
}

/** `POST /v1/runner/questions/withdraw`: the run moved on, so nobody need answer these. */
export interface WithdrawRequest {
  ids: string[];
}

export interface WithdrawResponse {
  withdrawn: number;
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

/**
 * `asset`: one of the canvas's files. `export`: a file a link reaches. `preview`: the sidebar's
 * picture. `session` and `workspace`: a checkpoint's archives (the transcript, a Scratch
 * canvas's files), stored where no client reads them and recorded only by `/v1/runner/checkpoint`.
 */
export type UploadPurpose = "asset" | "export" | "preview" | "session" | "workspace";

/** `POST /v1/runner/uploads`: somewhere to put bytes. */
export interface UploadRequest {
  files: {
    purpose: UploadPurpose;
    /** A file name with its extension. A preview is `light.png` or `dark.png`. */
    name: string;
    contentType: string;
    size: number;
    /** Hex. The address takes these bytes and no others. */
    sha256: string;
  }[];
}

export interface UploadResponse {
  files: {
    id: string;
    /** PUT the bytes here, with exactly these headers and no Authorization. */
    put: { url: string; headers: Record<string, string> };
    expiresAt: string;
  }[];
}

/** `POST /v1/runner/uploads/complete`: the bytes are there. */
export interface CompleteRequest {
  ids: string[];
  /** For previews: the canvas's seq they show. */
  seq?: number;
}

export interface CompleteResponse {
  files: {
    id: string;
    /** An asset's reference, `assets/<name>`. Null for the other purposes. */
    ref: string | null;
    /** Where the file is served from. */
    url: string;
  }[];
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

/** `POST /v1/runner/git-credential` and `…/erase`: what git asked its credential helper. */
export interface GitCredentialRequest {
  protocol: string;
  host: string;
  /** `owner/name.git`: git sends it with `credential.useHttpPath`. */
  path: string;
  /**
   * On `erase` only: why the token is given back, as the runner saw GitHub refuse it (its HTTP
   * status, or git's last words), for the API's log. Never a secret.
   */
  reason?: string;
}

/**
 * `POST /v1/runner/git-report`: what the runner saw of git and GitHub in the sandbox, for the
 * API's log, so a push GitHub refuses can be understood from the API's logs alone: its checks of
 * a token before git gets it (git-token.ts) and each push it makes (push.ts). Only logged; never
 * a token (`fingerprint` names one) and never anything a person typed.
 */
export interface GitReport {
  name: GitReportName;
  fields: Record<string, string | number | boolean | null>;
}

export const GIT_REPORTS = [
  "git_credential_ready",
  "git_credential_refused",
  "git_credential_unchecked",
  "git_credential_unready",
  "git_push",
] as const;
export type GitReportName = (typeof GIT_REPORTS)[number];

export interface GitCredentialResponse {
  username: string;
  password: string;
  expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Pull request                                                        */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/runner/pull-request-summary`: the agent's words on what its branch changes, for the
 * pull request's description. The API opens and edits the pull request; the agent has no GitHub
 * API token. Sending it again replaces what was sent before.
 */
export interface PullRequestSummaryRequest {
  /** Markdown, at most `MAX_PULL_REQUEST_SUMMARY` characters. */
  summary: string;
}

export const MAX_PULL_REQUEST_SUMMARY = 8_000;

export interface PullRequestSummaryResponse {
  /** The open pull request whose description now says it; null while it waits for one. */
  pullRequest: number | null;
  /**
   * The canvas's pull request as the app shows it, whether or not the summary reached it: so the
   * agent can say truly whether one exists. Absent from an API that does not say.
   */
  open?: PullRequestState | null;
  /**
   * Why the summary was only kept: no pull request is open (`none_open`), or one is open and its
   * description was rewritten on GitHub without Ponzu's part (`rewritten`), or GitHub could not
   * be read (`unreadable`). Null when it was written in.
   */
  kept?: "none_open" | "rewritten" | "unreadable" | null;
}

/**
 * What the agent does to its canvas's pull request through the API, which acts as a person
 * (docs/cloud.md, "The agent's pull request"): `POST /v1/runner/pull-request/<action>`.
 */
export type AgentPullRequestAction = "open" | "ready" | "update_branch" | "auto_merge" | "merge";

export const AGENT_PULL_REQUEST_ACTIONS: readonly AgentPullRequestAction[] = [
  "open",
  "ready",
  "update_branch",
  "auto_merge",
  "merge",
];

export interface AgentPullRequestRequest {
  /**
   * The event of the turn the agent is in: the last one the runner put into the session (not an
   * edit). The API decides from it who the agent acts as, and whether it may merge.
   */
  turn: string | null;
  /** For `merge` and `update_branch`: the commit the agent's checkout is at. */
  headSha?: string;
}

/** Where the canvas's pull request stands, for the agent: `GET /v1/runner/pull-request?turn=`. */
export interface PullRequestStanding {
  branch: { name: string; base: string; exists: boolean; aheadBy: number; behindBy: number };
  pullRequest: {
    number: number;
    url: string;
    /** Untrusted: what someone on GitHub may have written. */
    title: string;
    state: "draft" | "open" | "merged" | "closed";
    headSha: string;
    author: string | null;
    mergedBy: string | null;
    /** False when it conflicts with its base; null while GitHub works it out. */
    mergeable: boolean | null;
    mergeState: string;
    reviewDecision: "approved" | "changes_requested" | "review_required" | null;
    autoMerge: { enabledBy: string | null } | null;
    checks: {
      state: "none" | "running" | "passing" | "failing";
      complete: boolean;
      /** Untrusted names: whoever posts a check chooses its name. */
      items: { name: string; state: string; required: boolean; url: string | null }[];
    };
    reviews: { author: string | null; state: "approved" | "changes_requested" | "dismissed" }[];
    /** Line comments whose threads are not resolved. Untrusted text. */
    unresolved: { author: string | null; path: string; line: number | null; body: string }[];
    /** Why Merge would not ask GitHub now, as the API would refuse it; null when it would. */
    mergeHold: { code: string; message: string } | null;
  } | null;
  mergeMethod: "squash" | "merge" | "rebase" | null;
  autoMergeAllowed: boolean;
  /** The one thing the app's action button offers. */
  nextAction: string;
  /** Who Ponzu acts as on GitHub for the agent in this turn. */
  actingAs: { name: string; login: string };
  /** A person in Ponzu began this turn, so it may merge, mark ready and turn on auto-merge. */
  personTurn: boolean;
  /** Why not, when it is not. */
  notPersonTurn: string | null;
}

export interface AgentPullRequestAnswer extends PullRequestStanding {
  /** This call is what did it; false when there was nothing to do, or someone did it first. */
  did: boolean;
  /** `open` only: GitHub has nothing to open it from yet, and the runner was asked to push. */
  pushing: boolean;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Claude Code's estimate. */
  costUsd: number;
}

/** What one turn used. */
export interface TurnUsage {
  /** The turn's result uuid: recording the same turn again changes nothing. */
  id: string;
  claudeSessionId: string;
  at: string;
  models: ModelUsage[];
  /**
   * How the turn went, for analytics ("turn started" and "turn finished"). Sent for every turn
   * a runner sees end, used or not; an older runner leaves it out.
   */
  turn?: TurnReport;
}

/** How a turn went. */
export interface TurnReport {
  /** When Claude Code took up what began it, as an ISO 8601 time. */
  startedAt: string;
  outcome: TurnOutcome;
  /** Why it failed, as the thread's error notice says; null when it did not. */
  errorCode: RunErrorCode | null;
  durationMs: number;
  /** How many tools the agent called, its subagents' included. */
  toolCalls: number;
  /**
   * The event whose message began it (`evt_…`): the API reads from its row whom the turn was for
   * and the app session that sent it. Null for a turn no event began (the runner's own notice).
   */
  eventId: string | null;
}

export type TurnOutcome = "completed" | "failed" | "stopped";

/** `POST /v1/runner/usage`. */
export interface UsageRequest {
  turns: TurnUsage[];
}

export interface UsageResponse {
  recorded: number;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Every error the API answers with. */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* Repo secrets                                                        */
/* ------------------------------------------------------------------ */

/**
 * The one variable a canvas's repo's secrets reach its sandbox in. The runner, a Bun process
 * that holds the runner token, never has them as variables of its own: a name like
 * `BUN_OPTIONS` would load code into it before it starts. It hands them only to the agent's
 * side, beside what it has itself (`agentEnv`). And whatever writes the sandbox's environment
 * to a file a shell then sources, a value in it is only letters, digits, `+`, `/` and `=`.
 */
export const REPO_SECRETS_VARIABLE = "PONZU_REPO_SECRETS";

/** `NAME:base64(value)`, comma-separated: each value's UTF-8 in standard base64. */
export function encodeRepoSecrets(secrets: Iterable<[name: string, value: string]>): string {
  return Array.from(secrets, ([name, value]) => `${name}:${toBase64(value)}`).join(",");
}

/**
 * The secrets `encodeRepoSecrets` wrote, by name. An entry that is not a name and base64 is
 * left out: a malformed variable costs the agent a secret, never the runner its start.
 */
export function decodeRepoSecrets(encoded: string | undefined): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const entry of encoded ? encoded.split(",") : []) {
    const match = /^([A-Z][A-Z0-9_]*):([A-Za-z0-9+/]*={0,2})$/.exec(entry);
    if (!match) continue;
    try {
      secrets[match[1]!] = fromBase64(match[2]!);
    } catch {
      // Not base64 after all, or not UTF-8: left out.
    }
  }
  return secrets;
}

function toBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
