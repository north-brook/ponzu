import type { User } from "@ponzu/db";

/** A signed-in person, from a WorkOS access token. */
export interface UserActor {
  kind: "user";
  user: User;
  /** The WorkOS session the token belongs to (its `sid`): what sign-out revokes. */
  sessionId: string;
}

/** The runner inside one design's sandbox, from a runner token. It may act on that design only. */
export interface RunnerActor {
  kind: "runner";
  tokenId: string;
  designId: string;
  /**
   * The design's lease, which this caller holds (`X-Ponzu-Runner`). Null only on the call that
   * takes it (`access.runnerStarting`).
   */
  runnerId: string | null;
}

/** A runner that holds its design's lease: every runner call but the one that takes it. */
export type LeasedRunner = RunnerActor & { runnerId: string };

export type Actor = UserActor | RunnerActor;
