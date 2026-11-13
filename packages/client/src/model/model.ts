/*
 * The product's concepts as the cloud UI takes them. Components are driven by these alone; the
 * data layer maps API rows and live queries onto them, and the gallery's fixtures produce them.
 * Times are ISO 8601 strings, as the API sends them.
 */

import type { Match } from "@ponzu/core/search-text";

/*
 * The database's enums (packages/db/src/enums.ts), restated rather than imported so the app
 * doesn't depend on the database package. The typed API client will carry them.
 */
export type WorkspaceKind = "personal" | "org";
export type CanvasStatus = "active" | "settled";
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

/** Where a canvas's work lives: a branch of a repo, or Scratch, kept in Ponzu and named after a city. */
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

/** Light and dark pictures of a canvas's first page, drawn by its sandbox. */
export interface CanvasPreview {
  light: string;
  dark: string;
}

/** A canvas as a list shows it: the sidebar, search, the phone. */
export interface CanvasSummary {
  id: string;
  name: string;
  project: Project;
  preview: CanvasPreview | null;
  status: CanvasStatus;
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

/** A page of the open canvas, as its tab shows it. */
export interface PageTab {
  id: string;
  name: string;
  /** One of the canvas's page icon names, chosen by the agent. */
  icon: string | null;
  /** The agent is drawing on it. */
  working: boolean;
}

/** Someone who has worked on a canvas, for the presence avatars. */
export interface Contributor {
  person: Person;
  here: boolean;
  /** When they were last in it, for someone away. */
  lastHereAt: string | null;
}

/** What someone may do with a canvas, as Share lists it. GitHub decides it. */
export type CanvasAccess = "owner" | "edit" | "view";

export interface CanvasMember {
  person: Person;
  access: CanvasAccess;
  /** Whether they have opened Ponzu: GitHub gives access to people who haven't yet. */
  joined: boolean;
}

/** A prompt the create page offers for the chosen repo. */
export interface Idea {
  id: string;
  prompt: string;
}

/** A model the person's Claude account offers, as `/v1/claude/defaults` lists it. */
export interface ModelOption {
  id: string;
  /** "Opus 5.5", or the name Claude Code gives a model Ponzu has never heard of. */
  label: string;
  /** The effort levels it takes, when it says; otherwise every level the list offers. */
  efforts?: readonly Effort[];
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The efforts `model` takes: its own, or `efforts` when it says nothing of them. */
export function effortsOf(
  models: readonly ModelOption[],
  efforts: readonly Effort[],
  model: string,
): readonly Effort[] {
  return models.find((m) => m.id === model)?.efforts ?? efforts;
}

/**
 * The effort to keep when the model changes to `model`: the one chosen while it takes it, else
 * medium (the default) while it takes that, else the first it takes.
 */
export function effortFor(
  models: readonly ModelOption[],
  efforts: readonly Effort[],
  model: string,
  effort: Effort,
): Effort {
  const takes = effortsOf(models, efforts, model);
  if (takes.includes(effort)) return effort;
  if (takes.includes("medium")) return "medium";
  return takes[0] ?? effort;
}

/** A start of a match in a search result's text, and its end (exclusive): search's, in core. */
export type { Match };

/**
 * A search's answer as the window shows it, every group in the order the list draws them. Each
 * hit is on a canvas the window lists (the rest are dropped: the list is what may be shown), and
 * `matches` are offsets into the text the row draws: a canvas's, board's or pull request's name
 * or title, a comment's or message's snippet, a person's name or login.
 */
export interface SearchResults {
  query: string;
  canvases: CanvasHit[];
  /** Pages and boards, as the server ranked them. */
  boards: BoardHit[];
  comments: CommentHit[];
  messages: MessageHit[];
  pullRequests: PullRequestHit[];
  people: PersonHit[];
}

/** The canvas a hit is on, as its row names it. */
export interface HitCanvas {
  id: string;
  name: string;
}

/** Who said what a comment or message hit holds: a person, the canvas's agent, or someone gone. */
export type HitAuthor = Person | "agent" | "deleted";

export interface CanvasHit {
  canvas: CanvasSummary;
  matches: Match[];
}

export interface BoardHit {
  /** The page's or the board's id. */
  id: string;
  place: "page" | "board";
  /** The page a board is on; a page's own id for a page. Null when the board's page is unknown. */
  pageId: string | null;
  name: string;
  /** A page's icon (one of the canvas's page icon names), when the window knows it. */
  icon: string | null;
  matches: Match[];
  canvas: HitCanvas;
}

export interface CommentHit {
  /** The comment's message id. */
  id: string;
  threadId: string;
  /** Null for a comment on the page rather than a board, or an old one that never said. */
  pageId: string | null;
  artboardId: string | null;
  resolved: boolean;
  /** The words around the match, at most about 140 characters, with "…" where they were cut. */
  snippet: string;
  matches: Match[];
  author: HitAuthor;
  canvas: HitCanvas;
  /** When it was said; null when the server doesn't know. */
  at: string | null;
}

export interface MessageHit {
  /** The thread item's id, and its place in the thread. */
  id: string;
  seq: number;
  snippet: string;
  matches: Match[];
  author: HitAuthor;
  canvas: HitCanvas;
  at: string | null;
}

export interface PullRequestHit {
  number: number;
  title: string;
  matches: Match[];
  /** Null unless it is the canvas's current pull request. */
  state: PrState | null;
  canvas: HitCanvas;
}

export interface PersonHit {
  id: string;
  login: string;
  /** Their name on GitHub; null when they show none. */
  name: string | null;
  avatarUrl: string | null;
  nameMatches: Match[];
  loginMatches: Match[];
}

/*
 * The thread: what the rail draws. The kinds and payloads are the runner protocol's
 * (`ThreadItem` in @ponzu/runner/protocol), with people resolved to their avatars, and a
 * message's attachments and a comment's picture to their addresses.
 */

/** An image a person sent with a message: one of the canvas's files. */
export interface Attachment {
  /** `assets/<name>`, as the message names it. */
  ref: string;
  url: string;
  contentType: string;
}

/**
 * A picture of the area round a comment's pin as it was when the comment was made, at its size
 * as shown: its files in each theme (for the viewer's own, local copies), or, while the viewer's
 * own app is still making them, what stands in for them meanwhile (`renderDrawing`).
 */
export type CommentPicture = { width: number; height: number } & (
  | { kind: "image"; light: string; dark: string }
  | { kind: "drawing" }
);

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
  | "question_failed"
  | "push_failed";

/**
 * What a turn did, as the runner records it (`TurnRecord` in @ponzu/runner/protocol): how it
 * ended, how long it took, its answer's item, what it made, and its steps after each message.
 */
export interface TurnRecord {
  ended: "done" | "stopped" | "failed" | null;
  ms: number;
  final: string | null;
  boards: number;
  files: number;
  log: { after: string | null; text: string | null; count: number }[];
}

export type ThreadNotice =
  | { type: "waking" }
  | { type: "resumed" }
  | { type: "started" }
  | {
      type: "question";
      questionId: string;
      header: string;
      text: string;
      /** Once it closed: what was picked, in a few words ("Royal blue", "Yes"); else absent. */
      answer?: string | null;
    }
  | { type: "error"; code: RunErrorCode; message: string }
  | { type: "stopped"; by: Person | null }
  | { type: "pull_request"; number: number; url: string; title: string; state: PrState }
  /** The agent did this to the pull request on GitHub, as `as`. */
  | {
      type: "pull_request_agent";
      action: AgentPrAction;
      number: number;
      url: string;
      title: string;
      as: Person | null;
    }
  /** Someone took the canvas over once its owner had left: it runs on their Claude now. */
  | { type: "owner_changed"; by: Person }
  /**
   * The model the canvas was made with is no longer one its Claude account offers, so it runs
   * on `to` in its place. The names are the ones Ponzu knew then; `account` is whose Claude it
   * is, null when that is not known.
   */
  | {
      type: "model_changed";
      from: string;
      to: string;
      fromName: string;
      toName: string;
      account: Person | null;
    };

/** What the agent did to its pull request, as its thread line says. */
export type AgentPrAction = "opened" | "ready" | "updated_branch" | "auto_merge" | "merged";

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
        /** The page it was left on, by name, when it was left on the ground. */
        pageName: string | null;
        from: Person;
        /** Its picture; null when there is none to show, and the comment says where it was left. */
        picture: CommentPicture | null;
      };
    }
  /** Markdown, from the model: untrusted text. */
  | { kind: "assistant"; payload: { text: string } }
  /**
   * The agent's work, never a line of its own: with `turn`, one item per turn that opens it
   * (thread.ts reads its asides and answer by it; of the record only `final`, `ended` and
   * `log[].after`); without, a stretch of work an older runner wrote between two things the
   * agent said.
   */
  | {
      kind: "tool";
      payload: { label: string; steps: number; artboards: string[]; turn?: TurnRecord };
    }
  | { kind: "notice"; payload: ThreadNotice }
);

