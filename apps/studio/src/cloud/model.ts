/*
 * The product's concepts as the cloud UI takes them. Components are driven by these alone; the
 * data layer maps API rows and live queries onto them, and the gallery's fixtures produce them.
 * Times are ISO 8601 strings, as the API sends them.
 */

/*
 * The database's enums (packages/db/src/enums.ts), restated rather than imported so the app
 * doesn't depend on the database package. The typed API client will carry them.
 */
export type WorkspaceKind = "personal" | "org";
export type DesignStatus = "active" | "settled";
export type AgentState = "idle" | "waking" | "working" | "needs_you" | "limited";
export type PrState = "draft" | "open" | "merged" | "closed";
export type PrChecks = "none" | "running" | "failing" | "passing";

/** Someone signed in to Ponzu: a GitHub account. */
export interface Person {
  id: string;
  name: string;
  /** Their GitHub login. */
  login: string;
  avatarUrl: string | null;
}

/** "Maya" of "Maya Ortiz": how dense lines name someone. */
export function firstName(person: Person): string {
  return person.name.trim().split(/\s+/)[0] ?? person.name;
}

/** A GitHub account (a person's or an organization's) with the Ponzu App installed. */
export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  /** The account's display name ("Northbrook"); a personal workspace reads "Personal". */
  name: string;
  /** The account's GitHub login, which repo paths use ("north-brook"). */
  login: string;
  /** The organization's logo, or the person's avatar for a personal workspace. */
  avatarUrl: string | null;
}

export interface Repo {
  id: string;
  /** The owning account's login. */
  owner: string;
  name: string;
}

/** Where a design's work lives: a branch of a repo, or Scratch, kept in Ponzu and named after a city. */
export type Project =
  | { kind: "repo"; repo: Repo; branch: string }
  | { kind: "scratch"; city: string };

export interface PullRequestSummary {
  number: number;
  state: PrState;
  checks: PrChecks;
  /** False when the branch conflicts with its base; null until GitHub has worked it out. */
  mergeable: boolean | null;
  autoMerge: boolean;
}

/** Light and dark pictures of a design's first page, drawn by its sandbox. */
export interface DesignPreview {
  light: string;
  dark: string;
}

/** A design as a list shows it: the sidebar, search, the phone. */
export interface DesignSummary {
  id: string;
  name: string;
  project: Project;
  preview: DesignPreview | null;
  status: DesignStatus;
  agentState: AgentState;
  /** Questions waiting for the viewer. */
  needsYou: number;
  /** Something happened since the viewer last opened it. */
  unseen: boolean;
  pullRequest: PullRequestSummary | null;
  /** Teammates in it right now, not counting the viewer. */
  hereNow: Person[];
  owner: Person | null;
  lastActivityAt: string;
  settledAt: string | null;
}

/** A page of the open design, as its tab shows it. */
export interface PageTab {
  id: string;
  name: string;
  /** One of the canvas's page icon names, chosen by the agent. */
  icon: string | null;
  /** The agent is drawing on it. */
  working: boolean;
}

/** Someone who has worked on a design, for the presence avatars. */
export interface Contributor {
  person: Person;
  here: boolean;
  /** When they were last in it, for someone away. */
  lastHereAt: string | null;
}

/** What someone may do with a design, as Share lists it. GitHub decides it. */
export type DesignAccess = "owner" | "edit" | "view";

export interface DesignMember {
  person: Person;
  access: DesignAccess;
}

/** A prompt the create page offers for the chosen repo. */
export interface Idea {
  id: string;
  prompt: string;
}

