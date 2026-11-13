import {
  appendThreadItem,
  type CanvasDriver,
  hasPendingEvents,
  releaseCanvasDriver,
  type User,
} from "@ponzu/db";
import type { Person } from "@ponzu/runner/protocol";
import { startWake, type WakeDeps } from "../sandboxes/wake.ts";
import { personFor } from "./actor.ts";

/*
 * A person's own agent driving a canvas in place of Ponzu's agent (docs/cloud.md, "Driving a
 * canvas"). Taking it is the MCP's (`take_canvas`); this is what every way of ending it shares:
 * the lease and the head's `driver` go in one statement, the thread says so, and the canvas wakes
 * again on Ponzu's agent when its feed holds work for it (the people who commented meanwhile).
 */

/** How a drive ended, as the thread says it. */
export type DriveEnd = "let_go" | "taken_back" | "lapsed" | "revoked";

/** The thread's notice of a drive beginning or ending. */
export interface DriverNotice {
  type: "driver";
  action: "took" | DriveEnd;
  /** The agent: "Claude Code". */
  agent: string;
  /** The app it ran in, when it said: "T3 Code". */
  host: string | null;
  /** Whose agent it is. */
  owner: Person | null;
  /** Who took it back, for `taken_back`. */
  by: Person | null;
}

/** Say in the thread that a drive began. */
export async function noteDriveTaken(
  deps: Pick<WakeDeps, "db">,
  { canvasId, driver, owner }: { canvasId: string; driver: CanvasDriver; owner: User },
): Promise<void> {
  const notice: DriverNotice = {
    type: "driver",
    action: "took",
    agent: driver.name,
    host: driver.host,
    owner: personFor(owner),
    by: null,
  };
  await appendThreadItem(deps.db, { canvasId, kind: "notice", payload: { ...notice } });
}

/**
 * End the canvas's drive. Answers the lease that ended, or null when there was none (or, with
 * `grantId`, none of that grant's; with `lapsed`, none that was over). Ponzu's agent wakes for
 * what is waiting in the feed.
 */
export async function endDrive(
  deps: WakeDeps,
  {
    canvasId,
    how,
    by = null,
    owner = null,
    grantId,
  }: {
    canvasId: string;
    how: DriveEnd;
    /** Who took it back. */
    by?: User | null;
    /** Whose agent it was, when known. */
    owner?: User | null;
    grantId?: string;
  },
): Promise<CanvasDriver | null> {
  const ended = await releaseCanvasDriver(deps.db, {
    canvasId,
    ...(grantId ? { grantId } : {}),
    lapsed: how === "lapsed",
  });
  if (!ended) return null;
  const notice: DriverNotice = {
    type: "driver",
    action: how,
    agent: ended.name,
    host: ended.host,
    owner: owner ? personFor(owner) : null,
    by: by ? personFor(by) : null,
  };
  await appendThreadItem(deps.db, { canvasId, kind: "notice", payload: { ...notice } });
  deps.log.info("canvas_drive_ended", { canvasId, how });
  // Back on Ponzu's agent: what people sent meanwhile goes to it, on a sandbox awake in tools
  // mode restarted in place. A canvas that owes nothing is left: its idle sandbox sleeps, and
  // its next message wakes it on Ponzu's agent.
  if (await hasPendingEvents(deps.db, canvasId)) {
    deps.background("wake", startWake(deps, canvasId, "drive_ended"));
  }
  return ended;
}
