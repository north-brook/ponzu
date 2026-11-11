/*
 * The wire protocol between a design's runner and the API (docs/cloud.md, "The runner
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
   * This process, `rnr_` and 16 characters: minted by this call, which makes it the design's
   * one runner. Sent as `X-Ponzu-Runner` on every later call.
   */
  runnerId: string;
  design: { id: string; name: string };
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
  /** Opens the design in Ponzu. */
  link: string;
  /** The theme of the canvas of the person the agent works for, once known. */
  theme: Theme | null;
  /**
   * Questions an earlier run left open, which people can still answer: the answer comes in as
   * a message. They stay open until the next turn ends.
   */
  openQuestions: string[];
  /** The design's head: its latest committed op. */
  seq: number;
  /**
   * The design's last checkpoint, as the API recorded it: a runner whose disk is behind it
   * (a rollback) or holds none of it (a new sandbox) restores from it before it resumes.
   */
  saved: SavedPoint | null;
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
   * A repo design's work in progress: a commit on `refs/ponzu/wip/<design id>` whose parent is
   * the checkout's HEAD and whose tree is its working tree, untracked files included.
   */
  wipCommit: string | null;
  /** Whether the transcript, and a Scratch design's files, are stored with it. */
  session: boolean;
  workspace: boolean;
}

/** The hidden ref a repo design's work in progress is pushed to. Never a branch. */
export const wipRef = (designId: string) => `refs/ponzu/wip/${designId}`;

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

/** `POST /v1/runner/restore`: the design's last checkpoint and where to read its archives. */
export interface RestoreResponse {
  saved: SavedPoint | null;
  session: SavedArchive | null;
  workspace: SavedArchive | null;
}

/**
 * `POST /v1/runner/restored`: the runner found its disk behind the design's last checkpoint and
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

/** Something that happened to the design, for the agent to take up. */
export type RunnerEvent = {
  id: string;
  /** Its place in the design's feed. Increasing, with gaps. */
  seq: number;
  /** When it happened, as an ISO 8601 time. */
  at: string;
  priority: Priority;
  /** The person behind it. Null when GitHub was. */
  from: Person | null;
} & EventBody;

export type EventBody =
  | { kind: "message"; payload: MessageEvent }
  | { kind: "answer"; payload: AnswerEvent }
  | { kind: "comment"; payload: CommentEvent }
  | { kind: "edit"; payload: EditEvent }
  | { kind: "check"; payload: CheckEvent }
  | { kind: "review"; payload: ReviewEvent }
  | { kind: "stop"; payload: Record<string, never> };

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
  /** The artboard the pin is on, with its name when the comment was made. Null on the open canvas. */
  artboardId: string | null;
  artboardName: string | null;
  /** The node the pin points at, if any. */
  nodeId: string | null;
}

/** An artboard as the document held it at a moment: `Artboard` from @ponzu/core, by shape. */
export interface FrozenBoard {
  id: string;
  name: string;
  x: number;
  y: number;
  root: unknown;
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
  /** The design's head, so the runner's replica can catch up. */
  seq: number;
}

/** `POST /v1/runner/events/ack`: these are in the Claude session and never to be handed out again. */
export interface AckRequest {
  ids: string[];
  /**
   * The Claude session that holds them, stored as the design's session in the same
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
 * One item of a design's thread, as clients read it. People's messages and comments are the
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
  /** Written by the API when a comment reaches the agent: shown with a thumbnail of its board. */
  | {
      kind: "comment";
      payload: {
        threadId: string;
        messageId: string;
        text: string;
        artboardId: string | null;
        artboardName: string | null;
        from: Person;
        /**
         * The board as it was when the comment was made (an @ponzu/core `Artboard`), so its
         * thumbnail shows what was commented on rather than the board now. Left out on the
         * open canvas, and for a board too large to keep a copy of: the thumbnail is then live.
         */
        board?: FrozenBoard;
      };
    }
  /** What the agent says. Streams as it is written. */
  | { kind: "assistant"; payload: AssistantItem }
  /**
   * The agent's work. A runner that writes `turn` writes one per turn, streaming while the turn
   * runs; an older one wrote one per stretch of work between two things the agent said.
   */
  | { kind: "tool"; payload: WorkItem }
  | { kind: "notice"; payload: Notice };

export type ThreadKind = ThreadContent["kind"];

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
  /** Written by the API: the design's pull request opened, merged or closed. */
  | {
      type: "pull_request";
      number: number;
      url: string;
      title: string;
      state: "draft" | "open" | "merged" | "closed";
    };

/**
 * The notices a runner may write. The API refuses any other type with 400: what only the API
 * knows (a pull request, who stopped the run) is never taken from the sandbox, where the agent
 * can run anything.
 */
export type RunnerNotice =
  /** The runner is starting; it becomes `resumed` or `started` once Claude is up. */
  | { type: "waking" }
  /** Claude picked up the design's session where it left off. */
  | { type: "resumed" }
  /** Claude started a new session for the design. */
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
  | "question_failed";

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
 * `POST /v1/runner/thread`. Each item is written by id within the design: an id the thread
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
 * `PUT /v1/runner/state`: what the agent is doing, as the design's row shows it. Sent when it
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
   * The sleep this runner is ready for: the `sleep` an answer named, once it has finished its
   * turn, let its edits reach the API, saved a checkpoint and flushed the disk.
   */
  quiesced?: string | null;
}

export interface StateResponse {
  /** The design's head, so the runner's replica can catch up. */
  seq: number;
  /**
   * While the API is putting the sandbox to sleep: which stop (an ISO 8601 time). The runner
   * takes no new work and gets ready, then says so with `quiesced`. Null otherwise; absent from
   * an API that does not ask.
   */
  sleep?: string | null;
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
 * `asset`: one of the design's files. `export`: a file a link reaches. `preview`: the sidebar's
 * picture. `session` and `workspace`: a checkpoint's archives (the transcript, a Scratch
 * design's files), stored where no client reads them and recorded only by `/v1/runner/checkpoint`.
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
  /** For previews: the design's seq they show. */
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
}

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
}

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
 * The one variable a design's repo's secrets reach its sandbox in. The runner, a Bun process
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
