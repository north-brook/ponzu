import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type AgentState,
  canvases,
  canvasRunners,
  repos,
  sandboxes,
  users,
  workspaces,
} from "../schema/index.ts";
import type { Canvas } from "./canvases.ts";
import { appendEvent } from "./events.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A canvas's runner (docs/cloud.md, "The runner protocol"): the lease that makes one process
 * the canvas's runner, when it was last heard from, and the state it reports.
 */

/** What a canvas's runner works with: the canvas, its repository, and the person behind it. */
export interface RunnerContext {
  canvas: Canvas;
  assetKey: string;
  /** Null for Scratch. */
  repo: { githubRepoId: number; fullName: string; defaultBranch: string } | null;
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
  /** The canvas's owner, whom commits are authored by. Null once they are deleted. */
  owner: { id: string; name: string | null; githubLogin: string; githubUserId: number } | null;
}

/** A canvas with what its runner works with, in one read. Null when there is no such canvas. */
export async function getRunnerContext(db: Db, canvasId: string): Promise<RunnerContext | null> {
  const { assetKey, ...canvas } = getTableColumns(canvases);
  const [row] = await run(
    db
      .select({
        canvas,
        assetKey,
        repoGithubId: repos.githubRepoId,
        repoFullName: repos.fullName,
        repoDefaultBranch: repos.defaultBranch,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
        ownerId: users.id,
        ownerName: users.name,
        ownerLogin: users.githubLogin,
        ownerGithubId: users.githubUserId,
      })
      .from(canvases)
      .innerJoin(workspaces, eq(workspaces.id, canvases.workspaceId))
      .leftJoin(repos, eq(repos.id, canvases.repoId))
      .leftJoin(users, eq(users.id, canvases.ownerId))
      .where(eq(canvases.id, canvasId)),
  );
  if (!row) return null;
  return {
    canvas: row.canvas,
    assetKey: row.assetKey,
    repo:
      row.repoGithubId === null || row.repoFullName === null || row.repoDefaultBranch === null
        ? null
        : {
            githubRepoId: row.repoGithubId,
            fullName: row.repoFullName,
            defaultBranch: row.repoDefaultBranch,
          },
    installationId: row.installationId,
    suspendedAt: row.suspendedAt,
    owner:
      row.ownerId === null || row.ownerLogin === null || row.ownerGithubId === null
        ? null
        : {
            id: row.ownerId,
            name: row.ownerName,
            githubLogin: row.ownerLogin,
            githubUserId: row.ownerGithubId,
          },
  };
}

/**
 * Make a new runner id the canvas's lease, replacing whichever was there: the runner that
 * started last is the one the API takes calls from. Answers the new id and the Claude session
 * the canvas's events went into, for the runner to resume.
 */
export async function takeRunnerLease(
  db: Db,
  {
    canvasId,
    now,
    client = null,
  }: {
    canvasId: string;
    now: Date;
    /** What the runner said it is (`canvas_runners.client`). */
    client?: string | null;
  },
): Promise<{ runnerId: string; claudeSessionId: string | null; saved: SavedPoint | null }> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const [lease] = await run(
    db
      .insert(canvasRunners)
      .values({ canvasId, runnerId: newId("rnr"), startedAt: at, heardAt: at, client })
      .onConflictDoUpdate({
        target: canvasRunners.canvasId,
        set: {
          runnerId: sql`excluded.runner_id`,
          startedAt: sql`excluded.started_at`,
          heardAt: sql`excluded.heard_at`,
          client: sql`excluded.client`,
        },
      })
      .returning({
        runnerId: canvasRunners.runnerId,
        claudeSessionId: canvasRunners.claudeSessionId,
        ...SAVED,
      }),
  );
  const { runnerId, claudeSessionId, ...saved } = lease!;
  return { runnerId, claudeSessionId, saved: savedPoint(saved) };
}

/**
 * A canvas's last checkpoint (docs/cloud.md, "Saving the sandbox"): the turn marker, which only
 * goes up, and what was saved with it.
 */
export interface SavedPoint {
  turn: number;
  at: Date;
  claudeSessionId: string | null;
  /** The work in progress pushed to `refs/ponzu/wip/<canvas>`, for a repo canvas. */
  wipCommit: string | null;
  /** The uploads that hold the session's transcript and a Scratch canvas's files. */
  sessionUploadId: string | null;
  workspaceUploadId: string | null;
}

const SAVED = {
  turn: canvasRunners.savedTurn,
  at: canvasRunners.savedAt,
  savedClaudeSessionId: canvasRunners.savedClaudeSessionId,
  wipCommit: canvasRunners.savedWipCommit,
  sessionUploadId: canvasRunners.sessionUploadId,
  workspaceUploadId: canvasRunners.workspaceUploadId,
};

type SavedRow = {
  turn: number | null;
  at: Date | null;
  savedClaudeSessionId: string | null;
  wipCommit: string | null;
  sessionUploadId: string | null;
  workspaceUploadId: string | null;
};

