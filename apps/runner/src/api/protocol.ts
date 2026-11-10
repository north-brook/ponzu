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

/** `GET /v1/runner/session`: everything the runner needs to start. */
export interface RunnerSession {
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
  /** Questions an earlier run left open. Nobody can answer them in this run. */
  openQuestions: string[];
  /** The design's head: its latest committed op. */
  seq: number;
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
  body: string;
  url: string | null;
  /** How many line comments came with it. */
  comments: number;
}

/** `POST /v1/runner/events/claim`. */
export interface ClaimRequest {
  /**
   * The first claim of a process: also hand back events an earlier process claimed and never
   * acknowledged. It is gone, so they are this one's now.
   */
  restart?: boolean;
  /** At most this many, oldest first. 100 when absent. */
  limit?: number;
}

export interface ClaimResponse {
  events: RunnerEvent[];
  /** The design's head, so the runner's replica can catch up. */
  seq: number;
}

/** `POST /v1/runner/events/ack`: these are in the Claude session and never to be handed out again. */
export interface AckRequest {
  ids: string[];
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
      };
    }
  /** What the agent says. Streams as it is written. */
  | { kind: "assistant"; payload: AssistantItem }
  /** One stretch of work between two things the agent says. While it streams it is the working line. */
  | { kind: "tool"; payload: WorkItem }
  | { kind: "notice"; payload: Notice };

export type ThreadKind = ThreadContent["kind"];

export interface AssistantItem {
  /** Markdown. Clipped to `MAX_TEXT` characters. */
  text: string;
}

/**
 * A stretch of tool calls, folded to one line. Clients show the newest one that is streaming
 * as the working line ("Drawing Pricing · B"), and may fold or hide finished ones.
 */
export interface WorkItem {
  /** What the agent is doing, or last did, in a few words. */
  label: string;
  /** How many steps the stretch took so far. */
  steps: number;
  /** The artboards it changed, by id. */
  artboards: string[];
}

export type Notice =
  /** The runner is starting; it becomes `resumed` or `started` once Claude is up. */
  | { type: "waking" }
  /** Claude picked up the design's session where it left off. */
  | { type: "resumed" }
  /** Claude started a new session for the design. */
  | { type: "started" }
  /** The agent asked something; the question itself is a question row. */
  | { type: "question"; questionId: string; header: string; text: string }
  /** A person stopped the run. */
  | { type: "stopped"; by: Person | null }
  | { type: "error"; code: RunErrorCode; message: string }
  /** Written by the API: the design's pull request opened, merged or closed. */
  | {
      type: "pull_request";
      number: number;
      url: string;
      title: string;
      state: "draft" | "open" | "merged" | "closed";
    };

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
  | "agent_exited";

/** The longest text one thread item carries. Longer agent text is clipped, with an ellipsis. */
export const MAX_TEXT = 32_000;

/** What the runner writes. */
export type ThreadWrite = {
  /** Chosen by the runner, `ti_` and 16 characters: writing the same id again is safe. */
  id: string;
  streaming: boolean;
} & Extract<ThreadContent, { kind: "assistant" | "tool" | "notice" }>;

/**
 * `POST /v1/runner/thread`. Each item is written by id: an id the thread does not have is
 * appended, one that is still streaming has its payload replaced, and one that has finished
 * stays as it is.
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
  /** A few words on what it is doing. Null when it has not said, and when idle. */
  status: string | null;
  /** The artboards it is on. */
  artboards: string[];
  /** The Claude session, once Claude Code has said which it is. Stored for the next resume. */
  claudeSessionId: string | null;
}

export interface StateResponse {
  /** The design's head, so the runner's replica can catch up. */
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

/** `asset`: one of the design's files. `export`: a file a link reaches. `preview`: the sidebar's picture. */
export type UploadPurpose = "asset" | "export" | "preview";

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
