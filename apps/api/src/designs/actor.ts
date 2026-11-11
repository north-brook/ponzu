import type { Actor, CommittedOp } from "@ponzu/core";
import type { StoredOp, User } from "@ponzu/db";
import type { Person } from "@ponzu/runner/protocol";
import type { Actor as Caller } from "../auth/actor.ts";

/** The agent, as a design's ops and comments name it. A runner acts as it, on its one design. */
export const AGENT: Actor = { kind: "agent", id: "claude", name: "Claude" };

/** Who the caller is in a design's history: a person by their user id, or the agent. */
export function actorOf(caller: Caller): Actor {
  if (caller.kind === "runner") return AGENT;
  const { user } = caller;
  return {
    kind: "user",
    id: user.id,
    name: user.name ?? user.githubLogin,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/** A person as the runner protocol names them: in events, and in the thread. */
export function personFor(user: Pick<User, "id" | "name" | "githubLogin">): Person {
  return { id: user.id, name: user.name ?? user.githubLogin, login: user.githubLogin };
}

/** An op from the log as clients receive it. */
export function toCommittedOp(stored: StoredOp): CommittedOp {
  return {
    seq: stored.seq,
    id: stored.id,
    op: stored.op,
    actor: stored.actor,
    at: stored.at.toISOString(),
  };
}