function savedPoint(row: SavedRow): SavedPoint | null {
  if (row.turn === null || row.at === null) return null;
  return {
    turn: row.turn,
    at: row.at,
    claudeSessionId: row.savedClaudeSessionId,
    wipCommit: row.wipCommit,
    sessionUploadId: row.sessionUploadId,
    workspaceUploadId: row.workspaceUploadId,
  };
}

/** The canvas's last checkpoint, or null when its runner has saved none. */
export async function getSavedPoint(db: Db, canvasId: string): Promise<SavedPoint | null> {
  const [row] = await run(
    db.select(SAVED).from(canvasRunners).where(eq(canvasRunners.canvasId, canvasId)),
  );
  return row ? savedPoint(row) : null;
}

/**
 * Record the runner's checkpoint, if it is newer than the one recorded: a turn marker only goes
 * up, so a late or repeated call never puts an older one back. Holds to the lease. Answers the
 * checkpoint recorded now, and the one it replaced (whose uploads the caller may delete), or
 * null when the lease is not this runner's.
 */
export async function recordCheckpoint(
  db: Db,
  point: Omit<SavedPoint, "at"> & {
    canvasId: string;
    runnerId: string;
    now: Date;
    /**
     * Keep the transcript (with its session id), or the work in progress (with its commit), that
     * the checkpoint replaced, in place of one this one does not carry.
     */
    keepSession?: boolean;
    keepWorkspace?: boolean;
    /**
     * The newest event (`events.seq`) the session held when the runner took the transcript's
     * archive. Recorded as `saved_through`, never above the newest event delivered by now, so a
     * runner cannot count as held what never went out. Absent: every event delivered by now.
     */
    heldThrough?: number | null;
  },
): Promise<{ saved: SavedPoint | null; replaced: SavedPoint | null } | null> {
  const keepSession = point.keepSession === true;
  const keepWorkspace = point.keepWorkspace === true;
  const heldThrough = point.heldThrough ?? null;
  const columns = (of: string) =>
    sql.raw(
      ["saved_turn as turn", "saved_at as at", "saved_claude_session_id as claude_session_id"]
        .concat(["saved_wip_commit as wip_commit", "session_upload_id", "workspace_upload_id"])
        .map((column) => `${of}.${column}`)
        .join(", "),
    );
  const cols = columns("canvas_runners");
  const result = await queryJson<{ before: SavedJson | null; moved: SavedJson | null }>(
    db,
    sql`
      with before as (
        select canvas_runners.canvas_id, ${cols} from canvas_runners
         where canvas_id = ${point.canvasId} and runner_id = ${point.runnerId}
           for update
      ),
      moved as (
        update canvas_runners
           set saved_turn = ${point.turn},
               saved_at = ${timeParam(point.now)}::timestamptz,
               saved_claude_session_id = case when ${keepSession}::boolean
                 then before.claude_session_id else ${point.claudeSessionId}::text end,
               saved_wip_commit = case when ${keepWorkspace}::boolean
                 then before.wip_commit else ${point.wipCommit}::text end,
               session_upload_id = case when ${keepSession}::boolean
                 then before.session_upload_id else ${point.sessionUploadId}::text end,
               workspace_upload_id = case when ${keepWorkspace}::boolean
                 then before.workspace_upload_id else ${point.workspaceUploadId}::text end,
               -- What it holds: what the runner said its session held as it took the archive,
               -- never above what had gone out by now; else, as a runner that does not say,
               -- every event that had gone into the session by now (it saves once a turn has
               -- settled).
               saved_through = (select case when ${heldThrough}::bigint is null
                                             or max(e.seq) is null then max(e.seq)
                                        else least(${heldThrough}::bigint, max(e.seq)) end
                                  from events e
                                 where e.canvas_id = before.canvas_id
                                   and e.delivered_at is not null)
          from before
         where canvas_runners.canvas_id = before.canvas_id
           and (before.turn is null or before.turn < ${point.turn})
        returning ${cols}
      )
      select json_build_object(
        'before', (select row_to_json(before) from before),
        'moved', (select row_to_json(moved) from moved)
      ) as result
    `,
  );
  if (!result?.before) return null;
  const was = fromJson(result.before);
  const now = result.moved ? fromJson(result.moved) : null;
  return now ? { saved: now, replaced: was } : { saved: was, replaced: null };
}

interface SavedJson {
  turn: number | null;
  at: string | null;
  claude_session_id: string | null;
  wip_commit: string | null;
  session_upload_id: string | null;
  workspace_upload_id: string | null;
}

function fromJson(row: SavedJson): SavedPoint | null {
  return savedPoint({
    turn: row.turn,
    at: row.at === null ? null : new Date(row.at),
    savedClaudeSessionId: row.claude_session_id,
    wipCommit: row.wip_commit,
    sessionUploadId: row.session_upload_id,
    workspaceUploadId: row.workspace_upload_id,
  });
}

/**
 * Create PR asked the canvas's runner to push what only its sandbox holds: the `push` event that
 * asks it, and the reason the last push failed forgotten, since this one is a new try. The
 * runner says how it went with its next state report.
 */