/** What the agent is doing, from the canvas's head: its state and its working line. */
export interface AgentActivity {
  state: AgentState;
  status: string | null;
  /**
   * Why its sandbox isn't running: every machine it may start is taken, so it waits its turn;
   * Ponzu has paused wakes while it updates (`paused`); or starting one failed. Messages are
   * kept either way, and go in once it runs.
   */
  sandbox?: "busy" | "paused" | "failed" | null;
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
 * Why nobody can steer the canvas right now. The run waits on its owner's Claude, for everyone;
 * someone with read access can watch it but not steer it.
 */
export type SteerGate =
  | { kind: "read_only"; repo: Repo | null }
  | { kind: "claude_limit"; owner: Person; until: string }
  | { kind: "claude_disconnected"; owner: Person }
  /** The owner's subscription sign-in ran out: they connect it again. */
  | { kind: "claude_expired"; owner: Person }
  /**
   * Whoever it runs on left the workspace, or deleted their account: nobody's Claude runs it
   * until someone who can change it takes it over, on their own Claude. `canTakeOver`: the
   * viewer can, having write access and Claude connected. `repo`: who may, in other words.
   */
  | { kind: "claude_owner_left"; canTakeOver: boolean; repo: Repo | null };

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
 * An answer, as `POST /v1/canvases/:id/questions/:questionId/answer` takes it: a question's
 * answers by question text; yes or no to a plan, a permission or a hand-off; a secret's value,
 * which the API keeps in the repo's secrets and never in a row.
 */
export type AskAnswer =
  | { answers: Record<string, string> }
  | { approved: boolean; note?: string }
  | { secret: string };

/*
 * The pull request tab: the canvas's pull request as GitHub has it, read through the App. These
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