export interface ModelOption {
  id: string;
  /** "Opus 5.5" */
  label: string;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** A start of a match in a search result's text, and its end (exclusive). */
export type Match = readonly [start: number, end: number];

export interface SearchResults {
  query: string;
  designs: DesignHit[];
  boards: BoardHit[];
  comments: CommentHit[];
}

export interface DesignHit {
  design: DesignSummary;
  matches: Match[];
}

export interface BoardHit {
  id: string;
  name: string;
  matches: Match[];
  design: { id: string; name: string };
}

export interface CommentHit {
  id: string;
  threadId: string;
  text: string;
  matches: Match[];
  author: Person;
  design: { id: string; name: string };
  at: string;
}

/*
 * The thread: what the rail draws. The kinds and payloads are the runner protocol's
 * (`ThreadItem` in @ponzu/runner/protocol), with people resolved to their avatars, a message's
 * attachments to their addresses, and a comment's pin to where it sits on its board (from the
 * document's comment thread).
 */

/** An image a person sent with a message: one of the design's files. */
export interface Attachment {
  /** `assets/<name>`, as the message names it. */
  ref: string;
  url: string;
  contentType: string;
}

/**
 * Where a comment's pin sits in its board's miniature (`renderBoard`), as fractions of the
 * miniature's width and height.
 */
export interface Pin {
  x: number;
  y: number;
}

/** Why a turn ended badly, as the runner names it. Each has its own plain sentence in the rail. */
export type RunErrorCode =
  | "clone_failed"
  | "claude_auth"
  | "claude_limit"
  | "model_unavailable"
  | "max_turns"
  | "turn_failed"
  | "agent_exited"
  | "message_refused"
  | "question_failed";

export type ThreadNotice =
  | { type: "waking" }
  | { type: "resumed" }
  | { type: "started" }
  | { type: "question"; questionId: string; header: string; text: string }
  | { type: "error"; code: RunErrorCode; message: string }
  | { type: "stopped"; by: Person | null }
  | { type: "pull_request"; number: number; url: string; title: string; state: PrState };

export type ThreadItem = {
  id: string;
  /** Orders the thread. Increasing, with gaps. */
  seq: number;
  at: string;
  /** Still being written: its payload will change. */
  streaming: boolean;
} & (
  | {
      kind: "message";
      payload: {
        text: string;
        from: Person;
        attachments: Attachment[];
        /** The viewer's own message on its way, or one that didn't arrive; absent once it has. */
        delivery?: "sending" | "failed";
      };
    }
  | {
      kind: "comment";
      payload: {
        threadId: string;
        messageId: string;
        text: string;
        artboardId: string | null;
        artboardName: string | null;
        from: Person;
        pin: Pin | null;
      };
    }
  /** Markdown, from the model: untrusted text. */
  | { kind: "assistant"; payload: { text: string } }
  /** A stretch of work between two things the agent says, folded to one line. */
  | { kind: "tool"; payload: { label: string; steps: number; artboards: string[] } }
  | { kind: "notice"; payload: ThreadNotice }
);

/** What the agent is doing, from the design's head: its state and its working line. */
export interface AgentActivity {
  state: AgentState;
  status: string | null;
  /**
   * Why its sandbox isn't running: every machine it may start is taken, so it waits its turn;
   * or starting one failed. Messages are kept either way, and go in once it runs.
   */
  sandbox?: "busy" | "failed" | null;
}

/** Older items of the thread: more to fetch, fetching, or none. */
export type OlderItems = "more" | "loading" | "none";

/** An image on its way into the next message. */
export interface PendingAttachment {
  id: string;
  name: string;
  /** A local picture of it (an object URL), shown while it uploads. */
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
}

/**
 * Why nobody can steer the design right now. The run waits on its owner's Claude, for everyone;
 * someone with read access can watch it but not steer it.
 */
export type SteerGate =
  | { kind: "read_only"; repo: Repo | null }
  | { kind: "claude_limit"; owner: Person; until: string }
  | { kind: "claude_disconnected"; owner: Person }
  /** The owner's subscription sign-in ran out: they connect it again. */
  | { kind: "claude_expired"; owner: Person }
  /** Whoever it runs on left the workspace: nobody else's Claude stands in. */
  | { kind: "claude_owner_left" };

/*
 * Needs you: what the agent waits on a person for, in the composer's slot. `question`, `plan`
 * and `permission` are the runner's question rows; `secret` and `link` are the spec's default
 * shapes for a secret the agent needs and a hand-off it can't do itself, which the runner does
 * not raise yet.
 */

export interface AskedQuestion {
  /** A word or two: the strip's title. */
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * `sending` is the viewer's own answer on its way, or, for one that just left while they were on
 * it, Ponzu finding out how it closed; `answered`, `cancelled` and `closed` are closed. `closed`
 * is one that left while the viewer was answering it when Ponzu couldn't say how.
 */
export type AskStatus = "open" | "sending" | "answered" | "cancelled" | "closed";

/** The answer that closed an ask, as it was given: what the card shows as chosen. */
export interface AskGiven {
  /** For a question: each question's text, to the labels chosen and the note, as sent. */
  answers?: Record<string, string>;
  /** For a plan or a permission. */
  approved?: boolean;
  note?: string;
}

export type Ask = {
  id: string;
  status: AskStatus;
  /** Who answered it, once someone has. */
  answeredBy: Person | null;
  /** The answer that won, once someone else's has: shown in place of the viewer's own choice. */
  given?: AskGiven | null;
} & (
  | { kind: "question"; questions: AskedQuestion[] }
  /** Markdown, from the model. */
  | { kind: "plan"; plan: string }
  | { kind: "permission"; tool: string; title: string; description: string | null }
  | { kind: "secret"; name: string; description: string | null }
  | { kind: "link"; title: string; url: string; description: string | null }
);

/**
 * An answer, as `POST /v1/designs/:id/questions/:questionId/answer` takes it: a question's
 * answers by question text; yes or no to a plan, a permission or a hand-off; a secret's value,
 * which the API keeps in the repo's secrets and never in a row.
 */
export type AskAnswer =
  | { answers: Record<string, string> }
  | { approved: boolean; note?: string }
  | { secret: string };

/*
 * The pull request tab: the design's pull request as GitHub has it, read through the App. These
 * are the fields the tab draws; the API's answer is mapped onto them.
 */

/** Someone on GitHub, who need not be a Ponzu user. The agent's own words come as `agent`. */
export interface GithubAuthor {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  agent: boolean;
}

/** A check run or a commit status, as its row shows it. */
export interface CheckRun {
  id: string;
  name: string;
  state: "queued" | "running" | "passing" | "failing" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
  /** A status's own words ("Ready"), shown when there is no duration. */
  description: string | null;
  url: string | null;
}

/** A comment on the pull request: on the whole of it, or on a line of a file. */
export interface PrComment {
  id: string;
  author: GithubAuthor;
  /** Markdown, from GitHub: untrusted text. */
  body: string;
  at: string;
  path: string | null;
  line: number | null;
  url: string;
}

/** Each reviewer's latest approval or request for changes. */
export interface PrReview {
  id: string;
  author: GithubAuthor;
  state: "approved" | "changes_requested";
  at: string;
}

export interface PrFile {
  path: string;
  /** Where a renamed file was. */
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  /** Its diff, or null until it is asked for, when its card first opens. */
  diff: PrDiff | null;
}

/** A file's unified diff as GitHub gives it, or why there is none to show. */
export type PrDiff = { kind: "text"; patch: string } | { kind: "binary" } | { kind: "too_large" };

/** A file's diff as its card asks for it, with where a renamed file was. */
export interface LoadedDiff {
  diff: PrDiff;
  previousPath: string | null;
}

export interface PullRequestDetail {
  number: number;
  url: string;
  title: string;
  /** Markdown, from GitHub: untrusted text. */
  body: string;
  head: string;
  /** The commit the tab shows: an open file's diff is read again when it moves. */
  headSha: string;
  base: string;
  state: PrState;
  /** When it merged or closed, for a pull request that has. */
  endedAt: string | null;
  additions: number;
  deletions: number;
  checks: CheckRun[];
  /** False when GitHub has more checks than `checks` holds. */
  checksComplete: boolean;
  /** Oldest first. */
  comments: PrComment[];
  reviews: PrReview[];
  /** The first of them, when there are more than GitHub lists at once. */
  files: PrFile[];
  /** How many files the pull request changes. */
  filesTotal: number;
}