export async function askRunnerToPush(
  db: Db,
  { canvasId, userId }: { canvasId: string; userId: string },
): Promise<void> {
  await appendEvent(db, { canvasId, kind: "push", priority: "now", payload: {}, userId });
  await run(
    db.update(canvasRunners).set({ pushError: null }).where(eq(canvasRunners.canvasId, canvasId)),
  );
}

/**
 * The canvas's runner wrote something of a turn to the thread as of `now`: everything delivered
 * before it has had its answer begun (docs/cloud.md, "A turn that never came").
 */
export async function noteRunnerSaid(
  db: Db,
  { canvasId, now }: { canvasId: string; now: Date },
): Promise<void> {
  await run(
    db
      .update(canvasRunners)
      .set({
        saidAt: sql`greatest(${canvasRunners.saidAt}, ${timeParam(now)}::timestamptz)`,
      })
      .where(eq(canvasRunners.canvasId, canvasId)),
  );
}

/**
 * Whether the canvas's runner has shown it is alive since `since`: it reported its state or took
 * the lease, or claimed or acknowledged an event, by the API's clock. What a wake asks when the
 * runner's `/health` does not answer through its address: a runner that is calling the API is
 * up, whatever its address does.
 */
export async function runnerHeardSince(
  db: Db,
  { canvasId, since }: { canvasId: string; since: Date },
): Promise<boolean> {
  const after = sql`${timeParam(since)}::timestamptz`;
  const result = await queryJson<{ heard: boolean }>(
    db,
    sql`
      select json_build_object('heard',
        exists (select 1 from canvas_runners r where r.canvas_id = ${canvasId} and r.heard_at >= ${after})
        or exists (select 1 from events e join canvas_runners r on r.canvas_id = e.canvas_id
                    where e.canvas_id = ${canvasId} and e.claimed_by = r.runner_id
                      and (e.claimed_at >= ${after} or e.delivered_at >= ${after}))
      ) as result
    `,
  );
  return result?.heard ?? false;
}

export interface RunnerState {
  state: Extract<AgentState, "working" | "needs_you" | "idle">;
  status: string | null;
  artboards: string[];
  /** Stored for the next resume when not null. */
  claudeSessionId: string | null;
  /**
   * The canvas's branch in the sandbox against GitHub: commits GitHub lacks, and why the last
   * push of them failed. Undefined leaves what was said before; null clears it.
   */
  branch?: { unpushed: number; error: string | null } | null;
}

/** What a state report answers: the canvas's head. */
export interface StateAnswer {
  seq: number;
}

/**
 * Record what the canvas's runner says it is doing, as of `now`, and answer the canvas's head
 * `seq`. The canvas's row, which clients
 * watch, is written only when what it shows changed, so a heartbeat that says the same again
 * touches only `canvas_runners`. Null when there is no such canvas or it has no runner.
 */
export async function reportRunnerState(
  db: Db,
  { canvasId, now, branch, ...report }: RunnerState & { canvasId: string; now: Date },
): Promise<StateAnswer | null> {
  const heard = db.$with("heard").as(
    db
      .update(canvasRunners)
      .set({
        heardAt: sql`${timeParam(now)}::timestamptz`,
        claudeSessionId: sql`coalesce(${report.claudeSessionId}::text, ${canvasRunners.claudeSessionId})`,
        ...(branch !== undefined
          ? { unpushed: branch?.unpushed ?? 0, pushError: branch?.error ?? null }
          : {}),
      })
      .where(eq(canvasRunners.canvasId, canvasId))
      .returning({ canvasId: canvasRunners.canvasId }),
  );
  // A runner heard from is alive, so its restarts in a row are over; and while its agent works,
  // its sandbox stays awake.
  const working = report.state === "working";
  const kept = db.$with("kept").as(
    db
      .update(sandboxes)
      .set({
        restarts: 0,
        ...(working
          ? {
              lastActivityAt: sql`greatest(${sandboxes.lastActivityAt}, ${timeParam(now)}::timestamptz)`,
            }
          : {}),
      })
      .where(
        and(
          eq(sandboxes.canvasId, canvasId),
          eq(sandboxes.state, "awake"),
          sql`exists (select 1 from ${heard})`,
          working ? undefined : sql`${sandboxes.restarts} <> 0`,
        ),
      )
      .returning({ canvasId: sandboxes.canvasId }),
  );
  const artboards = sql`${sql.param(report.artboards, canvases.agentArtboards)}::text[]`;
  const shown = db.$with("shown").as(
    db
      .update(canvases)
      .set({ agentState: report.state, agentStatus: report.status, agentArtboards: artboards })
      .where(
        and(
          eq(canvases.id, canvasId),
          sql`exists (select 1 from ${heard})`,
          sql`(${canvases.agentState}, ${canvases.agentStatus}, ${canvases.agentArtboards})
                is distinct from (${report.state}::text, ${report.status}::text, ${artboards})`,
        ),
      )
      .returning({ id: canvases.id }),
  );
  const [row] = await run(
    db
      .with(heard, kept, shown)
      .select({ seq: canvases.seq })
      .from(canvases)
      .where(and(eq(canvases.id, canvasId), sql`exists (select 1 from ${heard})`)),
  );
  if (!row) return null;
  return { seq: row.seq };
}
