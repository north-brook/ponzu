/*
 * Every event the API captures, and what each carries: the one list, so a name cannot be
 * misspelt at a call site and docs/analytics.md has something to agree with ("Server events").
 *
 * Names are "object verb" in the past tense; properties are snake_case. An event about a
 * design carries `design_id`, never its name. Nothing here is a repo's contents, a file path,
 * a token, or anything a person typed: a message is its length, not its words.
 *
 * Who an event is about (the PostHog distinct id) and which workspace (the `workspace` group)
 * come from the request's scope, or from the call when there is no request (a webhook's job,
 * the cron). Every event also gets `$session_id` when the app sent its session with the request.
 */

/** How a design began, as the create says: the composer's idea, the person's own words, or Scratch. */
export type DesignSource = "idea" | "prompt" | "scratch";

/** How a turn ended. */
export type TurnOutcome = "completed" | "failed" | "stopped";

/** How a sandbox came up: made new, resumed from a snapshot with nothing in memory, or thawed. */
export type WakeStart = "new" | "cold" | "warm";

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
  "account deleted": { deleted_designs: number; kept_designs: number };

  // Workspaces: the GitHub App's installations
  /** The App was installed on an account Ponzu had no workspace for, or installed again. */
  "workspace connected": { workspace_id: string; kind: "organization" | "user"; repos: number };
  /** The App was uninstalled, or GitHub suspended it. */
  "workspace disconnected": { workspace_id: string; reason: "uninstalled" | "suspended" };
  /** GitHub said the repos the App can reach changed. `repos` is how many it reaches now. */
  "repo access changed": { workspace_id: string; repos: number };

  // Claude
  "claude connected": { kind: "api_key" | "subscription"; woke_designs: number };
  "claude disconnected": Record<string, never>;

  // Designs
  "design created": {
    design_id: string;
    source: DesignSource;
    /** Whether it began with a first message, which sets the agent going. */
    with_message: boolean;
    model: string | null;
    effort: string | null;
  };
  "design deleted": { design_id: string; by_owner: boolean };
  "design settled": { design_id: string };
  "design reopened": { design_id: string };

  // The thread
  "message sent": {
    design_id: string;
    /** The message the design began with, sent by its create. */
    first: boolean;
    characters: number;
    attachments: number;
  };
  /** A person's comment on the canvas, or a reply in one of its threads. */
  "comment posted": { design_id: string; reply: boolean };
  /** A person asked the agent to stop. */
  "turn stopped": { design_id: string };
  /**
   * The agent took up what was put in and began. Captured when the runner reports the turn,
   * with the time it began as the event's time.
   */
  "turn started": { design_id: string; turn_id: string };
  "turn finished": {
    design_id: string;
    /** The turn's id, which is also its trace's id in LLM analytics. */
    turn_id: string;
    outcome: TurnOutcome;
    /** Why it failed, as the thread says it (`claude_limit`, `turn_failed`), or null. */
    error_code: string | null;
    duration_ms: number | null;
    tool_calls: number | null;
    models: string[];
  } & ModelTokens;
  /**
   * The API gave up waiting for a turn it was owed (docs/cloud.md, "A turn that never came"): what
   * was delivered got nothing written after it. `sent_again`: a copy went into the feed.
   */
  "turn lapsed": {
    design_id: string;
    kinds: string[];
    sent_again: boolean;
    agent_state: string;
    waited_ms: number;
  };
  /** A runner said it was working and wrote nothing of the turn for an hour: started again. */
  "turn stalled": { design_id: string };
  "question asked": { design_id: string; question_id: string; kind: string };
  "question answered": { design_id: string; question_id: string; kind: string };

  // Pull requests
  "pull request created": { design_id: string; number: number };
  "pull request merged": { design_id: string; number: number };
  "pull request closed": { design_id: string; number: number };

  // Sandboxes
  "sandbox woke": { design_id: string; start: WakeStart; duration_ms: number };
  /** The sandbox was stopped to save its time. `quiesced`: its runner said it was ready. */
  "sandbox slept": { design_id: string; quiesced: boolean };
  /** The provider lost the sandbox (or its disk), and the next wake starts over. */
  "sandbox lost": { design_id: string };
  /** A runner found its disk behind the last checkpoint and restored from it. */
  "sandbox restored": { design_id: string; kind: "rollback" | "rebuilt" };

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
   * the reader for something other than a design (`unsafe`), or GitHub or a model failed.
   */
  "ideas skipped": {
    repo_id: string;
    reason: "rejected" | "unsafe" | "rate_limited" | "failed";
  };

  // Files and money
  /** A person's file reached a design (an image they pasted or dropped into the thread). */
  "file uploaded": { design_id: string; content_type: string; bytes: number };
  "monthly cap set": { cap_usd: number | null };
  "repo secret changed": { repo_id: string; action: "added" | "replaced" | "removed" };
}

export type ServerEvent = keyof ServerEvents;
