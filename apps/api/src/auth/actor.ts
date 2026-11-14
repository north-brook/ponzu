import type { User } from "@ponzu/db";

/** A signed-in person, from a WorkOS access token. */
export interface UserActor {
  kind: "user";
  user: User;
  /**
   * The WorkOS session the token belongs to (its `sid`): what sign-out revokes. For a person's
   * own agent, `agent:<grant id>`, which no sign-out names.
   */
  sessionId: string;
  /**
   * Set when it is the person's own agent asking, through Ponzu's MCP with a grant they allowed
   * (docs/cloud.md, "Your own agent"): it acts as them, and what it sends says it came through it.
   */
  agent?: AgentVia;
}

/** A person's own agent, as what it does on their behalf names it. */
export interface AgentVia {
  grantId: string;
  /** Its name as the person allowed it: "Claude Code". */
  name: string;
  /** What it said it is when it called (`clientInfo`), as in `claude-code/2.1.0`; null if nothing. */
  client: string | null;
}

/** The runner inside one canvas's sandbox, from a runner token. It may act on that canvas only. */
export interface RunnerActor {
  kind: "runner";
  tokenId: string;
  canvasId: string;
  /**
   * The canvas's lease, which this caller holds (`X-Ponzu-Runner`). Null only on the call that
   * takes it (`access.runnerStarting`).
   */
  runnerId: string | null;
}

/** A runner that holds its canvas's lease: every runner call but the one that takes it. */
export type LeasedRunner = RunnerActor & { runnerId: string };

export type Actor = UserActor | RunnerActor;
