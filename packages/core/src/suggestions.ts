/**
 * Designs the person's own coding agent suggests for their recent projects, for the home
 * screen's Suggested tab. One headless, read-only run of the agent looks around each project
 * and proposes a few; `GET /api/suggestions` has what it found, and
 * `POST /api/suggestions/refresh` looks again.
 */
export interface Suggestions {
  /** The agent that looks: Claude Code, else Codex. Null with neither, and no Suggested tab. */
  agent: SuggestionAgent | null;
  /** Newest first. */
  ideas: Idea[];
  /** A run is looking now; what it finds arrives at the front, project by project. */
  running: boolean;
}

export type SuggestionAgent = "claude" | "codex";

/** One design to ask for, tied to a project. No branch and no time: those are the agent tool's. */
export interface Idea {
  /** What the design would be called: "Every Seekle screen". */
  name: string;
  /** The project's folder: its main checkout. */
  project: string;
  /** What every checkout of the project shares, as a design's `git.project` has it. */
  projectId: string;
  /** The project's folder's name, as the prompt names it: "seekle". */
  projectName: string;
  /** The short text the card shows. */
  card: string;
  /** The whole prompt to copy. It names the folder and the design. */
  prompt: string;
  /** When the run that found it ended, ms since the epoch. */
  found: number;
}

/** An idea and a design are the same one when their names are, ignoring case, spaces and marks. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

/**
 * Whether a design is the one an idea asked for: called what the idea is, by its name or its
 * folder ("every-seekle-screen.design").
 */
export function startedAs(idea: Pick<Idea, "name">, file: { name: string; key: string }): boolean {
  const folder =
    file.key
      .split("/")
      .pop()
      ?.replace(/\.design$/, "") ?? "";
  return sameName(idea.name, file.name) || sameName(idea.name, folder);
}

/** How long a design started from an idea keeps the idea's place in Suggested, as its real card. */
export const STARTED_FOR = 10 * 60_000;

/**
 * The design an idea became, if one in the idea's project is called what it is. A "Brand" in
 * another repository is another design.
 */
export function startedFrom<F extends { name: string; key: string; git?: { project?: string } }>(
  idea: Pick<Idea, "name" | "projectId">,
  files: readonly F[],
): F | undefined {
  return files.find((f) => f.git?.project === idea.projectId && startedAs(idea, f));
}

/**
 * Whether a design started from an idea has settled into Recent: no agent at work in it, and
 * made a while ago (or before this server started). Until then the idea's card shows it in place.
 */
export function settled(file: { busy?: string; created?: number }, now = Date.now()): boolean {
  return !file.busy && !(file.created && now - file.created < STARTED_FOR);
}
