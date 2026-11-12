/*
 * Every event the API captures, and what each carries: the one list, so a name cannot be
 * misspelt at a call site and docs/analytics.md has something to agree with ("Server events").
 *
 * Names are "object verb" in the past tense; properties are snake_case. An event about a
 * canvas carries `canvas_id`, never its name. Nothing here is a repo's contents, a file path,
 * a token, or anything a person typed: a message is its length, not its words.
 *
 * Who an event is about (the PostHog distinct id) and which workspace (the `workspace` group)
 * come from the request's scope, or from the call when there is no request (a webhook's job,
 * the cron). Every event also gets `$session_id` when the app sent its session with the request.
 */

/** How a canvas began, as the create says: the composer's idea, the person's own words, or Scratch. */
export type CanvasOrigin = "idea" | "prompt" | "scratch";

/** How a turn ended. */
export type TurnOutcome = "completed" | "failed" | "stopped";

/**
 * How a sandbox came up: on a new disk (made, made again on a new image, or after its snapshot
 * expired), resumed from its snapshot, or its runner started again in a session that was running
 * (a changed Claude credential, or a session left running).
 */
export type WakeStart = "create" | "resume" | "restart";

/** Why a sandbox was put to sleep (`sandboxes/stop.ts`), or `expired` when Vercel stopped it. */
export type SleepWhy =
  | "idle"
  | "claude_unusable"
  | "claude_disconnected"
  | "owner_left"
  | "restart"
  | "failed"
  | "cycle"
  | "expired";

/** One model's share of a turn, as the runner reported it. */
export interface ModelTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface ServerEvents {
  // Accounts
  /** The first sign-in of a GitHub account: the person's row was made. */
  "user signed up": Record<string, never>;
  /** Every sign-in exchange that let someone in, the first included. */
  "user signed in": { new_user: boolean };
  "user signed out": Record<string, never>;
  "account deleted": { deleted_canvases: number; kept_canvases: number };

  // Workspaces: the GitHub App's installations
  /** The App was installed on an account Ponzu had no workspace for, or installed again. */
  "workspace connected": { workspace_id: string; kind: "organization" | "user"; repos: number };
  /** The App was uninstalled, or GitHub suspended it. */
  "workspace disconnected": { workspace_id: string; reason: "uninstalled" | "suspended" };
  /** GitHub said the repos the App can reach changed. `repos` is how many it reaches now. */
  "repo access changed": { workspace_id: string; repos: number };

  // Claude
  "claude connected": { kind: "api_key" | "subscription"; woke_canvases: number };
  "claude disconnected": Record<string, never>;

  // Canvases
  "canvas created": {
    canvas_id: string;
    source: CanvasOrigin;
    /** Whether it began with a first message, which sets the agent going. */
    with_message: boolean;
    model: string | null;
    effort: string | null;
  };
  "canvas deleted": { canvas_id: string; by_owner: boolean };
  "canvas settled": { canvas_id: string };
  "canvas reopened": { canvas_id: string };

  // The thread
  "message sent": {
    canvas_id: string;
    /** The message the canvas began with, sent by its create. */
    first: boolean;
    characters: number;
    attachments: number;
  };
  /** A person's comment on the canvas, or a reply in one of its threads. */
  "comment posted": { canvas_id: string; reply: boolean };
  /** A person asked the agent to stop. */
  "turn stopped": { canvas_id: string };
  /**
   * The agent took up what was put in and began. Captured when the runner reports the turn,
   * with the time it began as the event's time.
   */
  "turn started": { canvas_id: string; turn_id: string };
  "turn finished": {
    canvas_id: string;
    /** The turn's id, which is also its trace's id in LLM analytics. */
    turn_id: string;
    outcome: TurnOutcome;
    /** Why it failed, as the thread says it (`claude_limit`, `turn_failed`), or null. */
    error_code: string | null;
    duration_ms: number | null;
    tool_calls: number | null;
    models: string[];
    /** What the runner said it is (`runner/0.1.0+<bundle>`), and the bundle it ran, if it said. */
    runner: string | null;
    bundle: string | null;
  } & ModelTokens;
  /**
   * The API gave up waiting for a turn it was owed (docs/cloud.md, "A turn that never came"): what
   * was delivered got nothing written after it. `sent_again`: a copy went into the feed.
   */
  "turn lapsed": {
    canvas_id: string;
    kinds: string[];
    sent_again: boolean;
    agent_state: string;
    waited_ms: number;
  };
  /** A runner said it was working and wrote nothing of the turn for an hour: started again. */
  "turn stalled": { canvas_id: string };
  "question asked": { canvas_id: string; question_id: string; kind: string };
  "question answered": { canvas_id: string; question_id: string; kind: string };

  // Pull requests
  "pull request created": { canvas_id: string; number: number };
  "pull request merged": { canvas_id: string; number: number };
  "pull request closed": { canvas_id: string; number: number };

  // Sandboxes
  /**
   * A wake got the runner started: `duration_ms` from the wake's start, `fresh` when the disk
   * was empty (the runner rebuilds from git and the last checkpoint), `recreated` when the
   * sandbox was made again on a new image.
   */
  "sandbox woke": {
    canvas_id: string;
    start: WakeStart;
    duration_ms: number;
    fresh: boolean;
    recreated: boolean;
    image: string;
  };
  /** The sandbox was stopped, after its runner shut down, and `awake_ms` metered. */
  "sandbox slept": { canvas_id: string; why: SleepWhy; awake_ms: number };
  /** A runner found its disk behind the last checkpoint and restored from it. */
  "sandbox restored": { canvas_id: string; kind: "rollback" | "rebuilt" };

  // Ideas
  "ideas generated": {
    repo_id: string;
    count: number;
    duration_ms: number;
    attempts: number;
    input_tokens: number;
    output_tokens: number;
  };
  /**
   * No ideas were made this time: the workspace asked for too many this hour, nothing in the
   * model's answers passed the checks and the gate (`rejected`), the gate found an idea asking
   * the reader for something other than a canvas (`unsafe`), or GitHub or a model failed.
   */
  "ideas skipped": {
    repo_id: string;
    reason: "rejected" | "unsafe" | "rate_limited" | "failed";
  };

  // Files and money
  /** A person's file reached a canvas (an image they pasted or dropped into the thread). */
  "file uploaded": { canvas_id: string; content_type: string; bytes: number };
  "monthly cap set": { cap_usd: number | null };
  "repo secret changed": { repo_id: string; action: "added" | "replaced" | "removed" };
}

export type ServerEvent = keyof ServerEvents;
