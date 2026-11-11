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
