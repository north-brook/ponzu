import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  type AgentState,
  designRunners,
  designs,
  repos,
  sandboxes,
  users,
  workspaces,
} from "../schema/index.ts";
import type { Design } from "./designs.ts";
import { queryJson, timeParam } from "./json.ts";
import { run } from "./run.ts";

/*
 * A design's runner (docs/cloud.md, "The runner protocol"): the lease that makes one process
 * the design's runner, when it was last heard from, and the state it reports.
 */

/** What a design's runner works with: the design, its repository, and the person behind it. */
export interface RunnerContext {
  design: Design;
  assetKey: string;
  /** Null for Scratch. */
  repo: { githubRepoId: number; fullName: string; defaultBranch: string } | null;
  /** The App's installation on the workspace; null while it is not installed. */
  installationId: number | null;
  /** Set while the App is suspended on the workspace. */
  suspendedAt: Date | null;
  /** The design's owner, whom commits are authored by. Null once they are deleted. */
  owner: { id: string; name: string | null; githubLogin: string; githubUserId: number } | null;
}

/** A design with what its runner works with, in one read. Null when there is no such design. */
export async function getRunnerContext(db: Db, designId: string): Promise<RunnerContext | null> {
  const { assetKey, ...design } = getTableColumns(designs);
  const [row] = await run(
    db
      .select({
        design,
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
      .from(designs)
      .innerJoin(workspaces, eq(workspaces.id, designs.workspaceId))
      .leftJoin(repos, eq(repos.id, designs.repoId))
      .leftJoin(users, eq(users.id, designs.ownerId))
      .where(eq(designs.id, designId)),
  );
  if (!row) return null;
  return {
    design: row.design,
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
 * Make a new runner id the design's lease, replacing whichever was there: the runner that
 * started last is the one the API takes calls from. Answers the new id and the Claude session
 * the design's events went into, for the runner to resume.
 */
export async function takeRunnerLease(
  db: Db,
  { designId, now }: { designId: string; now: Date },
): Promise<{ runnerId: string; claudeSessionId: string | null; saved: SavedPoint | null }> {
  const at = sql`${timeParam(now)}::timestamptz`;
  const [lease] = await run(
    db
      .insert(designRunners)
      .values({ designId, runnerId: newId("rnr"), startedAt: at, heardAt: at })
      .onConflictDoUpdate({
        target: designRunners.designId,
        set: {
          runnerId: sql`excluded.runner_id`,
          startedAt: sql`excluded.started_at`,
          heardAt: sql`excluded.heard_at`,
        },
      })
      .returning({
        runnerId: designRunners.runnerId,
        claudeSessionId: designRunners.claudeSessionId,
        ...SAVED,
      }),
  );
  const { runnerId, claudeSessionId, ...saved } = lease!;
  return { runnerId, claudeSessionId, saved: savedPoint(saved) };
}

/**
 * A design's last checkpoint (docs/cloud.md, "Saving the sandbox"): the turn marker, which only
 * goes up, and what was saved with it.
 */
export interface SavedPoint {
  turn: number;
  at: Date;
  claudeSessionId: string | null;
  /** The work in progress pushed to `refs/ponzu/wip/<design>`, for a repo design. */
  wipCommit: string | null;
  /** The uploads that hold the session's transcript and a Scratch design's files. */
  sessionUploadId: string | null;
  workspaceUploadId: string | null;
}

const SAVED = {
  turn: designRunners.savedTurn,
  at: designRunners.savedAt,
  savedClaudeSessionId: designRunners.savedClaudeSessionId,
  wipCommit: designRunners.savedWipCommit,
  sessionUploadId: designRunners.sessionUploadId,
  workspaceUploadId: designRunners.workspaceUploadId,
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

/** The design's last checkpoint, or null when its runner has saved none. */
export async function getSavedPoint(db: Db, designId: string): Promise<SavedPoint | null> {
  const [row] = await run(
    db.select(SAVED).from(designRunners).where(eq(designRunners.designId, designId)),
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
  point: Omit<SavedPoint, "at"> & { designId: string; runnerId: string; now: Date },
): Promise<{ saved: SavedPoint | null; replaced: SavedPoint | null } | null> {
  const columns = (of: string) =>
    sql.raw(
      ["saved_turn as turn", "saved_at as at", "saved_claude_session_id as claude_session_id"]
        .concat(["saved_wip_commit as wip_commit", "session_upload_id", "workspace_upload_id"])
        .map((column) => `${of}.${column}`)
        .join(", "),
    );
  const cols = columns("design_runners");
  const result = await queryJson<{ before: SavedJson | null; moved: SavedJson | null }>(
    db,
    sql`
      with before as (
        select design_runners.design_id, ${cols} from design_runners
         where design_id = ${point.designId} and runner_id = ${point.runnerId}
           for update
      ),
      moved as (
        update design_runners
           set saved_turn = ${point.turn},
               saved_at = ${timeParam(point.now)}::timestamptz,
               saved_claude_session_id = ${point.claudeSessionId},
               saved_wip_commit = ${point.wipCommit},
               session_upload_id = ${point.sessionUploadId},
               workspace_upload_id = ${point.workspaceUploadId}
          from before
         where design_runners.design_id = before.design_id
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
 * Count a rollback on the design's live sandbox: its runner found the disk behind the design's
 * last checkpoint. Answers the sandbox with its new count, or null when the design has none.
 */
export async function countSandboxRollback(
  db: Db,
  designId: string,
): Promise<{
  id: string;
  providerId: string | null;
  generation: number;
  rollbacks: number;
  state: string;
} | null> {
  const [row] = await run(
    db
      .update(sandboxes)
      .set({ rollbacks: sql`${sandboxes.rollbacks} + 1` })
      .where(and(eq(sandboxes.designId, designId), sql`${sandboxes.state} <> 'gone'`))
      .returning({
        id: sandboxes.id,
        providerId: sandboxes.providerId,
        generation: sandboxes.generation,
        rollbacks: sandboxes.rollbacks,
        state: sandboxes.state,
      }),
  );
  return row ?? null;
}

/** The sleep the design's runner last said it was ready for, or null. */
export async function getQuiescedFor(db: Db, designId: string): Promise<Date | null> {
  const [row] = await run(
    db
      .select({ quiescedFor: designRunners.quiescedFor })
      .from(designRunners)
      .where(eq(designRunners.designId, designId)),
  );
  return row?.quiescedFor ?? null;
}

export interface RunnerState {
  state: Extract<AgentState, "working" | "needs_you" | "idle">;
  status: string | null;
  artboards: string[];
  /** Stored for the next resume when not null. */
  claudeSessionId: string | null;
  /** The sleep the runner is ready for (a stop's `state_at`), when it says so. */
  quiesced?: Date | null;
}

/** What a state report answers: the design's head, and the sleep its sandbox is going into. */
export interface StateAnswer {
  seq: number;
  /** The `state_at` of the stop under way, while the design's sandbox is `stopping`. */
  sleep: Date | null;
}

/**
 * Record what the design's runner says it is doing, as of `now`, and answer the design's head
 * `seq` and the stop its sandbox is getting ready for, if any. The design's row, which clients
 * watch, is written only when what it shows changed, so a heartbeat that says the same again
 * touches only `design_runners`. Null when there is no such design or it has no runner.
 */
export async function reportRunnerState(
  db: Db,
  { designId, now, quiesced, ...report }: RunnerState & { designId: string; now: Date },
): Promise<StateAnswer | null> {
  const heard = db.$with("heard").as(
    db
      .update(designRunners)
      .set({
        heardAt: sql`${timeParam(now)}::timestamptz`,
        claudeSessionId: sql`coalesce(${report.claudeSessionId}::text, ${designRunners.claudeSessionId})`,
        ...(quiesced ? { quiescedFor: sql`${timeParam(quiesced)}::timestamptz` } : {}),
      })
      .where(eq(designRunners.designId, designId))
      .returning({ designId: designRunners.designId }),
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
          eq(sandboxes.designId, designId),
          eq(sandboxes.state, "awake"),
          sql`exists (select 1 from ${heard})`,
          working ? undefined : sql`${sandboxes.restarts} <> 0`,
        ),
      )
      .returning({ id: sandboxes.id }),
  );
  const artboards = sql`${sql.param(report.artboards, designs.agentArtboards)}::text[]`;
  const shown = db.$with("shown").as(
    db
      .update(designs)
      .set({ agentState: report.state, agentStatus: report.status, agentArtboards: artboards })
      .where(
        and(
          eq(designs.id, designId),
          sql`exists (select 1 from ${heard})`,
          sql`(${designs.agentState}, ${designs.agentStatus}, ${designs.agentArtboards})
                is distinct from (${report.state}::text, ${report.status}::text, ${artboards})`,
        ),
      )
      .returning({ id: designs.id }),
  );
  const [row] = await run(
    db
      .with(heard, kept, shown)
      .select({
        seq: designs.seq,
        sleep: sql<string | null>`(select ${sandboxes.stateAt} from ${sandboxes}
          where ${sandboxes.designId} = ${designId} and ${sandboxes.state} = 'stopping')`,
      })
      .from(designs)
      .where(and(eq(designs.id, designId), sql`exists (select 1 from ${heard})`)),
  );
  if (!row) return null;
  return { seq: row.seq, sleep: row.sleep === null ? null : new Date(row.sleep) };
}
