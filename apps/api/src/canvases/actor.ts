import type { Actor, CommittedOp } from "@ponzu/core";
import type { CanvasDriverView, StoredOp, User } from "@ponzu/db";
import type { Person } from "@ponzu/runner/protocol";
import type { Actor as Caller } from "../auth/actor.ts";

/** The agent, as a canvas's ops and comments name it. A runner acts as it, on its one canvas. */
export const AGENT: Actor = { kind: "agent", id: "claude", name: "Claude" };

/**
 * Who the caller is in a canvas's history: a person by their user id, or the agent. While a
 * person's own agent drives the canvas (docs/cloud.md, "Driving a canvas"), its runner runs that
 * agent's calls, so what the runner commits is that agent's: "Claude Code", not Ponzu's Claude.
 */
export function actorOf(caller: Caller, driver: CanvasDriverView | null = null): Actor {
  if (caller.kind === "runner") {
    return driver ? { kind: "agent", id: `driver:${driver.client}`, name: driver.name } : AGENT;
  }
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
