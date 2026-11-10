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
}

export type Actor = UserActor | RunnerActor;
